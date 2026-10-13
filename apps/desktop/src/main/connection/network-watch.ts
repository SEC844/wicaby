import os from 'node:os';
import { net, powerMonitor } from 'electron';

// The network the PC is on: online state and its interface addresses (another Wi-Fi, a cable, a VPN up or down).
function signature(): string {
  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal)
    .map((a) => a!.address)
    .sort();
  return `${net.isOnline()}|${addrs.join(',')}`;
}

// Calls back with moved=true after a wake from sleep or a network change, and with moved=false
// every pass otherwise (for servers still down). The main process has no online/offline event:
// the same Chromium state is read through net.isOnline(), together with the interfaces, every 15 s.
export function watchNetwork(onCheck: (moved: boolean) => void, everyMs = 15_000): void {
  let last = signature();
  powerMonitor.on('resume', () => {
    // The adapter takes a moment to come back after sleep.
    setTimeout(() => {
      last = signature();
      onCheck(true);
    }, 3000);
  });
  setInterval(() => {
    const now = signature();
    const moved = now !== last;
    last = now;
    onCheck(moved);
  }, everyMs).unref();
}
