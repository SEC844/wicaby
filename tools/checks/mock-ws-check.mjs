// The mocks' WebSocket parser (tools/mock-server/ws.mjs) on a frame that arrives one byte at a time: a client
// frame of 126+ bytes has a 2-byte extended length that may not be there yet when the first chunk lands.
// Usage: node tools/checks/mock-ws-check.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { acceptSocket } from '../mock-server/ws.mjs';

const sock = Object.assign(new EventEmitter(), { destroyed: false, out: [], write(b) { this.out.push(b); }, end() {} });
const entry = acceptSocket({ url: '/embywebsocket?deviceId=d1', headers: { 'sec-websocket-key': 'x' } }, sock);

// A masked text frame with a 16-bit length (KeepAlive padded past 125 bytes).
const data = Buffer.from(JSON.stringify({ MessageType: 'KeepAlive', Pad: 'x'.repeat(200) }));
const mask = Buffer.from([1, 2, 3, 4]);
const head = Buffer.from([0x81, 0x80 | 126, data.length >> 8, data.length & 255]);
const frame = Buffer.concat([head, mask, data.map((b, i) => b ^ mask[i % 4])]);
for (const b of frame) sock.emit('data', Buffer.from([b]));

assert.equal(entry.deviceId, 'd1');
assert.equal(entry.keepAlives, 1, 'the split KeepAlive frame is parsed once');
assert.match(sock.out.at(-1).toString('utf8'), /"MessageType":"KeepAlive"/, 'and answered');
console.log('mock-ws-check: a frame split byte by byte is parsed and answered');
