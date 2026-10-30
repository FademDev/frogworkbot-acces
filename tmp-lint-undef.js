// Быстрая самопроверка: находит вызовы несуществующих функций внутри bot.js.
// Нужен, потому что `node --check` ловит только синтаксис, а не опечатки в именах.
const fsLocal = require('node:fs');
const pathLocal = require('node:path');
const source = fsLocal.readFileSync(pathLocal.join(__dirname, 'bot.js'), 'utf8');

// Имена, определённые в bot.js и его модулях.
const defined = new Set();
const defRe = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
let m;
while ((m = defRe.exec(source))) defined.add(m[1]);
const constRe = /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
while ((m = constRe.exec(source))) defined.add(m[1]);
for (const mod of ['./rcon.js', './voting.js', './rules.js']) {
  const target = require(pathLocal.join(__dirname, mod));
  Object.keys(target).forEach(k => defined.add(k));
}
for (const name of Object.keys(require('discord.js'))) defined.add(name);
['console', 'require', 'process', 'module', 'exports', '__dirname', 'setTimeout', 'setInterval', 'clearInterval',
  'clearTimeout', 'fetch', 'Buffer', 'Promise', 'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Array',
  'Object', 'RegExp', 'Set', 'Map', 'Error', 'AbortController', 'URL', 'Intl', 'isNaN', 'parseInt', 'parseFloat'].forEach(k => defined.add(k));
// Стрелочные функции и параметры/деструктуризация — грубо, но достаточно для отлова опечаток.
const arrowRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;
while ((m = arrowRe.exec(source))) defined.add(m[1]);

// Вызовы вида name(...)
const callRe = /(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g;
const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await',
  'async', 'else', 'do', 'try', 'throw', 'delete', 'void', 'in', 'of', 'instanceof', 'yield', 'super', 'this']);
const missing = new Set();
while ((m = callRe.exec(source))) {
  const name = m[1];
  if (keywords.has(name) || defined.has(name)) continue;
  // Пропускаем свойства объектов и вызовы методов: они уже отфильтрованы lookbehind.
  missing.add(name);
}

const report = [...missing].sort();
console.log(missing.size ? `MISSING: ${report.join(', ')}` : 'MISSING: none');
process.exit(missing.size ? 1 : 0);