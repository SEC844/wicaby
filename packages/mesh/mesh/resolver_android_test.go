//go:build android

package mesh

import (
	"context"
	"net"
	"os"
	"testing"
	"time"
)

// Which resolver the Android library uses (run on an emulator, like TestManagementDialBeforeEmbed).
// gomobile builds with cgo and Go prefers the cgo resolver on Android: bionic's getaddrinfo, which
// asks netd, so per-network DNS and Private DNS apply. The pure Go resolver finds no
// /etc/resolv.conf there and asks [::1]:53, which fails; it must not be the one in use.
func TestAndroidResolverIsBionic(t *testing.T) {
	const name = "dns.google" // only DNS knows it: not in /system/etc/hosts
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if _, err := os.Stat("/etc/resolv.conf"); err == nil {
		t.Log("/etc/resolv.conf exists here")
	}
	addrs, err := net.DefaultResolver.LookupHost(ctx, name)
	if err != nil {
		t.Fatalf("default resolver: %v", err)
	}
	t.Logf("default resolver: %s -> %v", name, addrs)
	if goAddrs, err := (&net.Resolver{PreferGo: true}).LookupHost(ctx, name); err == nil {
		t.Fatalf("the pure Go resolver resolved %s too (%v): this run cannot tell the resolvers apart", name, goAddrs)
	} else {
		t.Logf("pure Go resolver fails, as expected: %v", err)
	}
}
