package mesh

import (
	"context"
	"net"
	"net/http"
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
