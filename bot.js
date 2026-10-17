require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, Events
} = require('discord.js');
const { buildRulesMessages } = require('./rules.js');

const ROOT = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const DATA_FILE = path.resolve(ROOT, config.storage?.requests_file || './data/requests.json');
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ requests: [], sessions: {} }, null, 2));
let store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
if (!Array.isArray(store.requests)) store.requests = [];
if (!store.sessions || typeof store.sessions !== 'object') store.sessions = {};
if (!Array.isArray(store.roleAlerts)) store.roleAlerts = [];
if (!store.cooldowns || typeof store.cooldowns !== 'object') store.cooldowns = {};
let writeQueue = Promise.resolve();
function saveStore() {
  writeQueue = writeQueue.then(async () => {
    const temp = DATA_FILE + '.tmp';
    await fs.promises.writeFile(temp, JSON.stringify(store, null, 2));
    await fs.promises.rename(temp, DATA_FILE);
  }).catch(err => console.error('[storage]', err));
  return writeQueue;
}
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message, Partials.User]
});
const active = new Set();
const text = (key, fallback = '') => config.messages?.[key] ?? fallback;
const replace = (s, vars = {}) => String(s ?? '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
const ids = arr => Array.isArray(arr) ? arr.map(String) : [];
const isPanelAdmin = id => ids(config.discord?.panel_admin_ids).includes(String(id));
const isAdmin = id => ids(config.discord?.admin_ids).includes(String(id));
const isGuild = guildId => String(guildId) === String(config.discord?.guild_id);
const accessRoles = ids(config.discord?.access_role_ids);
const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const accessLabel = type => config.access_types?.[type]?.label || (type === 'paid' ? 'Платная' : 'Бесплатная');
function embed(title, description, color = config.colors?.primary || '#5865F2') {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp();
}
function buttonRow(customId, label, emoji, style = ButtonStyle.Success, disabled = false) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled).setEmoji(emoji || undefined));
}
async function dmUser(user, content) {
  try { await user.send(content); return true; }
  catch (e) { console.warn(`[dm] Не удалось написать ${user.id}: ${e.message}`); return false; }
}
async function notifyAdmins(req) {
  const body = replace(text('admin_request_description'), {
    user_mention: `<@${req.userId}>`, user_id: req.userId, minecraft_nick: req.minecraftNick,
    access_type: accessLabel(req.type), source: req.source === 'role' ? 'Выдача по роли' : 'Ручная выдача', reason: req.reason || '—', request_id: req.id
  });
  const message = embed(text('admin_request_title', 'Заявка на вайтлист'), body,
    req.type === 'paid' ? config.colors?.paid : config.colors?.free).setFooter({ text: replace(text('admin_request_footer', 'Заявка {request_id}'), { request_id: req.id }) });
  const row = buttonRow(`wl_done:${req.id}`, config.buttons?.confirm_added?.label || 'Я добавил', config.buttons?.confirm_added?.emoji || '✅');
  req.adminMessages = [];
  for (const adminId of ids(config.discord?.admin_ids)) {
    try {
      const user = await client.users.fetch(adminId);
      const sent = await user.send({ embeds: [message], components: [row] });
      req.adminMessages.push({ userId: adminId, channelId: sent.channelId, messageId: sent.id });
    } catch (e) {
      console.warn(`[admin DM] ${adminId}: ${e.message}`);
    }
  }
  await saveStore();
  if (!req.adminMessages.length) console.warn(`[request ${req.id}] Ни одному администратору не удалось доставить сообщение.`);
}
async function createRequest({ userId, minecraftNick, type, reason = '', source = 'role', createdBy = null }) {
  const req = { id: makeId(), userId: String(userId), minecraftNick, type, reason, source, createdBy,
    status: 'PENDING_WHITELIST', createdAt: new Date().toISOString(), completedAt: null, completedBy: null, adminMessages: [] };
  store.requests.push(req);
  await saveStore();
  await notifyAdmins(req);
  const user = await client.users.fetch(String(userId)).catch(() => null);
  if (user) await dmUser(user, replace(text('request_created'), { minecraft_nick: minecraftNick, request_id: req.id }));
  return req;
}
function hasActiveRequest(userId) {
  return store.requests.some(r => r.userId === String(userId) && ['PENDING_NICKNAME', 'VALIDATING', 'PENDING_WHITELIST'].includes(r.status));
}
function getSession(userId) { return store.sessions[String(userId)] || null; }
async function setSession(userId, session) { store.sessions[String(userId)] = session; await saveStore(); }
async function clearSession(userId) { delete store.sessions[String(userId)]; await saveStore(); }
async function startNicknameFlow(userId, type = 'free', source = 'role', createdBy = null, reason = '') {
  if (hasActiveRequest(userId)) {
    const user = await client.users.fetch(String(userId)).catch(() => null);
    if (user) await dmUser(user, text('request_already_exists', 'У тебя уже есть активная заявка.'));
    return false;
  }

  await setSession(userId, { state: 'WAIT_NICK', type, source, createdBy, reason, startedAt: Date.now() });

  const user = await client.users.fetch(String(userId)).catch(() => null);
  if (!user) {
    await clearSession(userId);
    return false;
  }

  const welcome = replace(text('dm_welcome'), { user_mention: `<@${userId}>` });
  const manualPrefix = source === 'manual'
    ? replace(
        text(
          'manual_access_dm',
          'Вам выдана {access_type} проходка на Minecraft-сервер. Пожалуйста, отправьте следующим сообщением ваш Minecraft Java-ник.'
        ),
        { access_type: accessLabel(type), user_mention: `<@${userId}>` }
      )
    : null;

  const prompt = manualPrefix || `${welcome}\n\n${text('dm_nickname_prompt', 'Введи свой Minecraft Java-ник.')}`;
  const sent = await dmUser(user, prompt);

  if (!sent) {
    await clearSession(userId);
    console.warn(`[flow] Не удалось начать диалог с ${userId}; пользователь должен разрешить ЛС от участников сервера.`);
    return false;
  }

  return true;
}
async function validateMinecraftNick(nick) {
  const pattern = new RegExp(config.minecraft?.nickname_pattern || '^[A-Za-z0-9_]{3,16}$');
  if (!pattern.test(nick)) return { ok: false, reason: 'format' };
  if (!config.minecraft?.check_profile_exists) return { ok: true };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(config.minecraft?.profile_check_timeout_ms || 10000));
  try {
    const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(nick)}`, { signal: controller.signal });
    if (response.status === 200) return { ok: true };
    if (response.status === 204 || response.status === 404) return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'service' };
  } catch { return { ok: false, reason: 'service' }; }
  finally { clearTimeout(timeout); }
}
async function handleNicknameMessage(message) {
  const session = getSession(message.author.id);
  if (!session || session.state !== 'WAIT_NICK' || message.author.bot) return false;
  const nick = message.content.trim();
  if (nick.length > 100) { await dmUser(message.author, text('nickname_invalid_format')); return true; }
  const check = await validateMinecraftNick(nick);
  if (!check.ok) {
    const key = check.reason === 'format' ? 'nickname_invalid_format' : check.reason === 'not_found' ? 'nickname_profile_not_found' : 'nickname_check_failed';
    await dmUser(message.author, replace(text(key), { nickname: nick }));
    return true;
  }
  const normalized = nick;
  if (config.flow?.prevent_duplicate_minecraft_nick && store.requests.some(r => r.minecraftNick.toLowerCase() === normalized.toLowerCase() && ['PENDING_WHITELIST', 'COMPLETED'].includes(r.status))) {
    await dmUser(message.author, text('nickname_already_used', 'Этот Minecraft-ник уже указан в другой заявке. Обратись к администратору, если это ошибка.'));
    return true;
  }
  await clearSession(message.author.id);
  await createRequest({ userId: message.author.id, minecraftNick: normalized, type: session.type, reason: session.reason, source: session.source, createdBy: session.createdBy });
  return true;
}
function panelEmbed() {
  return embed(text('panel_title', 'Панель управления проходками'), text('panel_description', 'Выбери действие.'));
}
function panelComponents() {
  const select = new StringSelectMenuBuilder().setCustomId('panel:action').setPlaceholder('Выбери действие').addOptions(
    { label: config.buttons?.paid_access?.label || 'Платная проходка', value: 'paid', emoji: config.buttons?.paid_access?.emoji || '💳' },
    { label: config.buttons?.free_access?.label || 'Бесплатная проходка', value: 'free', emoji: config.buttons?.free_access?.emoji || '🎁' },
    { label: config.buttons?.send_message?.label || 'Отправить сообщение', value: 'message', emoji: config.buttons?.send_message?.emoji || '✉️' }
  );
  const statusButton = new ButtonBuilder()
    .setCustomId('panel:pass_status')
    .setLabel('Статус проходок')
    .setEmoji('📋')
    .setStyle(ButtonStyle.Secondary);
  const bulkButton = new ButtonBuilder()
    .setCustomId('panel:bulk_access')
    .setLabel(config.buttons?.bulk_access?.label || 'Выдать проходку всем без неё')
    .setEmoji(config.buttons?.bulk_access?.emoji || '🎫')
    .setStyle(ButtonStyle.Primary);
  return [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(statusButton, bulkButton)];
}

function getPassStatus(userId) {
  const requests = store.requests.filter(r => r.userId === String(userId));
  if (requests.some(r => r.status === 'COMPLETED')) return true;
  return false;
}

async function showPassStatus(interaction) {
  if (!isPanelAdmin(interaction.user.id)) {
    return interaction.reply({ content: text('panel_no_permission'), ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const guild = await client.guilds.fetch(String(config.discord?.guild_id)).catch(() => null);
  if (!guild) return interaction.editReply('Не удалось найти SOURCE-сервер.');

  // Каждый раз заново получаем участников, чтобы список был актуальным.
  const members = await guild.members.fetch().catch(err => {
    console.error('[pass status] Не удалось получить участников:', err);
    return null;
  });
  if (!members) return interaction.editReply('Не удалось получить список участников сервера.');

  const roleIds = new Set(accessRoles);
  const eligible = [...members.values()]
    .filter(member => !member.user.bot && member.roles.cache.some(role => roleIds.has(role.id)))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'));

  if (!eligible.length) {
    return interaction.editReply({
      embeds: [embed('📋 Статус проходок', 'На сервере сейчас нет участников с настроенными ролями проходки.')] 
    });
  }

  const lines = eligible.map(member => {
    const issued = getPassStatus(member.id);
    return `${member} — ${issued ? '🟢 проходка выдана' : '🔴 проходка не выдана'}`;
  });

  // Discord ограничивает описание embed 4096 символами, поэтому делим длинный список на несколько embed.
  const chunks = [];
  let chunk = '';
  for (const line of lines) {
    if ((chunk + (chunk ? '\n' : '') + line).length > 3900) {
      chunks.push(chunk);
      chunk = line;
    } else {
      chunk += (chunk ? '\n' : '') + line;
    }
  }
  if (chunk) chunks.push(chunk);

  const embeds = chunks.map((description, index) =>
    embed(
      `📋 Статус проходок${chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : ''}`,
      description
    ).setFooter({ text: `Проверено участников с ролями: ${eligible.length}` })
  );

  // Один ответ Discord может содержать максимум 10 embeds.
  // При большом количестве участников отправляем первые 10 сразу, остальные отдельными followUp.
  await interaction.editReply({ embeds: embeds.slice(0, 10) });
  for (let i = 10; i < embeds.length; i += 10) {
    await interaction.followUp({ embeds: embeds.slice(i, i + 10), ephemeral: true }).catch(err =>
      console.warn('[pass status] followUp:', err.message)
    );
  }
}
async function bulkStartMissingPassFlows(interaction) {
  if (!isPanelAdmin(interaction.user.id)) {
    return interaction.reply({ content: text('panel_no_permission'), ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  const guild = await client.guilds.fetch(String(config.discord?.guild_id)).catch(() => null);
  if (!guild) return interaction.editReply(text('bulk_access_guild_error', 'Не удалось найти сервер.'));
  const members = await guild.members.fetch().catch(err => {
    console.error('[bulk access] member fetch:', err);
    return null;
  });
  if (!members) return interaction.editReply(text('bulk_access_members_error', 'Не удалось получить список участников.'));

  const roleTypes = config.discord?.role_access_types || {};
  const targets = [...members.values()].filter(member =>
    !member.user.bot && member.roles.cache.some(role => accessRoles.includes(role.id)) &&
    !getPassStatus(member.id) && !hasActiveRequest(member.id)
  );
  let started = 0;
  let failed = 0;
  for (const member of targets) {
    const roleId = accessRoles.find(id => member.roles.cache.has(id));
    const type = roleTypes[roleId] === 'free' ? 'free' : 'paid';
    if (await startNicknameFlow(member.id, type, 'role')) started++;
    else failed++;
  }
  return interaction.editReply(replace(text('bulk_access_result', 'Готово. Сообщение с просьбой ввести Minecraft-ник отправлено: {started}. Не удалось отправить: {failed}.'), {
    started, failed, total: targets.length
  }));
}

async function notifyRoleAdmins(member, eventType, roleNames) {
  const alertId = makeId();
  const gained = eventType === 'gained';
  const titleKey = gained ? 'role_gained_title' : 'role_lost_title';
  const descriptionKey = gained ? 'role_gained_description' : 'role_lost_description';
  const body = replace(text(descriptionKey, gained
    ? 'Участник {user_mention} получил роль проходки: {role_names}.'
    : 'Участник {user_mention} потерял все роли проходки ({role_names}). Проверьте и удалите его из Minecraft whitelist.'), {
    user_mention: `<@${member.id}>`, user_id: member.id, username: member.user.username,
    display_name: member.displayName, role_names: roleNames.join(', '), alert_id: alertId
  });
  const messageEmbed = embed(text(titleKey, gained ? 'Получена роль проходки' : 'Участник потерял проходку'), body,
    gained ? (config.colors?.success || '#57F287') : (config.colors?.error || '#ED4245'));
  const alert = { id: alertId, userId: String(member.id), type: eventType, status: gained ? 'NOTIFIED' : 'PENDING_REMOVAL',
    createdAt: new Date().toISOString(), completedAt: null, completedBy: null, adminMessages: [] };
  store.roleAlerts.push(alert);
  await saveStore();
  for (const adminId of ids(config.discord?.admin_ids)) {
    try {
      const user = await client.users.fetch(adminId);
      const components = gained ? [] : [buttonRow(
        `role_removed:${alertId}`, config.buttons?.confirm_removed?.label || 'Я удалил',
        config.buttons?.confirm_removed?.emoji || '✅', ButtonStyle.Danger
      )];
      const sent = await user.send({ embeds: [messageEmbed], components });
      alert.adminMessages.push({ userId: adminId, channelId: sent.channelId, messageId: sent.id });
    } catch (e) { console.warn(`[role ${eventType} DM] ${adminId}: ${e.message}`); }
  }
  await saveStore();
}

async function confirmRoleRemoved(interaction, alertId) {
  const alert = store.roleAlerts.find(item => item.id === alertId && item.type === 'lost');
  if (!alert) return interaction.reply({ content: text('role_alert_not_found', 'Это уведомление уже не найдено.'), ephemeral: true });
  if (!isAdmin(interaction.user.id)) return interaction.reply({ content: text('panel_no_permission'), ephemeral: true });
  if (alert.status === 'REMOVED') return interaction.reply({ content: replace(text('role_already_removed', 'Удаление уже подтвердил {admin_mention}.'), { admin_mention: `<@${alert.completedBy}>` }), ephemeral: true });

  alert.status = 'REMOVED';
  alert.completedBy = interaction.user.id;
  alert.completedAt = new Date().toISOString();
  await saveStore();
  const body = replace(text('role_removed_description', '✅ {admin_mention} подтвердил: игрок {user_mention} удалён из Minecraft whitelist.'), {
    admin_mention: `<@${interaction.user.id}>`, user_mention: `<@${alert.userId}>`, user_id: alert.userId
  });
  const doneEmbed = embed(text('role_removed_title', 'Удаление из whitelist подтверждено'), body, config.colors?.success || '#57F287');
  const disabledRow = buttonRow(`role_removed:${alert.id}`, config.buttons?.confirm_removed?.label || 'Я удалил', config.buttons?.confirm_removed?.emoji || '✅', ButtonStyle.Danger, true);
  await interaction.update({ embeds: [doneEmbed], components: [disabledRow] }).catch(async () => {
    await interaction.reply({ content: text('role_removed_confirmed', 'Отметка сохранена, но не удалось обновить сообщение.'), ephemeral: true }).catch(() => {});
  });
  for (const item of alert.adminMessages || []) {
    if (item.messageId === interaction.message.id) continue;
    try {
      const user = await client.users.fetch(item.userId);
      const channel = await user.createDM();
      const msg = await channel.messages.fetch(item.messageId);
      await msg.edit({ embeds: [doneEmbed], components: [disabledRow] });
    } catch (e) { console.warn(`[edit role alert] ${item.userId}: ${e.message}`); }
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (minutes) parts.push(`${minutes} мин`);
  if (seconds || !minutes) parts.push(`${seconds} с`);
  return parts.join(' ');
}

// Отправляет правила в ЛС по частям, чтобы уложиться в лимиты Discord.
function rulesMessageEmbeds() {
  return buildRulesMessages().map(group => group.map(item => new EmbedBuilder()
    .setColor(item.color)
    .setTitle(item.title)
    .setDescription(item.description)));
}

async function dmRules(user) {
  const messages = rulesMessageEmbeds();

  for (const embeds of messages) {
    for (const embed of embeds) {
      try {
        await user.send({ embeds: [embed] });
      } catch (e) {
        console.warn(
          `[rules] Не удалось отправить правила ${user.id}: ${e.message}`
        );
        return false;
      }
    }
  }

  return true;
}


async function sendRules(message) {
  if (config.rules?.enabled === false) return;
  const userId = message.author.id;
  const cooldownMs = Number(config.rules?.cooldown_seconds ?? 100) * 1000;
  const remaining = (Number(store.cooldowns.rules?.[userId]) || 0) + cooldownMs - Date.now();
  if (remaining > 0) {
    await replyTemp(message, replace(text('rules_cooldown', 'Правила можно запросить снова через {time}.'), { time: formatDuration(remaining) }));
    return;
  }
  const sent = await dmRules(message.author);
  if (!sent) {
    await replyTemp(message, text('rules_dm_failed', 'Не удалось отправить правила в личные сообщения.'));
    return;
  }
  store.cooldowns.rules ??= {};
  store.cooldowns.rules[userId] = Date.now();
  await saveStore();
  await replyTemp(message, text('rules_sent', 'Правила отправлены в личные сообщения.'));
}

// Короткий ответ в канале, который удаляется сам, чтобы не засорять чат.
async function replyTemp(message, content) {
  const notice = await message.reply(content).catch(() => null);
  if (!notice || config.rules?.delete_notice === false) return notice;
  setTimeout(() => notice.delete().catch(() => {}), Number(config.rules?.notice_delete_after_ms ?? 5000));
  return notice;
}

async function handleRulesSlash(interaction) {
  if (config.rules?.enabled === false) {
    return interaction.reply({ content: text('rules_disabled', 'Правила сейчас недоступны.'), ephemeral: true });
  }
  const userId = interaction.user.id;
  const cooldownMs = Number(config.rules?.cooldown_seconds ?? 100) * 1000;
  const remaining = (Number(store.cooldowns.rules?.[userId]) || 0) + cooldownMs - Date.now();
  if (remaining > 0) {
    return interaction.reply({ content: replace(text('rules_cooldown', 'Правила можно запросить снова через {time}.'), { time: formatDuration(remaining) }), ephemeral: true });
  }
  const messages = rulesMessageEmbeds();
  await interaction.reply({ embeds: messages[0], ephemeral: true });
  for (const embeds of messages.slice(1)) {
    await interaction.followUp({ embeds, ephemeral: true }).catch(err => console.warn('[rules] followUp:', err.message));
  }
  store.cooldowns.rules ??= {};
  store.cooldowns.rules[userId] = Date.now();
  await saveStore();
}

async function showPanel(message) {
  if (!isGuild(message.guildId)) return message.reply(text('panel_wrong_server'));
  if (!isPanelAdmin(message.author.id)) return message.reply(text('panel_no_permission'));
  await message.reply({ embeds: [panelEmbed()], components: panelComponents() });
}
async function completeRequest(interaction, requestId) {
  const req = store.requests.find(r => r.id === requestId);
  if (!req) return interaction.reply({ content: 'Заявка не найдена.', ephemeral: true });
  if (!isAdmin(interaction.user.id)) return interaction.reply({ content: text('panel_no_permission'), ephemeral: true });
  if (req.status === 'COMPLETED') return interaction.reply({ content: replace(text('request_already_completed'), { admin_mention: `<@${req.completedBy}>` }), ephemeral: true });
  if (req.status !== 'PENDING_WHITELIST') return interaction.reply({ content: 'Эта заявка больше не ожидает подтверждения.', ephemeral: true });
  // Synchronous status change before any awaits prevents two button clicks completing the same request.
  req.status = 'COMPLETED'; req.completedBy = interaction.user.id; req.completedAt = new Date().toISOString();
  await saveStore();
  const body = replace(text('request_completed_description'), { admin_mention: `<@${interaction.user.id}>`, user_mention: `<@${req.userId}>`, minecraft_nick: req.minecraftNick, access_type: accessLabel(req.type), request_id: req.id });
  const doneEmbed = embed(text('request_completed_title', 'Игрок добавлен в вайтлист'), body, config.colors?.success || '#57F287');
  await interaction.update({ embeds: [doneEmbed], components: [buttonRow(`wl_done:${req.id}`, config.buttons?.confirm_added?.label || 'Я добавил', config.buttons?.confirm_added?.emoji || '✅', ButtonStyle.Success, true)] }).catch(async () => {
    await interaction.reply({ content: 'Заявка закрыта, но не удалось обновить это сообщение.', ephemeral: true }).catch(() => {});
  });
  for (const item of req.adminMessages || []) {
    if (item.messageId === interaction.message.id) continue;
    try {
      const user = await client.users.fetch(item.userId);
      const channel = await user.createDM();
      const msg = await channel.messages.fetch(item.messageId);
      await msg.edit({ embeds: [doneEmbed], components: [buttonRow(`wl_done:${req.id}`, config.buttons?.confirm_added?.label || 'Я добавил', config.buttons?.confirm_added?.emoji || '✅', ButtonStyle.Success, true)] });
    } catch (e) { console.warn(`[edit admin message] ${item.userId}: ${e.message}`); }
  }
  if (config.notifications?.dm_member_on_completion !== false) {
    const user = await client.users.fetch(req.userId).catch(() => null);

    if (user) {
      const sent = await dmUser(
       user,
        replace(text('dm_completed'), {
          minecraft_nick: req.minecraftNick
        })
     );

      if (sent && config.rules?.enabled !== false) {
       await dmRules(user);
     }
    }
  }
}
function panelModal(type) {
  const modal = new ModalBuilder()
    .setCustomId(`panelmodal:${type}`)
    .setTitle(type === 'message' ? 'Отправить сообщение' : 'Выдать проходку');

  if (type === 'message') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('target')
          .setLabel('Discord ID пользователя')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('body')
          .setLabel('Текст сообщения')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1800)
      )
    );
  } else {
    // Для платной/бесплатной выдачи в панели нужен только Discord ID.
    // Minecraft-ник пользователь вводит сам в ЛС боту.
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('target')
          .setLabel('Discord ID пользователя')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );
  }

  return modal;
}
async function registerRulesSlash() {
  if (config.rules?.register_slash_command === false) return;
  const guildId = String(config.discord?.guild_id || '');
  if (!guildId) return;
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.commands.create({
      name: 'правила',
      description: 'Показать правила проекта (видно только тебе)'
    });
    console.log('[rules] Slash-команда /правила зарегистрирована.');
  } catch (e) {
    console.warn(`[rules] Не удалось зарегистрировать slash-команду: ${e.message}`);
  }
}

client.once(Events.ClientReady, c => {
  console.log(replace(text('bot_ready', 'Бот запущен: {bot_tag}'), { bot_tag: c.user.tag }));
  registerRulesSlash();
});
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    if (!isGuild(newMember.guild.id)) return;
    const hadAccessRole = oldMember.roles.cache.some(role => accessRoles.includes(role.id));
    const hasAccessRole = newMember.roles.cache.some(role => accessRoles.includes(role.id));
    const roleTypes = config.discord?.role_access_types || {};
    if (!hadAccessRole && hasAccessRole) {
      const gained = accessRoles.filter(id => !oldMember.roles.cache.has(id) && newMember.roles.cache.has(id));
      await notifyRoleAdmins(newMember, 'gained', gained.map(id => newMember.guild.roles.cache.get(id)?.name || id));
      if (config.flow?.auto_dm_on_role !== false && !getPassStatus(newMember.id) && !hasActiveRequest(newMember.id)) {
        const type = gained.map(id => roleTypes[id]).find(v => v === 'free') || 'paid';
        await startNicknameFlow(newMember.id, type, 'role');
      }
    } else if (hadAccessRole && !hasAccessRole) {
      const lost = accessRoles.filter(id => oldMember.roles.cache.has(id));
      await notifyRoleAdmins(newMember, 'lost', lost.map(id => oldMember.guild.roles.cache.get(id)?.name || id));
    }
  } catch (e) { console.error('[role update]', e); }
});
client.on(Events.MessageCreate, async message => {
  try {
    if (message.author.bot) return;
    const content = message.content.trim().toLowerCase();
    const prefix = config.bot?.prefix || '!';
    const rulesAliases = [config.bot?.rules_command || 'правила', ...(config.rules?.aliases || [])].map(a => `${prefix}${String(a).toLowerCase()}`);
    if (message.guild && rulesAliases.includes(content)) return await sendRules(message);
    if (message.guild && content === `${prefix}${config.bot?.panel_command || 'панель'}`) return await showPanel(message);
    if (!message.guild) await handleNicknameMessage(message);
  } catch (e) { console.error('[message]', e); }
});
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'правила') {
      return await handleRulesSlash(interaction);
    }
    if (interaction.isButton() && interaction.customId === 'panel:pass_status') {
      return await showPassStatus(interaction);
    }
    if (interaction.isButton() && interaction.customId === 'panel:bulk_access') {
      return await bulkStartMissingPassFlows(interaction);
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'panel:action') {
      if (!isPanelAdmin(interaction.user.id)) return interaction.reply({ content: text('panel_no_permission'), ephemeral: true });
      const choice = interaction.values[0];
      if (choice === 'paid' && config.flow?.allow_paid_access === false) return interaction.reply({ content: 'Платная выдача отключена в конфиге.', ephemeral: true });
      if (choice === 'free' && config.flow?.allow_free_access === false) return interaction.reply({ content: 'Бесплатная выдача отключена в конфиге.', ephemeral: true });
      return interaction.showModal(panelModal(choice));
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('panelmodal:')) {
      if (!isPanelAdmin(interaction.user.id)) return interaction.reply({ content: text('panel_no_permission'), ephemeral: true });
      const kind = interaction.customId.split(':')[1];
      const targetId = interaction.fields.getTextInputValue('target').trim();
      if (!/^\d{17,20}$/.test(targetId)) return interaction.reply({ content: 'Укажи корректный Discord ID пользователя.', ephemeral: true });
      if (kind === 'message') {
        if (config.flow?.allow_custom_message === false) return interaction.reply({ content: 'Отправка сообщений отключена в конфиге.', ephemeral: true });
        const target = await client.users.fetch(targetId).catch(() => null);
        if (!target) return interaction.reply({ content: 'Пользователь не найден.', ephemeral: true });
        const ok = await dmUser(target, interaction.fields.getTextInputValue('body'));
        return interaction.reply({ content: ok ? text('custom_message_sent', 'Сообщение отправлено.') : text('custom_message_failed', 'Не удалось отправить сообщение.'), ephemeral: true });
      }
      const target = await client.users.fetch(targetId).catch(() => null);
      if (!target) return interaction.reply({ content: 'Пользователь не найден.', ephemeral: true });

      if (hasActiveRequest(targetId)) {
        return interaction.reply({ content: text('request_already_exists'), ephemeral: true });
      }

      // При ручной выдаче администратор вводит только Discord ID.
      // Бот сам пишет пользователю в ЛС и получает Minecraft-ник там.
      await interaction.deferReply({ ephemeral: true });
      const started = await startNicknameFlow(
        targetId,
        kind,
        'manual',
        interaction.user.id
      );

      return interaction.editReply(
        started
          ? text('panel_request_created', 'Пользователю отправлено сообщение с просьбой указать Minecraft-ник.')
          : 'Не удалось написать пользователю в ЛС. Проверьте, разрешены ли ему личные сообщения от бота.'
      );
    }
    if (interaction.isButton() && interaction.customId.startsWith('wl_done:')) {
      const requestId = interaction.customId.slice('wl_done:'.length);
      return await completeRequest(interaction, requestId);
    }
    if (interaction.isButton() && interaction.customId.startsWith('role_removed:')) {
      const alertId = interaction.customId.slice('role_removed:'.length);
      return await confirmRoleRemoved(interaction, alertId);
    }
  } catch (e) {
    console.error('[interaction]', e);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) await interaction.reply({ content: text('generic_error', 'Произошла ошибка.'), ephemeral: true }).catch(() => {});
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error('Не найден DISCORD_TOKEN. Создай .env на основе .env.example и вставь токен бота.');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
