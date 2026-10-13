//go:build android

package mesh

import (
	"net"

	"github.com/wlynxg/anet"
	"tailscale.com/net/netmon"
)

// Android 11+ denies apps the netlink dump behind net.Interfaces, which tsnet's
// network monitor, netcheck and magicsock depend on. tailscale-android registers
// a Java-backed getter; anet (already linked for NetBird's pion stack) reads the
// same data through the ioctl/route calls Android still allows.
func init() {
	netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
		ifs, err := anet.Interfaces()
		if err != nil {
			return nil, err
		}
		out := make([]netmon.Interface, 0, len(ifs))
		for i := range ifs {
			addrs, err := anet.InterfaceAddrsByInterface(&ifs[i])
			if err != nil || addrs == nil {
				addrs = []net.Addr{}
			}
			out = append(out, netmon.Interface{Interface: &ifs[i], AltAddrs: addrs})
		}
		return out, nil
	})
}
