// Starts the mock Emby server with the demo catalogue: node tools/mock-server/demo/serve.mjs [port] [video]
// Same arguments as mock-emby.mjs; it only sets MOCK_DATASET=demo first (MOCK_DEMO_LANG=fr still applies).
// The mock is imported dynamically so the variable is set before its top level runs.
import http from 'node:http';

process.env.MOCK_DATASET = 'demo';
const { handler, PORT, VIDEO } = await import('../mock-emby.mjs');
// Loopback only, as mock-emby.mjs: a mock reachable from the LAN would show up in real clients.
http.createServer(handler).listen(PORT, process.env.MOCK_HOST || '127.0.0.1', () => console.log(`Mock Emby (demo dataset) on http://127.0.0.1:${PORT} (user Wika / wicaby)${VIDEO ? `, video ${VIDEO}` : ''}`));
