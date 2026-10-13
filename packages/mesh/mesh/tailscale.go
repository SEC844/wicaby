package mesh

import (
	"context"
	"net"
	"os"
	"sort"
	"strings"
	"time"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

type tailscaleMesh struct {
	srv *tsnet.Server
	hub *hub
}

func newTailscale(dir, hostname, controlURL string, h *hub, verbose bool) *tailscaleMesh {
	// A media client has no business uploading diagnostics to Tailscale's log servers.
	os.Setenv("TS_NO_LOGS_NO_SUPPORT", "true")
	srv := &tsnet.Server{
		Dir:        dir,
		Hostname:   hostname,
		ControlURL: controlURL,
		// The login URL also comes through status; this keeps a human-readable trace.
		UserLogf: logf,
		Logf:     func(string, ...any) {},
	}
	if verbose {
		srv.Logf = logf
	}
	return &tailscaleMesh{srv: srv, hub: h}
}

func (m *tailscaleMesh) run(ctx context.Context, authKey string) {
	// Ignored by tsnet once the node has state, as intended.
	m.srv.AuthKey = authKey
	if err := m.srv.Start(); err != nil {
		m.hub.fail(err)
		return
	}
	lc, err := m.srv.LocalClient()
	if err != nil {
		m.hub.fail(err)
		return
	}
	for {
		sctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		st, err := lc.Status(sctx)
		cancel()
		if err == nil {
			m.hub.set(fromTailscale(st))
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

func fromTailscale(st *ipnstate.Status) Status {
	out := Status{AuthURL: st.AuthURL}
	switch st.BackendState {
	case "Running":
		out.State = "connected"
	case "NeedsLogin":
		out.State = "needs-login"
	case "NeedsMachineAuth":
		out.State, out.Error = "needs-login", "waiting for approval by the tailnet admin"
	default:
		out.State = "connecting"
	}
	for _, ip := range st.TailscaleIPs {
		out.IPs = append(out.IPs, ip.String())
	}
	if st.Self != nil {
		out.SelfName = st.Self.HostName
		out.SelfDNSName = strings.TrimSuffix(st.Self.DNSName, ".")
	}
	if st.CurrentTailnet != nil {
		out.DNSSuffix = st.CurrentTailnet.MagicDNSSuffix
	}
	for _, p := range st.Peer {
		// Mullvad exit nodes show up as peers; they never host a media server.
		if strings.HasSuffix(strings.TrimSuffix(p.DNSName, "."), ".mullvad.ts.net") {
			continue
		}
		pp := Peer{Name: p.HostName, DNSName: strings.TrimSuffix(p.DNSName, "."), Online: p.Online, OS: p.OS}
		for _, ip := range p.TailscaleIPs {
			pp.IPs = append(pp.IPs, ip.String())
		}
		out.Peers = append(out.Peers, pp)
	}
	// Map order is random; a stable order keeps an unchanged status from being re-sent.
	sort.Slice(out.Peers, func(i, j int) bool { return out.Peers[i].DNSName < out.Peers[j].DNSName })
	return out
}

func (m *tailscaleMesh) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	return m.srv.Dial(ctx, network, addr)
}

func (m *tailscaleMesh) logout(ctx context.Context) error {
	lc, err := m.srv.LocalClient()
	if err != nil {
		return err
	}
	return lc.Logout(ctx)
}

func (m *tailscaleMesh) close() { _ = m.srv.Close() }
