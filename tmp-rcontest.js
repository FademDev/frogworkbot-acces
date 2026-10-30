require('dotenv').config({ path: require('node:path').join(__dirname, '.env') });
const { Rcon } = require('rcon-client');
const host = process.argv[2] || '87.228.74.140';
const ports = (process.argv[3] || '25577').split(',').map(Number);

(async () => {
  for (const port of ports) {
    const started = Date.now();
    let rcon = null;
    try {
      rcon = new Rcon({ host, port, password: process.env.RCON_PASSWORD, timeout: 6000 });
      await rcon.connect();
      console.log(`[${host}:${port}] TCP+auth OK (${Date.now() - started}ms), authenticated=${rcon.authenticated}`);
      for (const cmd of ['list', 'whitelist list']) {
        try {
          const t = Date.now();
          const res = await rcon.send(cmd);
          console.log(`  ${cmd} -> "${res}" (${Date.now() - t}ms)`);
        } catch (e) {
          console.log(`  ${cmd} -> ERROR ${e.message}`);
        }
      }
    } catch (e) {
      console.log(`[${host}:${port}] FAILED after ${Date.now() - started}ms: ${e.code || ''} ${e.message}`);
    } finally {
      if (rcon && rcon.authenticated) { try { await rcon.end(); } catch (e) { console.log('  end():', e.message); } }
    }
  }
  process.exit(0);
})();