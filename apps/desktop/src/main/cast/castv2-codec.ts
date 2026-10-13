// CASTV2 framing (docs/specs/cast-spec.md CA-09): a 4-byte big-endian length, then a CastMessage protobuf.
// Written from the field numbers of Chromium's BSD-licensed cast_channel.proto only:
//   1 protocol_version (enum, CASTV2_1_0 = 0)   2 source_id   3 destination_id   4 namespace
//   5 payload_type (enum, STRING = 0)            6 payload_utf8   (7 payload_binary is never sent)
// tools/mock-server/mock-cast.mjs runs this same file, so both ends are checked against the golden vectors in
// tools/checks/fixtures/cast/castv2-vectors.json (tools/checks/cast-mock-check.mjs), not against each other.

export const MAX_MESSAGE = 64 * 1024;

export interface CastMessage {
  source: string;
  destination: string;
  namespace: string;
  data: string; // the JSON payload, as text
}

function varint(n: number): number[] {
  const out: number[] = [];
  for (; n > 0x7f; n = Math.floor(n / 128)) out.push((n % 128) | 0x80);
  out.push(n);
  return out;
}

const text = (no: number, s: string): Buffer => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([(no << 3) | 2, ...varint(b.length)]), b]);
};

export function encodeFrame(m: CastMessage): Buffer {
  const body = Buffer.concat([
    Buffer.from([0x08, 0x00]), // protocol_version = CASTV2_1_0
    text(2, m.source),
    text(3, m.destination),
    text(4, m.namespace),
    Buffer.from([0x28, 0x00]), // payload_type = STRING
    text(6, m.data),
  ]);
  if (body.length > MAX_MESSAGE) throw new RangeError(`CASTV2 message of ${body.length} bytes (cap ${MAX_MESSAGE})`);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

export function decodeMessage(body: Buffer): CastMessage {
  const m: CastMessage = { source: '', destination: '', namespace: '', data: '' };
  let i = 0;
  const readVarint = (): number => {
    let n = 0;
    for (let shift = 0; ; shift += 7) {
      if (i >= body.length || shift > 28) throw new RangeError('CASTV2: bad varint');
      const b = body[i++];
      n += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return n;
    }
  };
  while (i < body.length) {
    const key = readVarint();
    const wire = key & 7;
    if (wire === 0) {
      readVarint(); // protocol_version, payload_type
      continue;
    }
    if (wire !== 2) throw new RangeError(`CASTV2: unexpected wire type ${wire}`);
    const len = readVarint();
    if (i + len > body.length) throw new RangeError('CASTV2: truncated field');
    const s = body.subarray(i, (i += len)).toString('utf8');
    const no = key >>> 3;
    if (no === 2) m.source = s;
    else if (no === 3) m.destination = s;
    else if (no === 4) m.namespace = s;
    else if (no === 6) m.data = s;
  }
  return m;
}

// Splits a TLS byte stream into messages. Throws on a frame over MAX_MESSAGE or a malformed one; the caller then
// closes the socket.
export function frameReader(onMessage: (m: CastMessage) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > MAX_MESSAGE) throw new RangeError(`CASTV2 frame of ${len} bytes (cap ${MAX_MESSAGE})`);
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      onMessage(decodeMessage(body));
    }
  };
}
