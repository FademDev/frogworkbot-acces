require('dotenv').config({ path: require('node:path').join(__dirname, '.env') });
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const config = require('node:path').join(__dirname, 'config.json');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
client.once('clientReady', async c => {
  console.log('LOGIN OK as', c.user.tag, c.user.id);
  try {
    const guild = await client.guilds.fetch('1545917905198252142');
    console.log('Guild:', guild.name, guild.id);
    const channels = await guild.channels.fetch();
    for (const ch of channels.values()) {
      console.log(`- ${ch.id} #${ch.name} type=${ch.type} (${ChannelType[ch.type]}) parent=${ch.parentId}`);
    }
    const member = await guild.members.fetch('1027434824580997130').catch(() => null);
    console.log('admin member:', member ? `${member.user.tag} roles=${[...member.roles.cache.keys()].join(',')}` : 'not found');
    const app = await client.application.fetch();
    console.log('owner:', app.owner?.id);
  } catch (e) {
    console.error('probe error', e);
  }
  await c.destroy();
  process.exit(0);
});
client.on('error', e => console.error('client error', e));
client.login(process.env.DISCORD_TOKEN).catch(e => { console.error('login failed:', e.message); process.exit(1); });