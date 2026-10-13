package mesh

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

// mapBackend serves an fstest.MapFS as a fileBackend; block, when set, holds every Open until it is closed.
type mapBackend struct {
	fsys   fstest.MapFS
	block  chan struct{}
	closed bool
}

func (m *mapBackend) path(rel string) string {
	if rel == "" {
		return "."
	}
	return rel
}

func (m *mapBackend) ReadDir(rel string) ([]fs.FileInfo, error) {
	entries, err := fs.ReadDir(m.fsys, m.path(rel))
	if err != nil {
		return nil, err
	}
	out := make([]fs.FileInfo, 0, len(entries))
	for _, e := range entries {
		fi, err := e.Info()
		if err != nil {
			return nil, err
		}
		out = append(out, fi)
	}
	return out, nil
}

func (m *mapBackend) Open(rel string) (io.ReadSeekCloser, fs.FileInfo, error) {
	if m.block != nil {
		<-m.block
	}
	f, err := m.fsys.Open(m.path(rel))
	if err != nil {
		return nil, nil, err
	}
	fi, _ := f.Stat()
	return f.(io.ReadSeekCloser), fi, nil
}

func (m *mapBackend) Close() error { m.closed = true; return nil }

var mtime = time.Date(2024, 10, 1, 10, 0, 0, 0, time.UTC)

func fixture() *mapBackend {
	return &mapBackend{fsys: fstest.MapFS{
		"Films/Example Movie (2019)/Example.Movie.2019.1080p.mkv": {Data: []byte("0123456789abcdefghij"), ModTime: mtime},
		"Films/Example Movie (2019)/poster.jpg":                   {Data: []byte("jpg"), ModTime: mtime},
		"Shows/Example Show/Season 1/Example.Show.S01E01.mkv":     {Data: []byte("episode"), ModTime: mtime},
		"Été/a b.mkv": {Data: []byte("x"), ModTime: mtime},
	}}
}

func serve(t *testing.T, b fileBackend) (*FilesServer, string) {
	t.Helper()
	s, err := NewFilesServer()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s, s.Open(b)
}

func get(t *testing.T, method, u string, header map[string]string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(method, u, nil)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res, string(body)
}

func esc(rel string) string {
	segs := strings.Split(rel, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.Join(segs, "/")
}

func TestFilesListAndRange(t *testing.T) {
	_, base := serve(t, fixture())
	res, body := get(t, "GET", base+"/ls/", nil)
	if res.StatusCode != 200 {
		t.Fatalf("ls root: %d %s", res.StatusCode, body)
	}
	var root []lsEntry
	_ = json.Unmarshal([]byte(body), &root)
	if len(root) != 3 || root[0].Name != "Films" || !root[0].Dir {
		t.Fatalf("ls root: %+v", root)
	}
	_, body = get(t, "GET", base+"/ls/"+esc("Films/Example Movie (2019)"), nil)
	var films []lsEntry
	_ = json.Unmarshal([]byte(body), &films)
	if len(films) != 2 || films[0].Size != 20 || films[0].Mtime != mtime.Unix() {
		t.Fatalf("ls films: %+v", films)
	}
	f := base + "/f/" + esc("Films/Example Movie (2019)/Example.Movie.2019.1080p.mkv")
	res, body = get(t, "GET", f, map[string]string{"Range": "bytes=10-13"})
	if res.StatusCode != 206 || body != "abcd" || res.Header.Get("Content-Range") != "bytes 10-13/20" {
		t.Fatalf("range: %d %q %s", res.StatusCode, body, res.Header.Get("Content-Range"))
	}
	res, body = get(t, "HEAD", f, nil)
	if res.StatusCode != 200 || body != "" || res.Header.Get("Content-Length") != "20" || res.Header.Get("Accept-Ranges") != "bytes" {
		t.Fatalf("head: %d %q %v", res.StatusCode, body, res.Header)
	}
	if res, _ = get(t, "GET", base+"/f/"+esc("Été/a b.mkv"), nil); res.StatusCode != 200 {
		t.Fatalf("non-ASCII path: %d", res.StatusCode)
	}
}

func TestFilesRefusals(t *testing.T) {
	s, base := serve(t, fixture())
	other := "http://" + s.Addr() + "/" + strings.Repeat("0", 32)
	for _, c := range []struct {
		method, u string
		want      int
	}{
		{"GET", other + "/ls/", 404},               // unknown token
		{"GET", base[:len(base)-1] + "0/ls/", 404}, // a token one character off
		{"POST", base + "/f/Films", 405},
		{"PUT", base + "/ls/", 405},
		{"HEAD", base + "/ls/", 405},
		{"GET", base + "/x/Films", 404},
		{"GET", base + "/f/Films%2F..%2F..%2Fetc", 400},
		{"GET", base + "/f/" + esc("Films/missing.mkv"), 404},
		{"GET", base + "/f/", 400},
	} {
		if res, body := get(t, c.method, c.u, nil); res.StatusCode != c.want {
			t.Errorf("%s %s: %d (want %d) %s", c.method, c.u, res.StatusCode, c.want, body)
		}
	}
}

// The shared path vectors (tools/checks/fixtures/files/paths.json): every hostile path is refused with 400, every
// valid one passes the guard.
func TestFilesPathVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "tools", "checks", "fixtures", "files", "paths.json"))
	if err != nil {
		t.Skip("paths.json not found:", err)
	}
	var v struct {
		Valid   []struct{ Rel string } `json:"valid"`
		Hostile []string               `json:"hostile"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Hostile) < 40 {
		t.Fatalf("only %d hostile paths", len(v.Hostile))
	}
	for _, p := range v.Valid {
		if !guardRel(p.Rel) {
			t.Errorf("guard refuses valid %q", p.Rel)
		}
	}
	_, base := serve(t, fixture())
	for _, h := range v.Hostile {
		// A lone surrogate cannot be written as UTF-8: JSON hands Go U+FFFD instead, and no request can carry one.
		if strings.ContainsRune(h, '�') {
			continue
		}
		if guardRel(h) {
			t.Errorf("guard accepts hostile %q", h)
			continue
		}
		// Each byte escaped: the server sees exactly the hostile name, whatever it holds.
		var b strings.Builder
		for i := 0; i < len(h); i++ {
			fmt.Fprintf(&b, "%%%02X", h[i])
		}
		if res, _ := get(t, "GET", base+"/f/"+b.String(), nil); res.StatusCode != 400 && !strings.Contains(h, "/") {
			t.Errorf("hostile %q: %d, want 400", h, res.StatusCode)
		}
	}
}

func TestFilesListensOnLoopbackOnly(t *testing.T) {
	s, _ := serve(t, fixture())
	host, _, _ := net.SplitHostPort(s.Addr())
	if host != "127.0.0.1" {
		t.Fatalf("listening on %s", host)
	}
}

func TestFilesCapsConcurrentReads(t *testing.T) {
	b := fixture()
	b.block = make(chan struct{})
	srv, base := serve(t, b)
	sh := srv.share(base[strings.LastIndexByte(base, '/')+1:])
	f := base + "/f/" + esc("Films/Example Movie (2019)/poster.jpg")
	var wg sync.WaitGroup
	codes := make(chan int, filesMaxReads)
	for i := 0; i < filesMaxReads; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, _ := get(t, "GET", f, nil)
			codes <- res.StatusCode
		}()
	}
	// Wait until the 8 reads hold their slots, then a 9th is turned away.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if len(sh.reads) == filesMaxReads || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if res, body := get(t, "GET", f, nil); res.StatusCode != 503 || !strings.HasPrefix(body, "busy") {
		t.Fatalf("9th read: %d %q", res.StatusCode, body)
	}
	close(b.block)
	wg.Wait()
	close(codes)
	for c := range codes {
		if c != 200 {
			t.Fatalf("a held read ended with %d", c)
		}
	}
}

func TestFilesCloseShare(t *testing.T) {
	b := fixture()
	s, base := serve(t, b)
	s.CloseShare(base)
	if !b.closed {
		t.Fatal("backend not closed")
	}
	if res, _ := get(t, "GET", base+"/ls/", nil); res.StatusCode != 404 {
		t.Fatalf("closed share still served: %d", res.StatusCode)
	}
}

func TestFilesBackendErrorsAreNamed(t *testing.T) {
	w := &recorder{h: http.Header{}}
	for _, c := range []struct {
		err  error
		code int
		pre  string
	}{
		{fmt.Errorf("%w: logon failure", errAuth), 502, "auth"},
		{fs.ErrNotExist, 404, "notfound"},
		{fmt.Errorf("%w: dialect", errSMB1), 502, "smb1"},
		{fmt.Errorf("%w: dial", errOffline), 502, "offline"},
	} {
		*w = recorder{h: http.Header{}}
		backendError(w, c.err)
		if w.code != c.code || !strings.HasPrefix(w.body.String(), c.pre) {
			t.Errorf("%v: %d %q", c.err, w.code, w.body.String())
		}
	}
}

type recorder struct {
	h    http.Header
	code int
	body strings.Builder
}

func (r *recorder) Header() http.Header         { return r.h }
func (r *recorder) Write(b []byte) (int, error) { return r.body.Write(b) }
func (r *recorder) WriteHeader(c int)           { r.code = c }

// An SMB server for the integration test must be a loopback one (a scratch impacket smbserver.py -smb2support on
// 127.0.0.1:1445, say): WICABY_SMB_TEST_ADDR=127.0.0.1:1445, WICABY_SMB_TEST_SHARE, _USER, _PASS. Anything else
// skips: no real share is ever contacted.
func TestFilesSMBIntegration(t *testing.T) {
	addr := os.Getenv("WICABY_SMB_TEST_ADDR")
	if addr == "" {
		t.Skip("SKIP: WICABY_SMB_TEST_ADDR not set")
	}
	host, port, err := net.SplitHostPort(addr)
	if ip := net.ParseIP(host); err != nil || ip == nil || !ip.IsLoopback() {
		t.Fatalf("WICABY_SMB_TEST_ADDR must be a loopback address, got %q", addr)
	}
	p := 0
	fmt.Sscanf(port, "%d", &p)
	share := os.Getenv("WICABY_SMB_TEST_SHARE")
	b, err := NewSMBBackend(SMBConfig{Host: host, Port: p, Share: share, User: os.Getenv("WICABY_SMB_TEST_USER"), Pass: os.Getenv("WICABY_SMB_TEST_PASS")})
	if err != nil {
		t.Fatal(err)
	}
	_, base := serve(t, b)
	res, body := get(t, "GET", base+"/ls/", nil)
	if res.StatusCode != 200 {
		t.Fatalf("ls: %d %s", res.StatusCode, body)
	}
	var root []lsEntry
	_ = json.Unmarshal([]byte(body), &root)
	t.Logf("share root: %d entries", len(root))
	for _, e := range root {
		if !e.Dir && e.Size > 4 {
			res, body = get(t, "GET", base+"/f/"+url.PathEscape(e.Name), map[string]string{"Range": "bytes=1-4"})
			if res.StatusCode != 206 || len(body) != 4 {
				t.Fatalf("range on %s: %d (%d bytes)", e.Name, res.StatusCode, len(body))
			}
			break
		}
	}
	if _, err := NewSMBBackend(SMBConfig{Host: host, Port: p, Share: share, User: os.Getenv("WICABY_SMB_TEST_USER"), Pass: "wrong-password"}); err == nil || !strings.HasPrefix(err.Error(), "auth") {
		t.Errorf("a wrong password: %v", err)
	}
	if _, err := NewSMBBackend(SMBConfig{Host: host, Port: p, Share: "no-such-share", User: os.Getenv("WICABY_SMB_TEST_USER"), Pass: os.Getenv("WICABY_SMB_TEST_PASS")}); err == nil || !strings.HasPrefix(err.Error(), "notfound") {
		t.Errorf("a missing share: %v", err)
	}
}

// §5.3 idle close: a file still being served (one open-ended Range GET for a whole film) keeps the SMB session;
// with nothing open, the idle timer drops it.
func TestFilesSMBIdleKeepsOpenReads(t *testing.T) {
	c1, c2 := net.Pipe()
	defer c2.Close()
	b := &smbBackend{conn: c1, timer: time.AfterFunc(time.Hour, func() {}), reads: 1}
	defer b.timer.Stop()
	b.idle()
	if b.conn == nil || c1.SetDeadline(time.Time{}) != nil {
		t.Fatal("idle closed the session under an open read")
	}
	b.reads = 0
	b.idle()
	if b.conn != nil || c1.SetDeadline(time.Time{}) == nil {
		t.Fatal("idle kept the session with nothing open")
	}
}
