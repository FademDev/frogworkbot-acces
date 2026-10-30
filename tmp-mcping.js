const net = require('node:net');
const dns = require('node:dns');
const host = '87.228.74.140';

function varint(value) {
  const bytes = [];
  let v = value;
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; bytes.push(b); } while (v);
  return Buffer.from(bytes);
}
const frame = body => Buffer.concat([varint(body.length), body]);

function ping(port) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = net.connect({ host, port, timeout: 6000 });
    let buffer = Buffer.alloc(0);
    let finished = false;
    const finish = msg => {
      if (finished) return;
      finished = true;
      console.log(`${host}:${port} -> ${msg} (${Date.now() - started}ms)`);
      socket.destroy();
      resolve();
    };
    socket.on('connect', () => {
      const name = Buffer.from(host, 'utf8');
      socket.write(frame(Buffer.concat([varint(0), varint(763), varint(name.length), name, Buffer.from([0, 1])])));
      socket.write(frame(Buffer.from([0, 0])));
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const start = buffer.indexOf(Buffer.from('{'));
      if (start >= 0) {
        try {
          const json = JSON.parse(buffer.subarray(start).toString('utf8'));
          finish('MINECRAFT ping OK, version=' + json.version?.name + ' protocol=' + json.version?.protocol);
          return;
        } catch {}
      }
      if (buffer.length > 4096) finish('unexpected data: ' + buffer.subarray(0, 60).toString('hex'));
    });
    socket.on('timeout', () => finish('TIMEOUT'));
    socket.on('error', e => finish('ERROR ' + e.code));
    socket.on('close', () => setTimeout(() => finish('CLOSED without valid ping response'), 50));
  });
}

dns.reverse(host, (err, hosts) => console.log('reverse dns:', err ? err.code : hosts.join(', ')));
dns.lookup('sbis.host', (err, addr) => console.log('sbis.host ->', err ? err.code : addr));
(async () => {
  for (const port of [25565, 25590]) await ping(port);
  process.exit(0);
})();