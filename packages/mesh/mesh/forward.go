package mesh

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"
)

var errNotInMesh = errors.New("destination is not a peer of this mesh")

// meshView is who is in the mesh right now. Forwarders may only reach these hosts,
// because the userspace dialers of both Tailscale and NetBird would otherwise send
// any other destination straight out through the host network.
type meshView struct {
	ips   map[string]bool   // peer addresses, canonical form
	names map[string]string // lower-case FQDN -> address to dial
	nets  []netip.Prefix    // routed networks: their hosts are dialled through the routing peer
}

func newMeshView(st Status) *meshView {
	v := &meshView{ips: map[string]bool{}, names: map[string]string{}}
	for _, r := range st.Routes {
		// A default route (exit node) would let everything through: never part of the view.
		if p, err := netip.ParsePrefix(r); err == nil && p.Bits() > 0 {
			v.nets = append(v.nets, p.Masked())
		}
	}
	for _, p := range st.Peers {
		var first string
		for _, s := range p.IPs {
			if ip, err := netip.ParseAddr(s); err == nil {
				v.ips[ip.Unmap().String()] = true
				if first == "" || (ip.Is4() && !strings.Contains(first, ".")) {
					first = ip.Unmap().String()
				}
			}
		}
		if first == "" {
			continue
		}
		if dns := strings.ToLower(strings.TrimSuffix(p.DNSName, ".")); dns != "" {
			v.names[dns] = first
		}
	}
	return v
}

// allowed returns the address to dial for host, and whether host is in the mesh.
// Peers are dialled by IP: NetBird's userspace stack has no DNS.
func (v *meshView) allowed(host string) (string, bool) {
	h := strings.TrimSuffix(strings.ToLower(strings.Trim(host, "[]")), ".")
	if ip, err := netip.ParseAddr(h); err == nil {
		c := ip.Unmap().String()
		if v.ips[c] {
			return c, true
		}
		for _, p := range v.nets {
			if p.Contains(ip.Unmap()) {
				return c, true
			}
		}
		return "", false
	}
	if ip, ok := v.names[h]; ok {
		return ip, true
	}
	return "", false
}

// routedOnly reports whether host is allowed only as an address inside a routed network, not as a peer.
func (v *meshView) routedOnly(host string) bool {
	ip, err := netip.ParseAddr(strings.TrimSuffix(strings.ToLower(strings.Trim(host, "[]")), "."))
	if err != nil || v.ips[ip.Unmap().String()] {
		return false
	}
	_, ok := v.allowed(host)
	return ok
}

// forwarder serves http://127.0.0.1:<port>/<token>/... and relays each token to the
// one upstream it was opened for. The random token keeps other local processes
// (and DNS-rebound web pages) from using it as a way into the mesh.
type forwarder struct {
	addr string
	dial func(ctx context.Context, network, addr string) (net.Conn, error)
	view func() *meshView

	mu       sync.Mutex
	routes   map[string]http.Handler // token -> proxy
	upstream map[string]string       // origin -> token
}

func newForwarder(dial func(ctx context.Context, network, addr string) (net.Conn, error), view func() *meshView) (*forwarder, net.Listener, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, nil, err
	}
	f := &forwarder{addr: ln.Addr().String(), dial: dial, view: view, routes: map[string]http.Handler{}, upstream: map[string]string{}}
	return f, ln, nil
}

func randomToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// open returns the local base URL that reaches upstream (scheme://host[:port]).
func (f *forwarder) open(upstream string) (string, error) {
	u, err := url.Parse(upstream)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
		return "", fmt.Errorf("invalid upstream %q", upstream)
	}
	if _, ok := f.view().allowed(u.Hostname()); !ok {
		return "", errNotInMesh
	}
	origin := u.Scheme + "://" + strings.ToLower(u.Host)
	f.mu.Lock()
	defer f.mu.Unlock()
	if tok, ok := f.upstream[origin]; ok {
		return f.base(tok), nil
	}
	tok := randomToken()
	f.routes[tok] = f.proxy(u, tok)
	f.upstream[origin] = tok
	return f.base(tok), nil
}

func (f *forwarder) base(tok string) string { return "http://" + f.addr + "/" + tok }

func (f *forwarder) proxy(u *url.URL, tok string) http.Handler {
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = map[string]string{"http": "80", "https": "443"}[u.Scheme]
	}
	target := &url.URL{Scheme: u.Scheme, Host: u.Host}
	origin := u.Scheme + "://" + u.Host
	transport := &http.Transport{
		Proxy: nil,
		// Whatever the request says, only this upstream, re-checked against the live peer list.
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			ip, ok := f.view().allowed(host)
			if !ok {
				return nil, errNotInMesh
			}
			return f.dial(ctx, "tcp", net.JoinHostPort(ip, port))
		},
		TLSHandshakeTimeout: 15 * time.Second,
		IdleConnTimeout:     90 * time.Second,
		MaxIdleConnsPerHost: 16,
	}
	local := f.base(tok)
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
		},
		Transport:     transport,
		FlushInterval: -1, // media streams and long polls
		ModifyResponse: func(res *http.Response) error {
			if loc := res.Header.Get("Location"); loc != "" {
				res.Header.Set("Location", rewriteLocation(loc, origin, local))
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			http.Error(w, "mesh: "+err.Error(), http.StatusBadGateway)
		},
	}
	// Per request too: pooled connections skip DialContext.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := f.view().allowed(host); !ok {
			http.Error(w, "mesh: "+errNotInMesh.Error(), http.StatusBadGateway)
			return
		}
		rp.ServeHTTP(w, r)
	})
}

// rewriteLocation keeps redirects on the forwarder.
func rewriteLocation(loc, origin, local string) string {
	if strings.HasPrefix(strings.ToLower(loc), strings.ToLower(origin)) {
		rest := loc[len(origin):]
		if rest == "" || rest[0] == '/' || rest[0] == '?' {
			return local + rest
		}
	}
	if strings.HasPrefix(loc, "/") && !strings.HasPrefix(loc, "//") {
		return local + loc
	}
	return loc
}

func (f *forwarder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Host != f.addr {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	tok, rest, _ := strings.Cut(strings.TrimPrefix(r.URL.EscapedPath(), "/"), "/")
	f.mu.Lock()
	h := f.routes[tok]
	f.mu.Unlock()
	if h == nil {
		http.NotFound(w, r)
		return
	}
	r.URL.RawPath = "/" + rest
	p, err := url.PathUnescape(r.URL.RawPath)
	if err != nil {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	r.URL.Path = p
	h.ServeHTTP(w, r)
}
