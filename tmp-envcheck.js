const out = [];
for (const name of ['discord.js', 'dotenv', 'rcon-client']) {
  try { out.push(`${name} = ${require(name + '/package.json').version}`); }
  catch (e) { out.push(`${name} = MISSING (${e.code})`); }
}
out.push(`node = ${process.version}`);
console.log(out.join('\n'));