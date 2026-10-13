// wicaby-mesh: Wicaby's own node on the user's Tailscale or NetBird network,
// driven by the Windows app over stdio. It exposes nothing but loopback
// forwarders to the media servers Wicaby asks for.
//
// Protocol: JSON lines. Commands on stdin, events on stdout, diagnostics on
// stderr. Secrets only travel on stdin, never in argv or the environment.
//
//	-> {"cmd":"start","authKey":"..."}            authKey optional
//	-> {"cmd":"forward","id":1,"upstream":"http://100.64.1.2:8096"}
//	-> {"cmd":"logout"}
//	<- {"type":"status","state":"needs-login","authUrl":"https://...",...}
//	<- {"type":"forward","id":1,"base":"http://127.0.0.1:50123/<token>"}
//	<- {"type":"logout","error":""}
//
// Closing stdin (Wicaby quit or crashed) shuts the node down.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sync"
	"time"

	"wicaby/vpn-helper/mesh"
)

type command struct {
	Cmd      string `json:"cmd"`
	ID       int    `json:"id"`
	AuthKey  string `json:"authKey"`
	Upstream string `json:"upstream"`
}

func main() {
	provider := flag.String("provider", "", "tailscale or netbird")
	dir := flag.String("dir", "", "state directory (holds the node key)")
	hostname := flag.String("hostname", "", "name of this node in the mesh")
	controlURL := flag.String("control-url", "", "Headscale or NetBird management URL; empty = hosted service")
	verbose := flag.Bool("verbose", false, "log the provider's internals to stderr")
	flag.Parse()

	var mu sync.Mutex
	out := json.NewEncoder(os.Stdout)
	send := func(v any) {
		mu.Lock()
		defer mu.Unlock()
		_ = out.Encode(v)
	}
	node, err := mesh.New(mesh.Config{
		Provider: *provider, Dir: *dir, Hostname: *hostname, ControlURL: *controlURL, Verbose: *verbose,
		OnStatus: func(st mesh.Status) { send(st) },
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64*1024), 1024*1024)
	for in.Scan() {
		var c command
		if err := json.Unmarshal(in.Bytes(), &c); err != nil {
			fmt.Fprintln(os.Stderr, "bad command:", err)
			continue
		}
		switch c.Cmd {
		case "start":
			node.Start(c.AuthKey)
			send(node.Status())
		case "forward":
			base, err := node.Forward(c.Upstream)
			res := map[string]any{"type": "forward", "id": c.ID, "base": base}
			if err != nil {
				res["error"] = err.Error()
			}
			send(res)
		case "logout":
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			err := node.Logout(ctx)
			cancel()
			msg := ""
			if err != nil {
				msg = err.Error()
			}
			send(map[string]any{"type": "logout", "error": msg})
		}
	}
	node.Close()
}
