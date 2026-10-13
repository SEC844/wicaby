// The mocks' WebSocket server side (RFC 6455, text frames only), shared by mock-emby.mjs and mock-jellyfin.mjs.
// mock-livetv.mjs keeps its own copy (cast spec CA-01 risk note); mock-emby.mjs no longer routes /embywebsocket to it,
// its events reach Emby clients through the emit hook instead. shortcut: drop that copy when the Live TV mock is next edited.
import crypto from 'node:crypto';

export const messageId = () => crypto.randomUUID().replace(/-/g, '');

export function frame(obj) {
  const data = Buffer.from(JSON.stringify(obj));
  const len = data.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, len]);
  else if (len < 65536) head = Buffer.from([0x81, 126, len >> 8, len & 255]);
  else {
    head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, data]);
}

export function wsSend(sock, obj) {
  if (!sock.destroyed) sock.write(frame({ ...obj, MessageId: obj.MessageId ?? messageId() }));
}

// Completes the handshake, sends ForceKeepAlive, answers KeepAlive, ping and close, and hands every other JSON
// message to onMessage(msg, entry). Returns the entry { sock, deviceId, at, keepAlives }.
export function acceptSocket(req, sock, { deviceId = '', onMessage = () => {}, onClose = () => {} } = {}) {
  const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const entry = { sock, deviceId: new URL(req.url, 'http://x').searchParams.get('deviceId') ?? deviceId, at: Date.now(), keepAlives: 0 };
  wsSend(sock, { MessageType: 'ForceKeepAlive', Data: 60 });
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 15;
      let len = buf[1] & 127;
      let off = 2;
      if (len === 126) [len, off] = [buf.readUInt16BE(2), 4];
      else if (len === 127) [len, off] = [Number(buf.readBigUInt64BE(2)), 10];
      const masked = buf[1] & 128;
      const total = off + (masked ? 4 : 0) + len;
      if (buf.length < total) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const payload = Buffer.from(buf.subarray(total - len, total));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(total);
      if (op === 8) return sock.end(Buffer.from([0x88, 0]));
      if (op === 9) sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
      if (op !== 1) continue;
      let msg;
      try {
        msg = JSON.parse(payload.toString('utf8'));
      } catch {
        console.log('SOCKET bad frame');
        continue;
      }
      if (msg.MessageType === 'KeepAlive') {
        entry.keepAlives++;
        wsSend(sock, { MessageType: 'KeepAlive' });
      } else onMessage(msg, entry);
    }
  });
  let closed = false;
  const drop = () => {
    if (closed) return;
    closed = true;
    onClose(entry);
  };
  sock.on('close', drop);
  sock.on('error', drop);
  return entry;
}
