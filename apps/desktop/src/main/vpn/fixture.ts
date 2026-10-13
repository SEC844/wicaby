// Dev-only VPN fixture (onboarding spec OB-D4): WICABY_VPN_FIXTURE=<file.json> makes vpn.status(),
// vpn.peers() and vpn.diagnostics() answer from that file, so the Remote access pane can be checked without
// a real mesh (tools/checks/onboarding-cdp.mjs). The file is read on every call: a check rewrites it to
// switch states. A packaged build never reads it (tools/checks/desktop-hardening-check.mjs asserts this).
// Dependency-free so that check imports it.
import fs from 'node:fs';
import type { VpnPeer, VpnStatus } from '../../shared/contract';

export interface VpnFixture {
  status: VpnStatus[];
  // Per kind; `servers` is filled by the facade's probe like real peers.
  peers?: Partial<Record<string, VpnPeer[]>>;
  // Stands in for the embedded node's helper log in diagnostics.
  log?: string[];
}

export function vpnFixture(file: string | undefined, packaged: boolean): (() => VpnFixture) | null {
  if (packaged || !file) return null;
  return () => JSON.parse(fs.readFileSync(file, 'utf8')) as VpnFixture;
}
