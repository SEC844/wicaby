// Pure VPN panel rules (no IPC, no runes): tools/checks/mesh-selfcheck.mjs tests them.
import type { VpnStatus } from '../../shared/contract';

// Whether the embedded NetBird node's pending sign-in page still belongs to what the panel holds: the same
// management server ('' = hosted) and no setup key typed. Otherwise "Reopen page" would send the user back to
// the old server's page (login.netbird.io) instead of connecting with what they typed.
export function pendingMatches(status: VpnStatus | undefined, managementUrl: string, setupKey: string): boolean {
  return (status?.managementUrl ?? '') === managementUrl.trim() && setupKey.trim() === '';
}
