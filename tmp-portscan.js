const net = require('node:net');
const host = process.argv[2] || '87.228.74.140';
const ports = (process.argv[3] || '25746,25575,25566,25567,25565').split(',').map(Number);
for (const port of ports) {
  const started = Date.now();
  const socket = net.connect({ host, port, timeout: 6000 });
  const done = msg => { console.log(`${host}:${port} -> ${msg} (${Date.now() - started}ms)`); socket.destroy(); };
  socket.on('connect', () => done('OPEN'));
  socket.on('timeout', () => done('TIMEOUT'));
  socket.on('error', err => done(`ERROR ${err.code}`));
}
setTimeout(() => process.exit(0), 8000);