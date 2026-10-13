//go:build !wicaby_no_netbird

package mesh

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
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
