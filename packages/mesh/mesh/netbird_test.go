//go:build !wicaby_no_netbird

package mesh

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/netbirdio/netbird/client/iface/netstack"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
	"google.golang.org/grpc"
)

func TestRetryBacksOffThenConnects(t *testing.T) {
	m := &netbirdMesh{hub: &hub{}}
	var seen []string
	m.hub.onStatus = func(st Status) { seen = append(seen, st.State+":"+st.Error) }
	calls := 0
	ok := m.retry(context.Background(), time.Millisecond, func() error {
		if calls++; calls < 3 {
			return fmt.Errorf("management unreachable %d", calls)
		}
		return nil
	})
	if !ok || calls != 3 {
		t.Fatalf("ok=%v calls=%d, want true after 3 tries", ok, calls)
	}
	if len(seen) != 2 || seen[0] != "error:management unreachable 1" {
		t.Fatalf("each failure must be shown: %q", seen)
	}
}

func TestRetryStopsOnAuthError(t *testing.T) {
	for _, err := range []error{
		authErr{errors.New("sign-in refused: access_denied")},
		fmt.Errorf("login: %w", errors.New("rpc error: code = PermissionDenied desc = permission denied")),
	} {
		m := &netbirdMesh{hub: &hub{}}
		calls := 0
		if m.retry(context.Background(), time.Millisecond, func() error { calls++; return err }) || calls != 1 {
			t.Fatalf("%v: retried %d times, want 1", err, calls)
		}
		if st := m.hub.status(); st.State != "error" || st.Error != err.Error() {
			t.Fatalf("%v: status %+v, want the error shown", err, st)
		}
	}
}

func TestRouteList(t *testing.T) {
	got := routeList([]map[string]struct{}{
		{"192.168.50.0/24": {}, "0.0.0.0/0": {}, "*.example.com": {}},
		{"192.168.50.7/24": {}, "10.8.0.0/16": {}, "::/0": {}},
		nil,
	})
	want := "[10.8.0.0/16 192.168.50.0/24]"
	if fmt.Sprint(got) != want {
		t.Fatalf("routeList = %v, want %v (no exit node, no domain route, masked and merged)", got, want)
	}
}

func TestRetryStopsWithContext(t *testing.T) {
	m := &netbirdMesh{hub: &hub{}}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(20*time.Millisecond, cancel)
	start := time.Now()
	if m.retry(ctx, time.Hour, func() error { return errors.New("timeout") }) {
		t.Fatal("retry reported success")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("retry kept waiting after ctx ended")
	}
}

// The browser sign-in dials management before embed.New. On Android that dial failed in 0.9.0
// with only "create connection: dial context: context deadline exceeded": NetBird's dialer was
// not yet in userspace mode and asked for a VpnService socket protector. Only an Android run
// tells (GOOS=android CGO_ENABLED=1 CC=<NDK clang> go test -c -ldflags=-checklinkname=0
// ./mesh, then adb push and run it on an emulator); elsewhere the dialer has no protector.
func TestManagementDialBeforeEmbed(t *testing.T) {
	_ = os.Unsetenv(netstack.EnvUseNetstackMode)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := grpc.NewServer()
	go srv.Serve(ln)
	defer srv.Stop()
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	m := newNetbird(t.TempDir(), "test", "http://localhost:"+port, &hub{}, false)
	key, _ := wgtypes.GeneratePrivateKey()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	mc, err := m.managementClient(ctx, key)
	if err != nil {
		t.Fatalf("management dial before embed.New: %v", err)
	}
	_ = mc.Close()
}

func TestProbeManagementNamesThePhase(t *testing.T) {
	listen := func(serve func(net.Conn)) string {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { ln.Close() })
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				go serve(c)
			}
		}()
		return ln.Addr().String()
	}
	notTLS := listen(func(c net.Conn) { c.Write([]byte("HTTP/1.0 400 Bad Request\r\n\r\n")); c.Close() })
	silent := listen(func(c net.Conn) { time.Sleep(time.Second); c.Close() })
	// Nothing listens there any more: connection refused.
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	refused := ln.Addr().String()
	ln.Close()
	for url, want := range map[string]string{
		"https://wicaby-probe.invalid": "failed at dns lookup: ",
		"http://" + refused:            "failed at tcp connect to " + refused + " (ipv4): ",
		"https://" + notTLS:            "failed at tls handshake with " + notTLS + " (ipv4): ",
		"http://" + silent:             "failed at grpc: tcp connect to " + silent + " (ipv4) ok",
		"https://10.0.0.1:1":           "(ipv4, lan)",
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		got := probeManagement(ctx, url)
		cancel()
		if !strings.Contains(got, want) {
			t.Errorf("probe %s = %q, want %q in it", url, got, want)
		}
	}
}
