import { redact } from '../core/log';

// Diagnostics a user may paste anywhere (onboarding spec 3.5): log redaction plus addresses,
// mesh keys, sign-in links, user codes, private hostnames and peer names. The Android twin is
// core/mesh/Diagnostics.kt; both run tools/checks/fixtures/diagnostics-redact.json, so keep the
// rules and their order identical.

// Public provider hosts stay readable.
const PROVIDER_HOSTS = new Set(['login.tailscale.com', 'controlplane.tailscale.com', 'api.netbird.io', 'app.netbird.io']);

const URL_RE = /\b([A-Za-z][A-Za-z0-9+.-]*):\/\/([^\s/?#"'<>(),;]*)([^\s"'<>]*)/g;
const TSKEY = /\btskey-[A-Za-z0-9-]+/g;
const UUID = /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g;
const USER_CODE = /\b[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+\b/g;
const CIDR4 = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\/(\d{1,2})(?!\d)/g;
const IPV4 = /(?<![\w.])(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}(?!\w|\.\d)/g;
const H = '[0-9A-Fa-f]{1,4}';
// No ':' in the lookarounds: Go errors put one right after the address ("listen fd7a::2: …") and
// Go %+v structs right before it ("{IP:fd7a::2}").
const IPV6 = new RegExp(String.raw`(?<!\w)(?:${H}(?::${H}){7}|(?:${H}(?::${H})*)?::(?:${H}(?::${H})*)?)(?:/\d{1,3})?(?!\w)`, 'g');
const HOSTNAME = /(?<![\w.-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63})(?![\w-])(:\d+)?(\/[^\s"'<>]*)?/g;
// redactMeshLog's 20-character floor when the run has a digit (so "X-Emby-Authorization" stays), 32 otherwise.
const SECRET = /(?=[A-Za-z+/_-]*\d)[A-Za-z0-9+/_-]{20,}={0,2}|[A-Za-z0-9+/_-]{32,}={0,2}/g;
// Credentials in the forms redact() masks, so Android (redactMeshLog has no such rule) masks them alike.
// shortcut: quoted values with spaces and percent-encoded pairs are only fully masked by the
// desktop redact(); port it to core if Android diagnostics ever carry server request logs.
const BEARER = /(Bearer\s+)(?!\*\*\*)[^&\s"'\\]+/gi;
const AUTH_SCHEME = /\b(authorization["']?\s*[=:]\s*["']?(?:Basic|Digest|Emby|MediaBrowser)\s+)(?![\w-]+\s*=|\*\*\*)[^\s,&"'\\]+/gi;
const KEY_PAIR = /\b(api[_-]?key|x-emby-token|x-mediabrowser-token|access[_-]?token)(["']?\s*[=:]\s*["']?|\s+)(?!\*\*\*)[^&\s"']+/gi;
const WORD_PAIR = /(token|password|secret|authorization)(["']?\s*[=:]\s*["']?)(?!(?:MediaBrowser|Emby|Bearer|Basic|Digest)\s|\*\*\*)[^&\s"']+/gi;

const hostOrMask = (host: string) => (PROVIDER_HOSTS.has(host.toLowerCase().replace(/\.$/, '')) ? host : '<host>');
const tail = (path: string | undefined) => (path && path !== '/' ? '/***' : '');

/** [names]: peer and self names, replaced by peer-1..n (one number per name, first listed first). */
export function redactDiagnostics(text: string, names: string[] = []): string {
  let out = redact(text);
  const labels = new Map<string, string>();
  for (const n of names.map((x) => x.trim()).filter(Boolean)) if (!labels.has(n.toLowerCase())) labels.set(n.toLowerCase(), `peer-${labels.size + 1}`);
  for (const [name, label] of [...labels].sort((a, b) => b[0].length - a[0].length)) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_.-])${esc}(?![A-Za-z0-9_-])`, 'gi'), label);
  }
  return out
    .replace(BEARER, '$1***')
    .replace(AUTH_SCHEME, '$1***')
    .replace(KEY_PAIR, '$1$2***')
    .replace(WORD_PAIR, '$1$2***')
    .replace(URL_RE, (_m, scheme: string, authority: string, rest: string) => {
      const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
      const bracket = hostPort.startsWith('[') ? hostPort.indexOf(']') + 1 : 0;
      const colon = hostPort.indexOf(':', bracket);
      const host = colon < 0 ? hostPort : hostPort.slice(0, colon);
      const port = colon < 0 ? '' : hostPort.slice(colon);
      return `${scheme}://${hostOrMask(host)}${port}${tail(rest)}`;
    })
    .replace(TSKEY, 'tskey-***')
    .replace(UUID, '***')
    .replace(USER_CODE, '***')
    .replace(CIDR4, '$1.$2.*.*/$3')
    .replace(IPV4, '$1.*.*.*')
    .replace(IPV6, (m) => (m === '::' ? m : `${m.slice(0, m.indexOf(':'))}:…${m.includes('/') ? m.slice(m.indexOf('/')) : ''}`))
    .replace(HOSTNAME, (_m, host: string, port: string | undefined, path: string | undefined) => `${hostOrMask(host)}${port ?? ''}${tail(path)}`)
    .replace(SECRET, '***');
}
