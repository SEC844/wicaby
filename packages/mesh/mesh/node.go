// Package mesh puts the calling app on the user's Tailscale or NetBird network
// as a userspace node (no driver, no service, no admin rights) and gives it
// loopback forwarders to individual peers. It has no platform-specific code so
// the Windows helper and a gomobile binding can share it.
package mesh

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sync"
	"time"
)

type Peer struct {
	Name    string   `json:"name"`
	DNSName string   `json:"dnsName,omitempty"`
	IPs     []string `json:"ips"`
	Online  bool     `json:"online"`
	OS      string   `json:"os,omitempty"`
}

type Status struct {
	Type  string `json:"type"`  // always "status", so it can travel on a JSON-lines stream
	State string `json:"state"` // connecting | needs-login | connected | error
	// Sign-in page to open, or to show as a QR code on a device without a browser.
	AuthURL string `json:"authUrl,omitempty"`
	// NetBird device flow: the code the user confirms on that page.
	UserCode    string   `json:"userCode,omitempty"`
	SelfName    string   `json:"selfName,omitempty"`
	SelfDNSName string   `json:"selfDnsName,omitempty"`
	IPs         []string `json:"ips"`
	DNSSuffix   string   `json:"dnsSuffix,omitempty"`
	Error       string   `json:"error,omitempty"`
	Peers       []Peer   `json:"peers"`
	// Networks reachable through a peer (NetBird network routes), as CIDRs; never a default route.
	Routes []string `json:"routes,omitempty"`
}

type Config struct {
	Provider string // "tailscale" or "netbird"
	Dir      string // state directory; holds the node key
	Hostname string // this node's name in the mesh
	// Headscale / NetBird management URL; empty = the provider's hosted service.
	ControlURL string
	Verbose    bool
	Log        io.Writer       // diagnostics; defaults to stderr
	OnStatus   func(st Status) // called on every change
}

// provider is one overlay network implementation.
type provider interface {
	// run brings the node up and keeps reporting its status until ctx ends.
	run(ctx context.Context, authKey string)
	dial(ctx context.Context, network, addr string) (net.Conn, error)
	logout(ctx context.Context) error
	close()
}

var logw io.Writer = os.Stderr

func logf(format string, args ...any) { fmt.Fprintf(logw, format+"\n", args...) }

// hub holds the latest status and the peer view derived from it.
type hub struct {
	mu       sync.Mutex
	st       Status
	view     *meshView
	last     []byte
	onStatus func(Status)
}

func (h *hub) set(st Status) {
	st.Type = "status"
	if st.IPs == nil {
		st.IPs = []string{}
	}
	if st.Peers == nil {
		st.Peers = []Peer{}
	}
	b, _ := json.Marshal(st)
	h.mu.Lock()
	h.st = st
	h.view = newMeshView(st)
	changed := !bytes.Equal(b, h.last)
	h.last = b
	h.mu.Unlock()
	if changed && h.onStatus != nil {
		h.onStatus(st)
	}
}

func (h *hub) fail(err error) {
	st := h.status()
	st.State, st.Error = "error", err.Error()
	h.set(st)
}

func (h *hub) status() Status {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.st
}

func (h *hub) meshView() *meshView {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.view
}

type Node struct {
	hub     *hub
	p       provider
	fw      *forwarder
	srv     *http.Server
	ctx     context.Context
	cancel  context.CancelFunc
	started sync.Once
	done    chan struct{} // closed once run has returned (or will never start)
}

func New(cfg Config) (*Node, error) {
	if cfg.Dir == "" || cfg.Hostname == "" {
		return nil, fmt.Errorf("mesh: Dir and Hostname are required")
	}
	if cfg.Log != nil {
		logw = cfg.Log
	}
	if err := os.MkdirAll(cfg.Dir, 0o700); err != nil {
		return nil, err
	}
	h := &hub{st: Status{Type: "status", State: "connecting", IPs: []string{}, Peers: []Peer{}}, view: newMeshView(Status{}), onStatus: cfg.OnStatus}
	var p provider
	switch cfg.Provider {
	case "tailscale":
		p = newTailscale(cfg.Dir, cfg.Hostname, cfg.ControlURL, h, cfg.Verbose)
	case "netbird":
		p = newNetbird(cfg.Dir, cfg.Hostname, cfg.ControlURL, h, cfg.Verbose)
	default:
		return nil, fmt.Errorf("mesh: unknown provider %q", cfg.Provider)
	}
	fw, ln, err := newForwarder(p.dial, h.meshView)
	if err != nil {
		return nil, err
	}
	srv := &http.Server{Handler: fw, ReadHeaderTimeout: 30 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	ctx, cancel := context.WithCancel(context.Background())
	return &Node{hub: h, p: p, fw: fw, srv: srv, ctx: ctx, cancel: cancel, done: make(chan struct{})}, nil
}

// Start brings the node up in the background. authKey (Tailscale auth key or
// NetBird setup key) is optional; without it the status carries a sign-in URL.
func (n *Node) Start(authKey string) {
	n.started.Do(func() {
		go func() {
			defer close(n.done)
			n.p.run(n.ctx, authKey)
		}()
	})
}

func (n *Node) Status() Status { return n.hub.status() }

// Forward returns a loopback base URL (http://127.0.0.1:<port>/<token>) that
// relays to upstream (scheme://host[:port]), which must be a peer of the mesh.
func (n *Node) Forward(upstream string) (string, error) { return n.fw.open(upstream) }

func (n *Node) Logout(ctx context.Context) error { return n.p.logout(ctx) }

// Close stops the node. It waits for run to return first, so the provider is
// never closed while it is still starting (tsnet Start, a NetBird client that
// run would store after close had looked).
func (n *Node) Close() {
	n.cancel()
	n.started.Do(func() { close(n.done) }) // never started: nothing to wait for, and no later Start
	<-n.done
	_ = n.srv.Close()
	n.p.close()
}
