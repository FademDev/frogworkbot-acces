const fs = require('node:fs');
// Поиск строки по подстроке: node peek.js "<подстрока>" "<путь к файлу>"
const needle = process.argv[2];
const file = process.argv[3];
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const index = lines.findIndex(l => l.includes(needle));
if (index === -1) { console.log('not found:', needle); process.exit(1); }
const from = Math.max(0, index - 3);
const to = Math.min(lines.length, index + 45);
lines.slice(from, to).forEach((l, i) => console.log(`${from + i + 1}| ${l}`));