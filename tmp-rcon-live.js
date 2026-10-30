// Временный живой тест RCON: проверяет TCP и AUTH на 25594 (MAIN) и 25746 (ALT) реальным паролем.
require('dotenv').config();
const net = require('node:net');
const fs = require('node:fs');

const HOST = '87.228.74.140';
const PASS = 'ChairTable';
const PORTS = [25746, 25594];

function tcp(port) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = net.connect({ host: HOST, port, timeout: 6000 });
    let done = false;
    const finish = r => { if (!done) { done = true; socket.destroy(); resolve({ port, ms: Date.now() - started, ...r }); } };
    socket.on('connect', () => finish({ ok: true }));
    socket.on('timeout', () => finish({ ok: false, code: 'timeout' }));
    socket.on('error', e => finish({ ok: false, code: e.code || 'error', message: e.message }));
  });
}

function auth(port, password) {
  return new Promise(resolve => {
    const socket = net.connect({ host: HOST, port, timeout: 6000 });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const payload = Buffer.from(password, 'utf8');
    const frame = Buffer.alloc(14 + payload.length);
    frame.writeInt32LE(10 + payload.length, 0);
    frame.writeInt32LE(1, 4);
    frame.writeInt32LE(3, 8);
    payload.copy(frame, 12);
    const finish = r => { if (!settled) { settled = true; socket.destroy(); resolve({ port, ...r }); } };
    socket.on('connect', () => socket.write(frame));
    socket.on('timeout', () => finish({ auth: false, code: 'timeout', raw: buffer.subarray(0, 48).toString('hex') }));
    socket.on('error', e => finish({ auth: false, code: e.code || 'error', message: e.message }));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const len = buffer.readInt32LE(0);
      if (len < 10 || len > 8192) return finish({ auth: false, code: 'not_rcon', raw: buffer.subarray(0, 48).toString('hex'), head: buffer.subarray(0, 32).toString('latin1') });
      if (buffer.length < len + 4) return;
      const id = buffer.readInt32LE(4);
      finish({ auth: id !== -1, code: id === -1 ? 'auth_failed' : 'ok' });
    });
  });
}

const log = (...parts) => fs.appendFileSync(__dirname + '/tmp-rcon-live.log', parts.join(' ') + '\n');

// Полный цикл: AUTH -> команда -> ответ. Возвращает { id, body }.
function command(port, password, cmd) {
  return new Promise(resolve => {
    const socket = net.connect({ host: HOST, port, timeout: 8000 });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const pack = (id, type, body) => {
      const payload = Buffer.from(body, 'utf8');
      const frame = Buffer.alloc(14 + payload.length);
      frame.writeInt32LE(10 + payload.length, 0);
      frame.writeInt32LE(id, 4);
      frame.writeInt32LE(type, 8);
      payload.copy(frame, 12);
      return frame;
    };
    const finish = r => { if (!settled) { settled = true; socket.destroy(); resolve({ port, cmd, ...r }); } };
    socket.on('connect', () => socket.write(pack(1, 3, password)));
    socket.on('timeout', () => finish({ ok: false, code: 'timeout' }));
    socket.on('error', e => finish({ ok: false, code: e.code || 'error', message: e.message }));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readInt32LE(0);
        if (len < 10 || len > 8192) return finish({ ok: false, code: 'not_rcon' });
        if (buffer.length < len + 4) return;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.subarray(12, len + 2).toString('utf8');
        buffer = buffer.subarray(len + 4);
        if (type === 2 && id === 1) return finish({ ok: false, code: 'auth_failed' });
        if (id === 1 && type === 0) { socket.write(pack(2, 2, cmd)); continue; }
        if (id === 2) return finish({ ok: true, response: body, type });
      }
    });
  });
}

const run = async () => {
  const { Rcon } = require('rcon-client');
  const port = 25746;
  const rcon = new Rcon({ host: HOST, port, password: 'ChairTable', timeout: 8000 });
  rcon.on('error', e => log('rcon error event', e && e.message));
  try {
    await rcon.connect();
    log('rcon-client connect OK');
    for (const c of ['whitelist add Test1', 'whitelist add Test1', 'zwl add Test2', 'whitelist list', 'zwl list']) {
      const res = await rcon.send(c);
      log('SEND', JSON.stringify(c), '=>', JSON.stringify(res));
    }
  } catch (e) {
    log('rcon-client FAILED', e && e.code, e && e.message);
  } finally {
    try { await rcon.end(); } catch {}
  }
  process.exit(0);
};
run();