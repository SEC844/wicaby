# Remote access with Tailscale or NetBird

You can watch your Emby or Jellyfin server away from home without opening ports on your router. Wicaby joins your **Tailscale** or **NetBird** network as a device of its own. You don't need to install the Tailscale or NetBird app on the device you watch on.

What you need:

- A Tailscale or NetBird account, or your own NetBird server. Your own Headscale server works on Android (through **Advanced Options**); on Windows it needs the Tailscale app (see below).
- The machine that runs Emby or Jellyfin on that network, with Tailscale or NetBird installed and signed in on it.
- On Android, Android 8.0 or later. The TV app installs on Android 6+, but remote access needs 8.0.

Wicaby only uses the network to reach your media servers:

- It only connects to devices on your network, and nothing else on your PC or phone goes through it.
- It offers nothing to the other devices on the network.
- It sends no diagnostics to Tailscale.

## On Windows

### Sign in

1. Open the **Servers** page:
   - On first launch, it is the welcome screen.
   - Later, open Settings → Server → **Add Server** → "Add…", or the account menu → Servers.
2. Under **Remote Access**, choose **Sign In with Tailscale** or **Sign In with NetBird**.
3. Your browser opens the sign-in page. Sign in with your usual account (Google, Microsoft, GitHub…). The tile shows "Finish signing in with your browser". If you closed the page, choose **Reopen Page**.
4. When the tile shows **Connected · wicaby-<your PC name>**, Wicaby is on your network. It appears there as a device named `wicaby-<your PC name>`.

If your network requires an administrator to approve new devices, the tile says so until the device is approved in the admin console.

**Self-hosted NetBird or a setup key.** Open **Self-Hosted NetBird Server or Setup Key** before signing in:

- Enter your management server address (`https://netbird.example.com`), a setup key, or both.
- With a setup key, there is no browser step.
- A key works only once: after that, Wicaby keeps its own device credentials.

**Tailscale or NetBird app already installed and connected.** Wicaby uses it as it is (the tile says "… app"). Its settings stay in charge, including a Headscale server set with `--login-server`.

**Headscale on Windows.** Wicaby's own Tailscale sign-in always uses the official Tailscale service. To use Headscale, install the Tailscale app, point it at your Headscale server with `tailscale up --login-server <your Headscale URL>`, and connect it; Wicaby then uses the app.

### Add a server from your network

1. Once connected, choose **Choose Device** on the Tailscale or NetBird tile.
2. Wicaby lists the devices on your network and checks each online one for a media server on port 8096 (http) and 8920 (https). This takes a few seconds.
3. Devices with a server show "Emby · <server name>" or "Jellyfin · <server name>". Choose **Add**, then sign in as usual.

A device marked "No server on ports 8096 and 8920" either runs no media server or blocks those ports. For example, the server may listen on a custom port, or the firewall on that machine may drop traffic from the Tailscale/NetBird interface. In that case, type the address yourself under **Server Address**, using the device's network address (`100.x.y.z:<port>`) or its MagicDNS / NetBird name.

### Day to day

- Wicaby reconnects to your network at every launch until you sign out.
- **Servers you added at home** keep working away from home. When the home address doesn't answer, Wicaby looks for the same server among your network's devices (same name, or the same machine) and connects through the network.
- **Server not responding.** The Servers page shows a banner with **Wake**, **Retry**, offline mode (your downloads), and a **Connect** button for each network, which retries as soon as it is connected.
- **Sign out.** Open **Choose Device**, then **Sign Out of Tailscale** (or NetBird). Wicaby signs this PC out of your network and forgets its key. With Tailscale, the device may stay listed, signed out, in the admin console until you remove it there.

## On Android TV and phones

### Sign in with a QR code

1. Open **Settings → Remote Access**.
2. Choose **Connect Tailscale** or **Connect NetBird**.
3. The TV shows a **QR code**. Scan it with your phone and sign in there. With NetBird, check that the **confirmation code** on the TV matches the one on your phone. If you can't scan, the address is printed under the code ("or open this address"). On a phone, tap **Open in Browser** instead: the sign-in page opens on the same device.
4. The panel then shows **Connected to Tailscale** (or NetBird). It also shows this device's name (`wicaby-<device name>`) and **Devices on Your Network**: up to eight devices with their addresses, online ones first.

**Advanced Options** lets you enter:

- **Control server:** a Headscale or self-hosted NetBird address. Leave it blank for the official service.
- **Auth or setup key:** a Tailscale auth key or a NetBird setup key. There is then no QR code step, and the key is not stored.

### Add your server

The Android apps connect to one server at a time, by the address you typed. To use your server away from home, add it with its **network address**, not its home address:

1. Note the server's address in **Devices on Your Network**, for example `100.101.102.103`.
2. Choose **Switch Server**: in **Settings → Accounts** on a TV, in the **Account** section of Settings on a phone.
3. Type that address with the port: `100.101.102.103:8096`. A MagicDNS or NetBird name (`nas.tail1234.ts.net`) works too.

Wicaby sends this server's traffic through your network: browsing, artwork, playback and downloads. Addresses that are not on your network are reached directly, as before.

### Day to day

- The connection comes back on its own each time Wicaby starts. Playback and downloads keep it alive in the background.
- **Turn Off** leaves the network for now. The device stays registered, so turning it on again is instant.
- **Sign Out of Network** signs the device out of your network and forgets its key. You will need to sign in again.
- If the connection fails, the panel shows the reason with **Retry**, **Turn Off** and **Sign Out of Network**.

## qBittorrent and file sources on your home network

qBittorrent (Settings > Torrents) and WebDAV/SMB file sources typed with a home-network address, such as `http://192.0.2.15:8080`, work at home and away:

- Wicaby first connects directly. At home, that is all it does.
- When the address doesn't answer within 1.5 s and Wicaby's own Tailscale/NetBird connection can reach it, the requests go through that connection instead. It can reach the address when it is a device of your network (its `100.x.y.z` address or its name), or when it lies inside a **NetBird network route** (a routing peer at home that serves your home subnet, for example `192.0.2.0/24`).
- **Test Connection** says which way worked ("Connected (direct)" or "Connected via NetBird/Tailscale"), or which step failed: the direct connection, Remote Access not connected, or an address in no route.
- With the Tailscale or NetBird app installed and connected instead, the system routes these addresses itself.
- Tailscale subnet routes are not supported by Wicaby's own connection: use the device's Tailscale address, or the Tailscale app.
- On Windows, SMB sources open through Windows itself, so away from home they need the Tailscale or NetBird app.

To reach them away from home, set up one of these:

- **A NetBird network route:** in the NetBird dashboard, add a route for your home subnet (for example `192.0.2.0/24`) served by a peer that stays at home. Keep the home-network address in Wicaby.
- **NetBird (or Tailscale) on that host:** install it on the computer or NAS that runs qBittorrent or the WebDAV server, then enter its `100.x.y.z` address or its name in Wicaby.

## Troubleshooting

| Symptom | What to check |
|---|---|
| "Choose Device" lists nothing | The other devices are signed out or offline, or your network's access rules hide them from new devices. |
| The server device shows no server | The media server listens on a port other than 8096/8920, or a firewall on that machine blocks the network interface. Add it by address. |
| Stuck on "waiting for approval" | Approve `wicaby-<name>` in the Tailscale admin console (device approval is on). |
| NetBird says it offers no browser sign-in | Your self-hosted NetBird has no identity provider for devices: use a setup key. |
| "NetBird is not included in this build" | A Tailscale-only build of the Android apps. Use Tailscale, or install the regular build. |
| "Requires Android 8.0 or later" | The device is too old for remote access. On some TVs, the official Tailscale app may still work. Install it and add the server by its network address. |
