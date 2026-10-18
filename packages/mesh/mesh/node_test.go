package mesh

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// slowStop is a provider whose run outlives ctx a little, like tsnet Start or a
// NetBird client still starting.
type slowStop struct{ running, closedEarly atomic.Bool }

func (p *slowStop) run(ctx context.Context, _ string) {
	p.running.Store(true)
	<-ctx.Done()
	time.Sleep(50 * time.Millisecond)
	p.running.Store(false)
}
func (p *slowStop) dial(context.Context, string, string) (net.Conn, error) { return nil, nil }
func (p *slowStop) logout(context.Context) error                           { return nil }
func (p *slowStop) close()                                                 { p.closedEarly.Store(p.running.Load()) }

func testNode(p provider) *Node {
	ctx, cancel := context.WithCancel(context.Background())
	return &Node{hub: &hub{}, p: p, srv: &http.Server{}, ctx: ctx, cancel: cancel, done: make(chan struct{})}
}

func TestCloseWaitsForRun(t *testing.T) {
	p := &slowStop{}
	n := testNode(p)
	n.Start("")
	for !p.running.Load() {
		time.Sleep(time.Millisecond)
	}
	n.Close()
	if p.closedEarly.Load() {
		t.Fatal("provider closed while run was still going")
	}
}

func TestCloseWithoutStart(t *testing.T) {
	p := &slowStop{}
	n := testNode(p)
	done := make(chan struct{})
	go func() { n.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close blocked on a node that never started")
	}
	n.Start("") // after Close: must not run
	time.Sleep(10 * time.Millisecond)
	if p.running.Load() {
		t.Fatal("Start after Close ran the provider")
	}
}

// meshDialer records the addresses the mesh was asked to dial.
type meshDialer struct {
	slowStop
	dialled []string
	fail    bool
}

func (p *meshDialer) dial(_ context.Context, _, addr string) (net.Conn, error) {
	p.dialled = append(p.dialled, addr)
	if p.fail {
		return nil, errors.New("no route")
	}
	c, _ := net.Pipe()
	return c, nil
}

// SMB to a host in a NetBird routed network: always through the routing peer, never dialled directly, even when the
// mesh cannot reach it (no NTLM logon to whoever has that address on a foreign Wi-Fi). A peer is always dialled
// through the mesh; any other host gets no mesh dialer at all.
func TestFilesDialerMeshOnlyForRoutes(t *testing.T) {
	p := &meshDialer{}
	n := testNode(p)
	st := testStatus()
	st.Routes = []string{"127.0.0.0/8"}
	n.hub.set(st)

	open, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer open.Close()

	d := n.FilesDialer("127.0.0.1")
	c, err := d(context.Background(), "tcp", open.Addr().String())
	if err != nil || len(p.dialled) != 1 || p.dialled[0] != open.Addr().String() {
		t.Fatalf("via mesh: err %v, mesh dials %v", err, p.dialled)
	}
	c.Close()
	// The host answers directly, but a routed host must never be dialled outside the mesh (NTLM on a foreign Wi-Fi).
	p.fail = true
	if c, err = d(context.Background(), "tcp", open.Addr().String()); err == nil {
		c.Close()
		t.Fatal("mesh failing: fell back to a direct dial")
	} else if !strings.Contains(err.Error(), "routing peer") {
		t.Fatalf("routed dial error lacks the routing-peer hint: %v", err)
	}
	p.fail = false
	p.dialled = nil

	if c, err = n.FilesDialer("100.64.0.7")(context.Background(), "tcp", "100.64.0.7:445"); err != nil || p.dialled[0] != "100.64.0.7:445" {
		t.Fatalf("peer: err %v, mesh dials %v", err, p.dialled)
	}
	c.Close()
	if n.FilesDialer("192.0.2.15") != nil {
		t.Fatal("a host outside the mesh got a mesh dialer")
	}
}
