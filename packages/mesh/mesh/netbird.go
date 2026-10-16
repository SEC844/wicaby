//go:build !wicaby_no_netbird

package mesh

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/netbirdio/netbird/client/embed"
	"github.com/netbirdio/netbird/client/iface/netstack"
	mgm "github.com/netbirdio/netbird/shared/management/client"
	"github.com/netbirdio/netbird/util/embeddedroots"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
	"google.golang.org/grpc/codes"
	gstatus "google.golang.org/grpc/status"
)

const netbirdDefaultManagement = "https://api.netbird.io:443"

type netbirdMesh struct {
	dir, hostname, management string
	hub                       *hub
	logOut                    io.Writer
	logLevel                  string

	mu     sync.Mutex
	client *embed.Client
}

func newNetbird(dir, hostname, management string, h *hub, verbose bool) *netbirdMesh {
	if management == "" {
		management = netbirdDefaultManagement
	}
	// embed.New sets this too, but the browser sign-in and logout dial management before it
	// runs. Without it NetBird's Android dialer wants a VpnService socket protector, which an
	// embedded node never has: every dial fails and gRPC only says "context deadline exceeded".
	_ = os.Setenv(netstack.EnvUseNetstackMode, "true")
	m := &netbirdMesh{dir: dir, hostname: hostname, management: management, hub: h, logOut: logw, logLevel: "error"}
	if verbose {
		m.logLevel = "info"
	}
	return m
}

func (m *netbirdMesh) configPath() string { return filepath.Join(m.dir, "config.json") }

// The peer key NetBird saved at first registration; it is our login from then on.
func (m *netbirdMesh) savedKey() string {
	b, err := os.ReadFile(m.configPath())
	if err != nil {
		return ""
	}
	var c struct{ PrivateKey string }
	_ = json.Unmarshal(b, &c)
	return c.PrivateKey
}

func (m *netbirdMesh) options() embed.Options {
	return embed.Options{
		DeviceName:    m.hostname,
		ManagementURL: m.management,
		ConfigPath:    m.configPath(),
		StatePath:     filepath.Join(m.dir, "state.json"),
		// Wicaby only dials out; nobody on the mesh needs to reach this PC.
		BlockInbound: true,
		LogOutput:    m.logOut,
		LogLevel:     m.logLevel,
	}
}

// needsLogin reports a refused peer key: expired SSO session or deleted peer. NetBird turns an expired
// login into InvalidArgument when it has neither a setup key nor a JWT to register again with.
func needsLogin(err error) bool {
	switch gstatus.Code(errors.Unwrap(err)) {
	case codes.PermissionDenied, codes.Unauthenticated, codes.NotFound, codes.InvalidArgument:
		return true
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "permission denied") || strings.Contains(s, "login") && strings.Contains(s, "expired")
}

// authErr marks a sign-in failure only the user can fix; it is not retried.
type authErr struct{ error }

func isAuthErr(err error) bool { return needsLogin(err) || errors.As(err, new(authErr)) }

func (m *netbirdMesh) run(ctx context.Context, setupKey string) {
	if !m.retry(ctx, time.Second, func() error { return m.connect(ctx, setupKey) }) {
		return
	}
	for {
		m.report()
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}
}

// retry calls try until it succeeds, ctx ends or it fails on sign-in. Every
// failure is shown at once; other errors (management unreachable, timeouts)
// are retried after a wait that doubles from first up to a minute.
func (m *netbirdMesh) retry(ctx context.Context, first time.Duration, try func() error) bool {
	for wait := first; ; wait = min(2*wait, time.Minute) {
		err := try()
		if err == nil {
			return true
		}
		if ctx.Err() != nil {
			return false
		}
		m.hub.fail(err)
		if isAuthErr(err) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(wait):
		}
	}
}

// connect starts the client with the setup key, else the saved peer key, else
// (or when that key is refused) a browser sign-in.
func (m *netbirdMesh) connect(ctx context.Context, setupKey string) error {
	opts := m.options()
	key := m.savedKey()
	switch {
	case setupKey != "":
		opts.SetupKey = setupKey
	case key != "":
		opts.PrivateKey = key
	}
	err := m.start(ctx, opts)
	if err != nil && opts.SetupKey == "" && (key == "" || needsLogin(err)) {
		var token string
		if token, err = m.deviceLogin(ctx); err == nil {
			opts = m.options()
			opts.JWTToken = token
			err = m.start(ctx, opts)
		}
	}
	// gRPC hides why a management dial failed; say which phase it was.
	if err != nil && ctx.Err() == nil && strings.Contains(err.Error(), "dial context") {
		err = fmt.Errorf("%w [%s]", err, probeManagement(ctx, m.management))
	}
	return err
}

// probeManagement retraces a management dial one phase at a time (dns lookup, tcp connect,
// tls handshake, grpc) and describes the first that fails, with the address family and
// whether the address is on the LAN (Android 17 blocks those without local network access).
func probeManagement(ctx context.Context, management string) string {
	u, err := url.Parse(management)
	if err != nil || u.Hostname() == "" {
		return "failed at url: invalid management URL"
	}
	port := u.Port()
	if port == "" {
		port = map[bool]string{true: "443", false: "80"}[u.Scheme == "https"]
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", u.Hostname())
	if err != nil {
		return "failed at dns lookup: " + err.Error()
	}
	var tcpErrs []string
	for _, ip := range ips {
		ip = ip.Unmap()
		where := net.JoinHostPort(ip.String(), port) + " (" + addrLabel(ip) + ")"
		c, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(ip.String(), port))
		if err != nil {
			tcpErrs = append(tcpErrs, where+": "+err.Error())
			continue
		}
		defer c.Close()
		if u.Scheme != "https" {
			return "failed at grpc: tcp connect to " + where + " ok, the management service did not answer"
		}
		// The roots NetBird's own dial uses (client/grpc CreateConnection).
		roots, err := x509.SystemCertPool()
		if err != nil || roots == nil {
			roots = embeddedroots.Get()
		}
		tc := tls.Client(c, &tls.Config{ServerName: u.Hostname(), RootCAs: roots, NextProtos: []string{"h2"}})
		if err := tc.HandshakeContext(ctx); err != nil {
			return "failed at tls handshake with " + where + ": " + err.Error()
		}
		if tc.ConnectionState().NegotiatedProtocol != "h2" {
			return "failed at grpc: " + where + " answers TLS without HTTP/2; a reverse proxy in front of management must pass gRPC"
		}
		return "failed at grpc: dns, tcp and tls to " + where + " ok, the management service did not answer"
	}
	if len(tcpErrs) == 0 {
		return "failed at dns lookup: no address"
	}
	return "failed at tcp connect to " + strings.Join(tcpErrs, "; ")
}

func addrLabel(ip netip.Addr) string {
	s := "ipv6"
	if ip.Is4() {
		s = "ipv4"
	}
	if ip.IsPrivate() || ip.IsLinkLocalUnicast() {
		s += ", lan"
	}
	return s
}

func (m *netbirdMesh) start(ctx context.Context, opts embed.Options) error {
	if opts.SetupKey == "" && opts.JWTToken == "" && opts.PrivateKey == "" {
		return errors.New("not registered")
	}
	m.hub.set(Status{State: "connecting"})
	c, err := embed.New(opts)
	if err != nil {
		return err
	}
	sctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	if err := c.Start(sctx); err != nil {
		return err
	}
	m.mu.Lock()
	m.client = c
	m.mu.Unlock()
	return nil
}

// routeList merges the networks the peers route for this node right now (NetBird network routes)
// into sorted CIDRs. Domain routes (no prefix) and default routes (exit nodes) are left out.
func routeList(sets []map[string]struct{}) []string {
	seen := map[string]bool{}
	var out []string
	for _, set := range sets {
		for r := range set {
			pr, err := netip.ParsePrefix(r)
			if err != nil || pr.Bits() == 0 || seen[pr.Masked().String()] {
				continue
			}
			seen[pr.Masked().String()] = true
			out = append(out, pr.Masked().String())
		}
	}
	sort.Strings(out)
	return out
}

func stripCIDR(s string) string {
	if i := strings.IndexByte(s, '/'); i >= 0 {
		return s[:i]
	}
	return s
}

func (m *netbirdMesh) report() {
	m.mu.Lock()
	c := m.client
	m.mu.Unlock()
	if c == nil {
		return
	}
	fs, err := c.Status()
	if err != nil {
		return
	}
	st := Status{State: "connected"}
	lp := fs.LocalPeerState
	for _, ip := range []string{lp.IP, lp.IPv6} {
		if ip != "" {
			st.IPs = append(st.IPs, stripCIDR(ip))
		}
	}
	st.SelfDNSName = strings.TrimSuffix(lp.FQDN, ".")
	st.SelfName, st.DNSSuffix, _ = strings.Cut(st.SelfDNSName, ".")
	if st.SelfName == "" {
		st.SelfName = m.hostname
	}
	if !fs.ManagementState.Connected && fs.ManagementState.Error != nil {
		st.Error = fs.ManagementState.Error.Error()
	}
	for _, p := range fs.Peers {
		fqdn := strings.TrimSuffix(p.FQDN, ".")
		name, _, _ := strings.Cut(fqdn, ".")
		pp := Peer{Name: name, DNSName: fqdn, Online: true}
		for _, ip := range []string{p.IP, p.IPv6} {
			if ip != "" {
				pp.IPs = append(pp.IPs, stripCIDR(ip))
			}
		}
		if pp.Name == "" && len(pp.IPs) > 0 {
			pp.Name = pp.IPs[0]
		}
		st.Peers = append(st.Peers, pp)
	}
	sort.Slice(st.Peers, func(i, j int) bool { return st.Peers[i].Name < st.Peers[j].Name })
	var routes []map[string]struct{}
	for _, p := range fs.Peers {
		if p.Mux != nil { // the copy of an offline peer may have none
			routes = append(routes, p.GetRoutes())
		}
	}
	st.Routes = routeList(routes)
	m.hub.set(st)
}

func (m *netbirdMesh) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	m.mu.Lock()
	c := m.client
	m.mu.Unlock()
	if c == nil {
		return nil, errors.New("not connected")
	}
	return c.DialContext(ctx, network, addr)
}

func (m *netbirdMesh) managementClient(ctx context.Context, key wgtypes.Key) (*mgm.GrpcClient, error) {
	u, err := url.Parse(m.management)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("invalid management URL %q", m.management)
	}
	host := u.Host
	if u.Port() == "" {
		host = net.JoinHostPort(u.Hostname(), map[bool]string{true: "443", false: "80"}[u.Scheme == "https"])
	}
	return mgm.NewClient(ctx, host, key, u.Scheme == "https")
}

// deviceLogin runs the OAuth device authorization flow (RFC 8628) that
// `netbird login` uses on headless machines, against the IdP the management
// server advertises, and returns the JWT to register with.
func (m *netbirdMesh) deviceLogin(ctx context.Context) (string, error) {
	// Any key works for this handshake; the peer key is created by embed.New.
	key, err := wgtypes.GeneratePrivateKey()
	if err != nil {
		return "", err
	}
	mc, err := m.managementClient(ctx, key)
	if err != nil {
		return "", err
	}
	flow, err := mc.GetDeviceAuthorizationFlow()
	_ = mc.Close()
	if err != nil {
		return "", authErr{fmt.Errorf("this NetBird server offers no browser sign-in (%v); use a setup key", err)}
	}
	pc := flow.GetProviderConfig()
	if pc == nil || pc.GetDeviceAuthEndpoint() == "" || pc.GetTokenEndpoint() == "" {
		return "", authErr{errors.New("this NetBird server offers no browser sign-in; use a setup key")}
	}
	var code struct {
		DeviceCode              string `json:"device_code"`
		UserCode                string `json:"user_code"`
		VerificationURI         string `json:"verification_uri"`
		VerificationURIComplete string `json:"verification_uri_complete"`
		Interval                int    `json:"interval"`
		ExpiresIn               int    `json:"expires_in"`
	}
	if err := postForm(ctx, pc.GetDeviceAuthEndpoint(), url.Values{"client_id": {pc.GetClientID()}, "audience": {pc.GetAudience()}, "scope": {pc.GetScope()}}, &code); err != nil {
		return "", err
	}
	link := code.VerificationURIComplete
	if link == "" {
		link = code.VerificationURI
	}
	m.hub.set(Status{State: "needs-login", AuthURL: link, UserCode: code.UserCode})
	interval := time.Duration(max(code.Interval, 5)) * time.Second
	deadline := time.Now().Add(time.Duration(max(code.ExpiresIn, 60)) * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(interval):
		}
		var tok struct {
			Error       string `json:"error"`
			Description string `json:"error_description"`
			AccessToken string `json:"access_token"`
			IDToken     string `json:"id_token"`
		}
		form := url.Values{"client_id": {pc.GetClientID()}, "grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "device_code": {code.DeviceCode}}
		if err := postForm(ctx, pc.GetTokenEndpoint(), form, &tok); err != nil {
			return "", err
		}
		switch tok.Error {
		case "":
			if pc.GetUseIDToken() {
				return tok.IDToken, nil
			}
			return tok.AccessToken, nil
		case "authorization_pending":
		case "slow_down":
			interval += 5 * time.Second
		default:
			return "", authErr{fmt.Errorf("sign-in refused: %s", strings.TrimSpace(tok.Error+" "+tok.Description))}
		}
	}
	return "", authErr{errors.New("sign-in timed out")}
}

func postForm(ctx context.Context, endpoint string, form url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 500 {
		return fmt.Errorf("%s: HTTP %d", endpoint, res.StatusCode)
	}
	return json.Unmarshal(body, out)
}

// logout deregisters this peer from the management server and forgets its key.
func (m *netbirdMesh) logout(ctx context.Context) error {
	m.mu.Lock()
	c := m.client
	m.client = nil
	m.mu.Unlock()
	if c != nil {
		_ = c.Stop(ctx)
	}
	var err error
	if s := m.savedKey(); s != "" {
		var key wgtypes.Key
		if key, err = wgtypes.ParseKey(s); err == nil {
			var mc *mgm.GrpcClient
			if mc, err = m.managementClient(ctx, key); err == nil {
				err = mc.Logout()
				_ = mc.Close()
			}
		}
	}
	_ = os.Remove(m.configPath())
	_ = os.Remove(filepath.Join(m.dir, "state.json"))
	m.hub.set(Status{State: "needs-login"})
	return err
}

func (m *netbirdMesh) close() {
	m.mu.Lock()
	c := m.client
	m.client = nil
	m.mu.Unlock()
	if c != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = c.Stop(ctx)
		cancel()
	}
}
