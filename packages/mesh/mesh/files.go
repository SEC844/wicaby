package mesh

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// The file-source gateway (file-sources-spec §5.3, D7): a folder backend (an SMB share through go-smb2, files_smb.go)
// served on 127.0.0.1 only, one random 128-bit token per open share:
//
//	GET|HEAD /<token>/f/<rel>    the file, with Range (http.ServeContent)
//	GET      /<token>/ls/<rel>   [{name, dir, size, mtime}] (mtime in Unix seconds), at most 10,000 entries
//
// Other methods get 405, an unknown token 404, a path the guard refuses 400. A backend failure answers 502 with a
// body naming it ("auth: …", "notfound: …", "smb1: …", "offline: …") so the apps can say which. Android and the
// desktop helper only ever speak this loopback HTTP; credentials stay inside the backend.

// fileBackend is one open folder tree. rel is '/'-separated and already guarded ("" is the root).
type fileBackend interface {
	ReadDir(rel string) ([]fs.FileInfo, error)
	Open(rel string) (io.ReadSeekCloser, fs.FileInfo, error)
	Close() error
}

const (
	filesMaxList  = 10_000
	filesMaxReads = 8
	maxRelBytes   = 4096
)

var filesWriteIdle = time.Minute // var: tests shorten it

// idleWriter gives each write filesWriteIdle to go out: a client that stops reading without closing
// (a paused player) loses its connection and frees its read slot. Not a WriteTimeout: films stream for hours.
type idleWriter struct {
	http.ResponseWriter
	rc *http.ResponseController
}

func (w idleWriter) Write(p []byte) (int, error) {
	_ = w.rc.SetWriteDeadline(time.Now().Add(filesWriteIdle))
	return w.ResponseWriter.Write(p)
}

// FilesServer is the loopback listener every open share is served on.
type FilesServer struct {
	ln     net.Listener
	srv    *http.Server
	mu     sync.Mutex
	shares map[string]*fileShare
}

type fileShare struct {
	b     fileBackend
	reads chan struct{}
}

// NewFilesServer listens on 127.0.0.1 (never 0.0.0.0) on a free port.
func NewFilesServer() (*FilesServer, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &FilesServer{ln: ln, shares: map[string]*fileShare{}}
	s.srv = &http.Server{Handler: s, ReadHeaderTimeout: 30 * time.Second}
	go func() { _ = s.srv.Serve(ln) }()
	return s, nil
}

func (s *FilesServer) Addr() string { return s.ln.Addr().String() }

// Open serves b under a new token and returns its base URL, http://127.0.0.1:<port>/<token>.
func (s *FilesServer) Open(b fileBackend) string {
	tok := randomToken()
	s.mu.Lock()
	s.shares[tok] = &fileShare{b: b, reads: make(chan struct{}, filesMaxReads)}
	s.mu.Unlock()
	return "http://" + s.Addr() + "/" + tok
}

// CloseShare forgets the share behind base (an Open result) and closes its backend.
func (s *FilesServer) CloseShare(base string) {
	tok := base[strings.LastIndexByte(base, '/')+1:]
	s.mu.Lock()
	sh := s.shares[tok]
	delete(s.shares, tok)
	s.mu.Unlock()
	if sh != nil {
		_ = sh.b.Close()
	}
}

func (s *FilesServer) Close() {
	s.mu.Lock()
	all := s.shares
	s.shares = map[string]*fileShare{}
	s.mu.Unlock()
	for _, sh := range all {
		_ = sh.b.Close()
	}
	_ = s.srv.Close()
}

// share compares the token in constant time against every open one.
func (s *FilesServer) share(tok string) *fileShare {
	s.mu.Lock()
	defer s.mu.Unlock()
	var found *fileShare
	for k, sh := range s.shares {
		if subtle.ConstantTimeCompare([]byte(k), []byte(tok)) == 1 {
			found = sh
		}
	}
	return found
}

var (
	// Windows device names, alone or with an extension (shared/files/ids.ts, Ids.kt).
	deviceName = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$`)
	badChars   = regexp.MustCompile(`[\x00-\x1f\x7f\\:]`)
	encoded    = regexp.MustCompile(`(?i)%(2e|2f|5c|00)`)
)

// guardRel is the path guard of file-sources-spec §7.4, the same rule as the desktop and Android (vectors:
// tools/checks/fixtures/files/paths.json): '/'-separated; no empty, '.' or '..' segment; no '\', NUL, control
// character or ':'; no Windows device name or encoded dot, slash, backslash or NUL; NFC; valid UTF-8; at most 4,096
// bytes. "" is the root.
func guardRel(rel string) bool {
	if rel == "" {
		return true
	}
	if !utf8.ValidString(rel) || len(rel) > maxRelBytes || !norm.NFC.IsNormalString(rel) || badChars.MatchString(rel) {
		return false
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == "" || seg == "." || seg == ".." || deviceName.MatchString(seg) || encoded.MatchString(seg) {
			return false
		}
	}
	return true
}

// relOf decodes the escaped path after the route, segment by segment: an encoded '/' is refused, not split on.
func relOf(escaped string) (string, bool) {
	if escaped == "" {
		return "", true
	}
	segs := strings.Split(escaped, "/")
	for i, raw := range segs {
		seg, err := url.PathUnescape(raw)
		if err != nil || strings.Contains(seg, "/") {
			return "", false
		}
		segs[i] = seg
	}
	rel := strings.Join(segs, "/")
	return rel, guardRel(rel)
}

type lsEntry struct {
	Name  string `json:"name"`
	Dir   bool   `json:"dir"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

func (s *FilesServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	parts := strings.SplitN(strings.TrimPrefix(r.URL.EscapedPath(), "/"), "/", 3)
	if len(parts) < 2 {
		http.NotFound(w, r)
		return
	}
	sh := s.share(parts[0])
	if sh == nil {
		http.NotFound(w, r)
		return
	}
	route := parts[1]
	escaped := ""
	if len(parts) == 3 {
		escaped = strings.TrimSuffix(parts[2], "/")
	}
	if route != "f" && route != "ls" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && !(r.Method == http.MethodHead && route == "f") {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rel, ok := relOf(escaped)
	if !ok {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	// A full share waits for a slot (posters while a film plays) rather than failing the request.
	select {
	case sh.reads <- struct{}{}:
		defer func() { <-sh.reads }()
	case <-r.Context().Done():
		return
	}
	w = idleWriter{w, http.NewResponseController(w)}
	if route == "ls" {
		infos, err := sh.b.ReadDir(rel)
		if err != nil {
			backendError(w, err)
			return
		}
		out := make([]lsEntry, 0, min(len(infos), filesMaxList))
		for _, fi := range infos {
			if len(out) == filesMaxList {
				break
			}
			if fi.Name() == "." || fi.Name() == ".." {
				continue
			}
			out = append(out, lsEntry{Name: fi.Name(), Dir: fi.IsDir(), Size: fi.Size(), Mtime: fi.ModTime().Unix()})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
		return
	}
	if rel == "" {
		http.Error(w, "a folder", http.StatusBadRequest)
		return
	}
	f, fi, err := sh.b.Open(rel)
	if err != nil {
		backendError(w, err)
		return
	}
	defer f.Close()
	if fi.IsDir() {
		http.Error(w, "a folder", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
}

// The failure kinds the apps tell apart (FileError on Android).
var (
	errAuth     = errors.New("auth")
	errNotFound = errors.New("notfound")
	errSMB1     = errors.New("smb1")
	errOffline  = errors.New("offline")
)

func backendError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, errNotFound):
		http.Error(w, "notfound: "+err.Error(), http.StatusNotFound)
	case errors.Is(err, errAuth):
		http.Error(w, "auth: "+err.Error(), http.StatusBadGateway)
	case errors.Is(err, errSMB1):
		http.Error(w, "smb1: "+err.Error(), http.StatusBadGateway)
	default:
		http.Error(w, "offline: "+err.Error(), http.StatusBadGateway)
	}
}

// FilesDialer is how an SMB host is reached: the mesh node's userspace dialer when the host is one of its peers
// (a NAS on the tailnet works away from home), else the plain network. A host inside a routed network (NetBird
// network route) is often on the LAN itself (at home): it is dialled directly first, through the routing peer only
// when it does not answer within directFirst.
func (n *Node) FilesDialer(host string) func(ctx context.Context, network, addr string) (net.Conn, error) {
	if n == nil {
		return nil
	}
	v := n.hub.meshView()
	ip, ok := v.allowed(host)
	if !ok {
		return nil
	}
	viaMesh := func(ctx context.Context, network, addr string) (net.Conn, error) {
		_, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		return n.p.dial(ctx, network, net.JoinHostPort(ip, port))
	}
	if !v.routedOnly(host) {
		return viaMesh
	}
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		d := net.Dialer{Timeout: directFirst}
		if c, err := d.DialContext(ctx, network, addr); err == nil {
			return c, nil
		}
		return viaMesh(ctx, network, addr)
	}
}

// How long a routed-network host gets to answer directly, as the desktop app's routes.
const directFirst = 1500 * time.Millisecond
