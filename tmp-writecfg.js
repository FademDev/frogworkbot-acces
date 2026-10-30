const c = require('./config.json');
const out = [
  'panel=' + JSON.stringify(c.panel),
  'votes=' + JSON.stringify(c.votes),
  'rcon.port=' + c.rcon.port,
  'rcon.auto_whitelist=' + c.rcon.auto_whitelist,
  'rcon.debug=' + JSON.stringify(c.rcon.debug),
  'success_keywords=' + JSON.stringify(c.rcon.success_keywords)
];
require('fs').writeFileSync(__dirname + '/tmp-cfg.txt', out.join('\n') + '\n');
console.log(out.join('\n'));