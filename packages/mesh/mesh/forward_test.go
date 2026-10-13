package mesh

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func testStatus() Status {
	return Status{Peers: []Peer{
		{Name: "nas", DNSName: "nas.tail1234.ts.net", IPs: []string{"fd7a:115c:a1e0::7", "100.64.0.7"}, Online: true},
		{Name: "phone", DNSName: "phone.netbird.cloud.", IPs: []string{"100.77.1.2"}},
	}}
}

func TestAllowList(t *testing.T) {
	v := newMeshView(testStatus())
	cases := []struct {
		host, dial string
		ok         bool
	}{
		{"100.64.0.7", "100.64.0.7", true},
		{"[fd7a:115c:a1e0::7]", "fd7a:115c:a1e0::7", true},
		{"FD7A:115C:A1E0:0:0:0:0:7", "fd7a:115c:a1e0::7", true},
		{"nas.tail1234.ts.net", "100.64.0.7", true}, // by name, dialled on its IPv4
		{"NAS.tail1234.ts.net.", "100.64.0.7", true},
		{"phone.netbird.cloud", "100.77.1.2", true},
		{"100.64.0.8", "", false}, // same range, not a peer
		{"192.0.2.10", "", false}, // LAN host, not a peer
		{"127.0.0.1", "", false},  // loopback
		{"8.8.8.8", "", false},    // internet
		{"other.tail1234.ts.net", "", false},
		{"nas.tail1234.ts.net.attacker.com", "", false},
		{"nas", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		dial, ok := v.allowed(c.host)
		if ok != c.ok || (ok && dial != c.dial) {
			t.Errorf("allowed(%q) = %q, %v; want %q, %v", c.host, dial, ok, c.dial, c.ok)
		}
	}
}

// NetBird network routes: hosts of a routed network are allowed (dialled through the routing peer);
// a default route never opens everything.
func TestAllowListRoutes(t *testing.T) {
	st := testStatus()
	st.Routes = []string{"192.168.50.0/24", "fd00:1::/64", "0.0.0.0/0", "::/0", "not-a-cidr"}
	v := newMeshView(st)
	cases := []struct {
		host, dial string
		ok         bool
	}{
		{"192.168.50.26", "192.168.50.26", true},
		{"[fd00:1::26]", "fd00:1::26", true},
		{"::ffff:192.168.50.26", "192.168.50.26", true},
		{"100.64.0.7", "100.64.0.7", true}, // peers still
		{"192.168.1.26", "", false},
		{"8.8.8.8", "", false}, // the default routes were dropped
		{"127.0.0.1", "", false},
		{"nas.local", "", false}, // routed networks are matched by address only
	}
	for _, c := range cases {
		dial, ok := v.allowed(c.host)
		if ok != c.ok || (ok && dial != c.dial) {
			t.Errorf("allowed(%q) = %q, %v; want %q, %v", c.host, dial, ok, c.dial, c.ok)
		}
	}
}

func TestRewriteLocation(t *testing.T) {
	const origin, local = "http://100.64.0.7:8096", "http://127.0.0.1:5000/tok"
	cases := map[string]string{
		"http://100.64.0.7:8096/web/index.html": local + "/web/index.html",
		"HTTP://100.64.0.7:8096":                local,
		"/emby/web":                             local + "/emby/web",
		"http://100.64.0.7:80960/x":             "http://100.64.0.7:80960/x", // different port
		"https://example.com/x":                 "https://example.com/x",
		"//evil.example/x":                      "//evil.example/x",
		"relative/path":                         "relative/path",
	}
	for in, want := range cases {
		if got := rewriteLocation(in, origin, local); got != want {
			t.Errorf("rewriteLocation(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestForwarder(t *testing.T) {
	var seenHost, seenPath atomic.Value
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenHost.Store(r.Host)
		seenPath.Store(r.URL.RequestURI())
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "/emby/web", http.StatusFound)
			return
		}
		_, _ = io.WriteString(w, "ok")
	}))
	defer upstream.Close()

	st := testStatus()
	view := newMeshView(st)
	var dialed atomic.Value
	dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
		dialed.Store(addr)
		var d net.Dialer
		return d.DialContext(ctx, network, upstream.Listener.Addr().String())
	}
	f, ln, err := newForwarder(dial, func() *meshView { return view })
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: f}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	for _, bad := range []string{"http://192.0.2.10:8096", "http://100.64.0.8:8096", "file:///etc/passwd", "http://user:pw@100.64.0.7:8096", "nas.tail1234.ts.net:8096"} {
		if _, err := f.open(bad); err == nil {
			t.Errorf("open(%q) accepted", bad)
		}
	}
	base, err := f.open("http://nas.tail1234.ts.net:8096")
	if err != nil {
		t.Fatal(err)
	}
	if again, _ := f.open("http://NAS.tail1234.ts.net:8096"); again != base {
		t.Errorf("same upstream got a second forwarder: %s vs %s", again, base)
	}
	if !strings.HasPrefix(base, "http://127.0.0.1:") {
		t.Fatalf("base not on loopback: %s", base)
	}

	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	get := func(url string) *http.Response {
		t.Helper()
		res, err := client.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		return res
	}

	if res := get(base + "/emby/Items%2Fx?api=1"); res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if got := dialed.Load(); got != "100.64.0.7:8096" {
		t.Errorf("dialed %v, want the peer IP", got)
	}
	if got := seenHost.Load(); got != "nas.tail1234.ts.net:8096" {
		t.Errorf("upstream Host %v", got)
	}
	if got := seenPath.Load(); got != "/emby/Items%2Fx?api=1" {
		t.Errorf("upstream path %v", got)
	}
	if res := get(base + "/redirect"); res.Header.Get("Location") != base+"/emby/web" {
		t.Errorf("Location %q", res.Header.Get("Location"))
	}

	addr := strings.TrimPrefix(base, "http://")
	addr = addr[:strings.IndexByte(addr, '/')]
	if res := get("http://" + addr + "/0123456789abcdef0123456789abcdef/emby"); res.StatusCode != 404 {
		t.Errorf("unknown token: %d", res.StatusCode)
	}
	if res := get("http://" + addr + "/"); res.StatusCode != 404 {
		t.Errorf("no token: %d", res.StatusCode)
	}
	req, _ := http.NewRequest("GET", base+"/emby", nil)
	req.Host = "rebound.example:80"
	if res, err := client.Do(req); err != nil || res.StatusCode != 403 {
		t.Errorf("foreign Host header accepted: %v %v", res, err)
	}

	// A peer that leaves the mesh is no longer reachable through its open forwarder.
	view = newMeshView(Status{})
	if res := get(base + "/emby"); res.StatusCode != http.StatusBadGateway {
		t.Errorf("departed peer: %d", res.StatusCode)
	}
}
