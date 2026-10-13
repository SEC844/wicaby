// Runs every self-check in tools/checks and exits non-zero if any fails.
// Usage: npm run checks   (or: node tools/checks/run-all.mjs)
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const here = import.meta.dirname;
const checks = [
  ['privacy-check.mjs'],
  ['i18n-check.mjs', '--strict'],
  ['i18n-check.mjs', '--self-test'],
  ['livetv-a11y-check.mjs'],
  ['hdr-check.mjs'],
  ['track-check.mjs'],
  ['parity-check.mjs'],
  ['skip-check.mjs'],
  ['home-rows-check.mjs'],
  ['livetv-check.mjs'],
  ['tv-home-check.mjs'],
  ['play-on-check.mjs'],
  ['sessions-mock-check.mjs'],
  ['cast-mock-check.mjs'],
  ['cast-sender-check.mjs'],
  ['remote-check.mjs'],
  ['message-check.mjs'],
  ['cast-check.mjs'],
  ['cast-dlna-check.mjs'],
  ['cast-castv2-check.mjs'],
  ['cast-token-check.mjs'],
  ['shortcuts-check.mjs'],
  ['seek-check.mjs'],
  ['quality-check.mjs'],
  ['subtitles-check.mjs'],
  ['livetv-mock-check.mjs'],
  ['livetv-session-check.mjs'],
  ['continue-check.mjs'],
  ['zip-check.mjs'],
  ['comic-cover-check.mjs'],
  ['download-path-check.mjs'],
  ['bif-check.mjs'],
  ['mesh-selfcheck.mjs'],
  ['vpn-selfcheck.mjs'],
  ['torrents-selfcheck.mjs'],
  ['media-url-check.mjs'],
  ['token-binding-check.mjs'],
  ['vault-check.mjs'],
  ['trakt-check.mjs'],
  ['mpv-args-check.mjs'],
  ['desktop-comfort-check.mjs'],
  ['linux-desktop-check.mjs'],
  ['desktop-hardening-check.mjs'],
  ['desk-shell-check.mjs'],
  ['player-exit-check.mjs'],
  ['desktop-recovery-check.mjs'],
  ['history-mock-check.mjs'],
  ['profiles-mock-check.mjs'],
  ['access-schedule-mock-check.mjs'],
  ['music-mock-check.mjs'],
  ['photos-mock-check.mjs'],
  ['photos-check.mjs'],
  ['tiles-check.mjs'],
  ['release-check.mjs'],
  ['licence-check.mjs'],
  ['flavour-check.mjs'],
  // File sources (file-sources-spec FS-00 to FS-05, FS-12 UNC).
  ['caps-check.mjs'],
  ['server-kind-check.mjs'],
  ['files-core-check.mjs'],
  ['files-mock-check.mjs'],
  ['files-store-check.mjs'],
  ['files-routes-check.mjs'],
  ['files-playback-check.mjs'],
  ['files-smb-check.mjs'],
  ['files-mdns-check.mjs'],
];

const failed = [];
for (const [script, ...args] of checks) {
  console.log(`\n== ${script} ${args.join(' ')}`.trimEnd());
  const r = spawnSync(process.execPath, [path.join(here, script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(script);
}

console.log(failed.length ? `\n${failed.length} check(s) failed: ${failed.join(', ')}` : `\nAll ${checks.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
