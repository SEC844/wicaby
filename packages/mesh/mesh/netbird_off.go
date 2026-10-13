//go:build wicaby_no_netbird

package mesh

import (
	"context"
	"errors"
	"net"
)

// Tailscale-only builds (-tags wicaby_no_netbird) leave NetBird's client out:
// it is about 30 MB of the Android library per ABI.
var errNoNetbird = errors.New("NetBird is not included in this build")

type noNetbird struct{ hub *hub }

func newNetbird(_, _, _ string, h *hub, _ bool) provider { return noNetbird{h} }

func (m noNetbird) run(context.Context, string) { m.hub.fail(errNoNetbird) }

func (noNetbird) dial(context.Context, string, string) (net.Conn, error) { return nil, errNoNetbird }

func (noNetbird) logout(context.Context) error { return nil }

func (noNetbird) close() {}
