// Package mobile is the gomobile face of package mesh (Android apps): only
// strings, ints, booleans, errors and callback interfaces cross the boundary.
//
//	packages/mesh/scripts/build-mesh-aar.ps1   (gomobile bind -javapkg com.wika.wicaby.mesh ./mobile)
package mobile

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"

	"wicaby/vpn-helper/mesh"
)

// StatusListener receives the status JSON (same shape as Status()) on every change.
// AuthURL in it is a plain string, so a TV can render it as a QR code.
type StatusListener interface {
	OnStatus(statusJSON string)
}

// Logger receives diagnostics one line at a time (stderr goes nowhere on Android).
// Sign-in links and device codes are redacted before they get here.
type Logger interface {
	Log(line string)
}

var (
	mu      sync.Mutex
	node    *mesh.Node
	logSink *lineWriter
	verbose bool
)

var secrets = regexp.MustCompile(`https?://\S+|user_code=\S+`)

const (
	lf = 10
	cr = "\r"
)

type lineWriter struct {
	mu  sync.Mutex
	buf []byte
	l   Logger
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf = append(w.buf, p...)
	for {
		i := bytes.IndexByte(w.buf, lf)
		if i < 0 {
			break
		}
		line := secrets.ReplaceAllString(string(bytes.TrimRight(w.buf[:i], cr)), "<url>")
		w.buf = w.buf[i+1:]
		if line != "" {
			w.l.Log(line)
		}
	}
	return len(p), nil
}

// SetLogger routes the node's diagnostics to l; verbose adds the provider's
// internals. Takes effect at the next Start.
func SetLogger(l Logger, verboseLogs bool) {
	mu.Lock()
	defer mu.Unlock()
	logSink, verbose = nil, verboseLogs
	if l != nil {
		logSink = &lineWriter{l: l}
	}
}

func logWriter() io.Writer {
	if logSink == nil {
		return nil
	}
	return logSink
}

// Start brings the node up. provider is "tailscale" or "netbird"; managementURL
// and authKey may be empty. stateDir holds the node key: keep it app-private.
func Start(provider, stateDir, hostname, managementURL, authKey string, listener StatusListener) error {
	mu.Lock()
	defer mu.Unlock()
	if node != nil {
		return errors.New("mesh already started")
	}
	// An app process has no /var/lib or $HOME: point tsnet's log state (logpolicy
	// panics when it finds nowhere to write) and Go's temp files into the
	// app-private state directory. Re-created on every start: the app may have
	// wiped the mesh directory (sign-out) since the last one.
	for env, sub := range map[string]string{"TS_LOGS_DIR": "logs", "TMPDIR": "tmp"} {
		d := filepath.Join(filepath.Dir(filepath.Clean(stateDir)), sub)
		if err := os.MkdirAll(d, 0o700); err == nil {
			_ = os.Setenv(env, d)
		}
	}
	n, err := mesh.New(mesh.Config{
		Provider: provider, Dir: stateDir, Hostname: hostname, ControlURL: managementURL,
		Verbose: verbose, Log: logWriter(),
		OnStatus: func(st mesh.Status) {
			if listener != nil {
				b, _ := json.Marshal(st)
				listener.OnStatus(string(b))
			}
		},
	})
	if err != nil {
		return err
	}
	node = n
	n.Start(authKey)
	return nil
}

func current() (*mesh.Node, error) {
	mu.Lock()
	defer mu.Unlock()
	if node == nil {
		return nil, errors.New("mesh not started")
	}
	return node, nil
}

func Status() string {
	n, err := current()
	if err != nil {
		return `{"type":"status","state":"stopped","ips":[],"peers":[]}`
	}
	b, _ := json.Marshal(n.Status())
	return string(b)
}

func Peers() string {
	n, err := current()
	if err != nil {
		return "[]"
	}
	b, _ := json.Marshal(n.Status().Peers)
	return string(b)
}

// Forward returns http://127.0.0.1:<port>/<token> relaying to upstream
// ("http(s)://host[:port]"), which must be a peer of the mesh.
func Forward(upstream string) (string, error) {
	n, err := current()
	if err != nil {
		return "", err
	}
	return n.Forward(upstream)
}

// OpenForwarder is Forward with the origin in parts.
func OpenForwarder(host string, port int, https bool) (string, error) {
	scheme := "http"
	if https {
		scheme = "https"
	}
	if port <= 0 || port > 65535 {
		return "", fmt.Errorf("invalid port %d", port)
	}
	return Forward(scheme + "://" + net.JoinHostPort(host, strconv.Itoa(port)))
}

func Logout() error {
	n, err := current()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return n.Logout(ctx)
}

func Stop() {
	mu.Lock()
	n := node
	node = nil
	mu.Unlock()
	if n != nil {
		n.Close()
	}
}

// File sources (file-sources-spec §5.3): the SMB gateway, independent of the mesh node (it works without Remote
// Access; a running node only lends its dialer when the host is one of its peers).
var (
	filesMu  sync.Mutex
	filesSrv *mesh.FilesServer
)

// OpenFiles mounts share on host (port 445 when port <= 0) and returns the base URL that serves it on 127.0.0.1:
// <base>/ls/<rel> lists a folder, <base>/f/<rel> serves a file with Range. The credentials cross once, here, and
// stay in the backend. An error starts with auth, notfound, smb1 or offline.
func OpenFiles(host string, port int, share, user, pass, domain string) (string, error) {
	if port <= 0 {
		port = 445
	}
	if port > 65535 || host == "" || share == "" {
		return "", fmt.Errorf("notfound: invalid share")
	}
	// The node is looked up on every dial: a mesh restarted (or started) after the share opened is used.
	dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
		n, _ := current()
		if d := n.FilesDialer(host); d != nil {
			return d(ctx, network, addr)
		}
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, addr)
	}
	b, err := mesh.NewSMBBackend(mesh.SMBConfig{Host: host, Port: port, Share: share, User: user, Pass: pass, Domain: domain, Dial: dial})
	if err != nil {
		return "", err
	}
	filesMu.Lock()
	defer filesMu.Unlock()
	if filesSrv == nil {
		s, err := mesh.NewFilesServer()
		if err != nil {
			_ = b.Close()
			return "", fmt.Errorf("offline: %w", err)
		}
		filesSrv = s
	}
	return filesSrv.Open(b), nil
}

// CloseFiles closes the share behind base (an OpenFiles result).
func CloseFiles(base string) {
	filesMu.Lock()
	s := filesSrv
	filesMu.Unlock()
	if s != nil {
		s.CloseShare(base)
	}
}
