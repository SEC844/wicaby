// What a renderer does with a URL it is handed (mock-dlna.mjs, mock-cast.mjs; cast spec CA-06): GET the first 64 KB
// and record the status, the Content-Type, CORS and whether the URL carries a token.
// Loopback only: a URL on any other host is refused without a connection, unless the mock was given a
// MOCK_*_HOST by hand (`open`). Redirects are never followed.
export const isLoopback = (host) => /^127\.\d+\.\d+\.\d+$/.test(host) || host === '[::1]' || host === 'localhost';
export const tokenInUrl = (url) => /api_key|apikey|x-emby-token/i.test(url);

export async function probe(url, { open = false, headers = {} } = {}) {
  const out = { url, status: 0, type: null, cors: null, bytes: 0, tokenInUrl: tokenInUrl(url), error: null };
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ...out, error: 'not a URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ...out, error: `scheme ${u.protocol} refused` };
  if (!open && !isLoopback(u.hostname)) return { ...out, error: `non-loopback host ${u.hostname} refused (set MOCK_*_HOST to allow)` };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-65535', ...headers }, redirect: 'manual', signal: ac.signal });
    Object.assign(out, { status: res.status, type: res.headers.get('content-type'), cors: res.headers.get('access-control-allow-origin') });
    const reader = res.body?.getReader();
    while (reader && out.bytes < 65536) {
      const { done, value } = await reader.read();
      if (done) break;
      out.bytes += value.length;
    }
    await reader?.cancel().catch(() => {});
  } catch (e) {
    out.error = String(e?.cause?.code ?? e?.message ?? e);
  } finally {
    clearTimeout(timer);
  }
  return out;
}
