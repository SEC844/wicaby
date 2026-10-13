package mesh

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/hirochachacha/go-smb2"
)

// SMBConfig is one share. The password lives here only, and is cleared when the backend closes.
type SMBConfig struct {
	Host, Share, User, Pass, Domain string
	Port                            int
	// Dial reaches the host; nil is the plain network (net.Dialer).
	Dial func(ctx context.Context, network, addr string) (net.Conn, error)
}

const smbIdle = 10 * time.Minute

// smbBackend is a go-smb2 session on one share, dialled on first use and closed after smbIdle with no request
// and no file open (the next request dials again). A file still being served (one open-ended Range GET for a
// whole film) keeps the session alive.
type smbBackend struct {
	mu     sync.Mutex
	cfg    SMBConfig
	conn   net.Conn
	sess   *smb2.Session
	share  *smb2.Share
	timer  *time.Timer
	reads  int // files handed out by Open and not closed yet
	closed bool
}

// NewSMBBackend checks the share once (dial, logon, mount) so a wrong password or a missing share is told at once.
func NewSMBBackend(cfg SMBConfig) (fileBackend, error) {
	if cfg.Port == 0 {
		cfg.Port = 445
	}
	b := &smbBackend{cfg: cfg}
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, err := b.mount(); err != nil {
		b.cfg.Pass = ""
		return nil, err
	}
	return b, nil
}

func (b *smbBackend) mount() (*smb2.Share, error) {
	if b.closed {
		return nil, fs.ErrClosed
	}
	if b.timer != nil {
		b.timer.Reset(smbIdle)
	} else {
		b.timer = time.AfterFunc(smbIdle, b.idle)
	}
	if b.share != nil {
		return b.share, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	dial := b.cfg.Dial
	if dial == nil {
		dial = (&net.Dialer{Timeout: 5 * time.Second}).DialContext
	}
	conn, err := dial(ctx, "tcp", net.JoinHostPort(b.cfg.Host, strconv.Itoa(b.cfg.Port)))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errOffline, err)
	}
	d := &smb2.Dialer{Initiator: &smb2.NTLMInitiator{User: b.cfg.User, Password: b.cfg.Pass, Domain: b.cfg.Domain}}
	sess, err := d.DialContext(ctx, conn)
	if err != nil {
		_ = conn.Close()
		return nil, smbError(err)
	}
	sh, err := sess.Mount(b.cfg.Share)
	if err != nil {
		_ = sess.Logoff()
		_ = conn.Close()
		return nil, smbError(err)
	}
	b.conn, b.sess, b.share = conn, sess, sh
	return sh, nil
}

func (b *smbBackend) drop() {
	if b.share != nil {
		_ = b.share.Umount()
	}
	if b.sess != nil {
		_ = b.sess.Logoff()
	}
	if b.conn != nil {
		_ = b.conn.Close()
	}
	b.conn, b.sess, b.share = nil, nil, nil
}

func (b *smbBackend) idle() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.reads > 0 {
		b.timer.Reset(smbIdle)
		return
	}
	b.drop()
}

// smbFile counts as an in-flight read until closed; the idle clock restarts when the last one closes.
type smbFile struct {
	*smb2.File
	b    *smbBackend
	once sync.Once
}

func (f *smbFile) Close() error {
	err := f.File.Close()
	f.once.Do(func() {
		f.b.mu.Lock()
		defer f.b.mu.Unlock()
		if f.b.reads--; f.b.reads == 0 && f.b.timer != nil && !f.b.closed {
			f.b.timer.Reset(smbIdle)
		}
	})
	return err
}

// with runs fn on the mounted share; a broken session is dropped and dialled again once.
func (b *smbBackend) with(fn func(*smb2.Share) error) error {
	b.mu.Lock()
	sh, err := b.mount()
	b.mu.Unlock()
	if err != nil {
		return err
	}
	if err = fn(sh); err == nil || !isTransport(err) {
		return smbError(err)
	}
	b.mu.Lock()
	b.drop()
	sh, err = b.mount()
	b.mu.Unlock()
	if err != nil {
		return err
	}
	return smbError(fn(sh))
}

func (b *smbBackend) ReadDir(rel string) (out []fs.FileInfo, err error) {
	err = b.with(func(sh *smb2.Share) error {
		out, err = sh.ReadDir(rel)
		return err
	})
	return out, err
}

func (b *smbBackend) Open(rel string) (f io.ReadSeekCloser, fi fs.FileInfo, err error) {
	err = b.with(func(sh *smb2.Share) error {
		file, err := sh.Open(rel)
		if err != nil {
			return err
		}
		st, err := file.Stat()
		if err != nil {
			_ = file.Close()
			return err
		}
		b.mu.Lock()
		b.reads++
		b.mu.Unlock()
		f, fi = &smbFile{File: file, b: b}, st
		return nil
	})
	return f, fi, err
}

func (b *smbBackend) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	if b.timer != nil {
		b.timer.Stop()
	}
	b.drop()
	b.cfg.Pass = "" // as far as Go allows: the string itself is immutable
	return nil
}

func isTransport(err error) bool {
	var te *smb2.TransportError
	var ne net.Error
	return errors.As(err, &te) || errors.As(err, &ne) || errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed)
}

// NTSTATUS codes the apps tell apart.
const (
	statusLogonFailure      = 0xC000006D
	statusAccessDenied      = 0xC0000022
	statusAccountRestricted = 0xC000006E
	statusPasswordExpired   = 0xC0000071
	statusBadNetworkName    = 0xC00000CC
	statusNameNotFound      = 0xC0000034
	statusPathNotFound      = 0xC000003A
	statusNotSupported      = 0xC00000BB
)

// smbError names a go-smb2 failure with the kinds of files.go (auth, notfound, smb1, offline).
func smbError(err error) error {
	if err == nil {
		return nil
	}
	var re *smb2.ResponseError
	if errors.As(err, &re) {
		switch re.Code {
		case statusLogonFailure, statusAccessDenied, statusAccountRestricted, statusPasswordExpired:
			return fmt.Errorf("%w: %v", errAuth, err)
		case statusBadNetworkName, statusNameNotFound, statusPathNotFound:
			return fmt.Errorf("%w: %v", errNotFound, err)
		case statusNotSupported:
			return fmt.Errorf("%w: %v", errSMB1, err)
		}
		return err
	}
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%w: %v", errNotFound, err)
	}
	// A server that only speaks SMB1 answers the SMB2 negotiate with something go-smb2 cannot read.
	var inv *smb2.InvalidResponseError
	if errors.As(err, &inv) && strings.Contains(strings.ToLower(err.Error()), "protocol") {
		return fmt.Errorf("%w: %v", errSMB1, err)
	}
	if isTransport(err) {
		return fmt.Errorf("%w: %v", errOffline, err)
	}
	return err
}
