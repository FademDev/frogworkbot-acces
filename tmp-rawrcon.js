const net = require('node:net');
const { encodePacket, PacketType, decodePacket } = require('rcon-client/lib/packet');
const host = '87.228.74.140';
const port = Number(process.argv[2] || 25577);

const socket = net.connect({ host, port, timeout: 8000 });
let buffer = Buffer.alloc(0);
socket.setNoDelay(true);
socket.on('connect', () => {
  console.log('TCP connect OK, sending AUTH');
  socket.write(encodePacket({ id: 1, type: PacketType.Auth, payload: Buffer.from(process.env.RCON_PASSWORD || '') }));
});
socket.on('timeout', () => { console.log('timeout waiting for data'); socket.destroy(); });
socket.on('error', e => console.log('socket error', e.code, e.message));
socket.on('close', () => console.log('closed'));
socket.on('data', chunk => {
  console.log('RAW <=', chunk.length, 'bytes:', chunk.subarray(0, 64).toString('hex'), '|', JSON.stringify(chunk.subarray(0, 48).toString('latin1')));
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 12) {
    const len = buffer.readInt32LE(0);
    if (len < 10 || len > 4096) { console.log('bad length prefix -> not RCON:', len); socket.destroy(); buffer = Buffer.alloc(0); return; }
    if (buffer.length < len + 4) return;
    const frame = buffer.subarray(0, len + 4);
    buffer = buffer.subarray(len + 4);
    const pkt = decodePacket(frame);
    console.log('PACKET id=', pkt.id, 'type=', pkt.type, 'payload=', JSON.stringify(pkt.payload.toString('utf8')));
    if (pkt.type === PacketType.AuthResponse && pkt.id === 1) {
      socket.write(encodePacket({ id: 2, type: PacketType.Command, payload: Buffer.from('list') }));
    } else if (pkt.id === 2) {
      socket.end();
    }
  }
});
setTimeout(() => { console.log('giving up'); process.exit(0); }, 10000);