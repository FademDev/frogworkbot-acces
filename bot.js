require('dotenv').config({ override: true });
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, Events, PermissionFlagsBits, ApplicationCommandOptionType
} = require('discord.js');
const { buildRulesMessages } = require('./rules.js');
const { rconDiagnose, rconFindEndpoint, rconSend, rconPreflight } = require('./rcon.js');
const { interpretWhitelistResponse, buildTestNicknames, formatBatchReport, formatTestReport, compareVerdict, isValidMinecraftNick } = require('./whitelist-utils.js');
const {
  voteSecretHash, voteCounts, voteTotals, isVoteOpen, isVoteAnonymous, formatVoteResults, buildVoteButtons
} = require('./voting.js');

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
// Анонимные голосования: голоса хранятся как хэши от user id + соль голосования,
// чтобы даже при ручном просмотре data/requests.json нельзя было узнать, кто как голосовал.
if (!Array.isArray(store.votes)) store.votes = [];
// Журнал автотестов вайтлиста (какие ники добавлялись и что ответил сервер).
if (!Array.isArray(store.whitelistTests)) store.whitelistTests = [];
// Активные сессии меню панели: чей слеш-вызов сейчас обслуживается.
// Панель эфемерная, но customId кнопок общий, поэтому доступ проверяется
// и по правам (isPanelAdmin), и по владельцу сессии.
if (!store.panelSessions || typeof store.panelSessions !== 'object') store.panelSessions = {};
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
// Задержка с ожиданием между ретраями, учитывающая rate-limit Discord (429).
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Отправка ЛС с ретраями. Обрабатывает rate-limit (429 Retry-After) и транзиентные
// ошибки сети, чтобы бот не "протупливал" и не терял сообщения при временных сбоях.
// Не ретраится, только если пользователь запретил ЛС (DiscordError 50007) — это бессмысленно.
async function dmUser(user, content, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (attempt > 1) {
      const backoff = 1000 * Math.pow(2, attempt - 2);
      console.warn(`[dm] Повторная попытка написать ${user.id} (попытка ${attempt}/${retries}) через ${backoff} мс.`);
      await sleep(backoff);
    }
    try {
      await user.send(content);
      return true;
    } catch (e) {
      lastError = e;
      // Rate-limit: ждём столько, сколько попросил Discord.
      if (e?.code === 429 || e?.status === 429) {
        const waitMs = Number(e?.retryAfter) * 1000 || 5000;
        console.warn(`[dm] Rate-limit при ЛС ${user.id}: жду ${waitMs} мс.`);
        await sleep(waitMs);
        continue;
      }
      // Пользователь запретил ЛС или пользователь не найден — ретраить бессмысленно.
      if (e?.code === 50007 || e?.code === 10013 || e?.code === 50035) {
        console.warn(`[dm] Не удалось написать ${user.id} (ЛС недоступны): ${e.message}`);
        return false;
      }
      // Другие ошибки (сеть, 5xx, таймауты) — пробуем ещё раз.
      if (attempt === retries) {
        console.warn(`[dm] Не удалось написать ${user.id} после ${retries} попыток: ${e.message}`);
      }
    }
  }
  return false;
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

async function notifyAdminsAutoCompleted(req, rconResult) {
  const title = text('admin_auto_added_title', '✅ Игрок автоматически добавлен в вайтлист');
  const body = replace(text('admin_auto_added_description',
    'Бот выполнил команду на сервере.\n\n**Discord:** {user_mention}\n**Discord ID:** `{user_id}`\n**Minecraft ник:** `{minecraft_nick}`\n**Тип:** {access_type}\n**Источник:** {source}\n**Команда:** `{command}`\n**Ответ:** `{response}`\n**Заявка:** `{request_id}`'), {
    user_mention: `<@${req.userId}>`, user_id: req.userId, minecraft_nick: req.minecraftNick,
    access_type: accessLabel(req.type), source: req.source === 'role' ? 'Выдача по роли' : 'Ручная выдача',
    command: rconResult.command || '—', response: rconResult.response || '—', request_id: req.id
  });
  const message = embed(title, body, config.colors?.success || '#57F287')
    .setFooter({ text: replace(text('admin_request_footer', 'Заявка {request_id}'), { request_id: req.id }) });
  for (const adminId of ids(config.discord?.admin_ids)) {
    try {
      const user = await client.users.fetch(adminId);
      const sent = await user.send({ embeds: [message] });
      req.adminMessages.push({ userId: adminId, channelId: sent.channelId, messageId: sent.id });
    } catch (e) {
      console.warn(`[admin DM auto] ${adminId}: ${e.message}`);
    }
  }
  await saveStore();
}

async function notifyAdminsManualReview(req, reason, rconResponse) {
  const title = text('admin_manual_review_title', '⚠️ Требуется ручное добавление в вайтлист');
  const body = replace(text('admin_manual_review_description',
    'Автоматическое добавление не удалось.\n\n**Discord:** {user_mention}\n**Discord ID:** `{user_id}`\n**Minecraft ник:** `{minecraft_nick}`\n**Тип:** {access_type}\n**Причина:** {reason}\n**Ответ сервера:** `{rcon_response}`\n**Заявка:** `{request_id}`'), {
    user_mention: `<@${req.userId}>`, user_id: req.userId, minecraft_nick: req.minecraftNick,
    access_type: accessLabel(req.type), reason: reason || '—', rcon_response: rconResponse || '—', request_id: req.id
  });
  const message = embed(title, body, config.colors?.warning || '#FEE75C');
  const row = buttonRow(`wl_done:${req.id}`, config.buttons?.confirm_added?.label || 'Я добавил', config.buttons?.confirm_added?.emoji || '✅');
  req.adminMessages = [];
  for (const adminId of ids(config.discord?.admin_ids)) {
    try {
      const user = await client.users.fetch(adminId);
      const sent = await user.send({ embeds: [message], components: [row] });
      req.adminMessages.push({ userId: adminId, channelId: sent.channelId, messageId: sent.id });
    } catch (e) {
      console.warn(`[manual review DM] ${adminId}: ${e.message}`);
    }
  }
  await saveStore();
}


async function createRequest({ userId, minecraftNick, type, reason = '', source = 'role', createdBy = null }) {
  const req = { id: makeId(), userId: String(userId), minecraftNick, type, reason, source, createdBy,
    status: 'PENDING_WHITELIST', createdAt: new Date().toISOString(), completedAt: null, completedBy: null, adminMessages: [] };
  store.requests.push(req);
  await saveStore();

  const user = await client.users.fetch(String(userId)).catch(() => null);

  try {
    if (config.rcon?.auto_whitelist !== false) {
      const rcon = await executeWhitelistCommand(minecraftNick);
      req.rconResult = { success: rcon.success, response: rcon.response, error: rcon.error, command: rcon.command, at: new Date().toISOString() };

      if (rcon.success) {
        req.status = 'COMPLETED';
        req.completedAt = new Date().toISOString();
        req.completedBy = 'auto-rcon';
        await saveStore();
        try { await notifyAdminsAutoCompleted(req, rcon); } catch (e) { console.error('[notifyAdminsAutoCompleted]', e); }
        if (user) await dmUser(user, replace(text('request_created'), { minecraft_nick: minecraftNick, request_id: req.id }));
        return req;
      }

      if (config.rcon?.manual_review_on_rcon_fail) {
        req.status = 'PENDING_REVIEW';
        await saveStore();
        try { await notifyAdminsManualReview(req, rcon.error || 'rcon_failed', rcon.response); } catch (e) { console.error('[notifyAdminsManualReview]', e); }
      } else {
        try { await notifyAdmins(req); } catch (e) { console.error('[notifyAdmins]', e); }
      }
      if (user) await dmUser(user, replace(text('request_pending_review', 'Заявка принята, но автоматическое добавление не удалось. Администратор проверит её вручную: `{minecraft_nick}`'), { minecraft_nick: minecraftNick }));
      return req;
    }

    await notifyAdmins(req);
    if (user) await dmUser(user, replace(text('request_created'), { minecraft_nick: minecraftNick, request_id: req.id }));
    return req;
  } catch (e) {
    req.status = 'FAILED';
    req.failedAt = new Date().toISOString();
    req.failReason = e.message || 'unknown';
    await saveStore();
    throw e;
  }
}
function hasActiveRequest(userId) {
  const now = Date.now();
  const staleMs = 10 * 60 * 1000; // 10 минут — если заявка висит дольше, считаем её "зависшей"
  return store.requests.some(r => {
    if (r.userId !== String(userId)) return false;
    if (!['PENDING_NICKNAME', 'VALIDATING', 'PENDING_WHITELIST', 'PENDING_REVIEW'].includes(r.status)) return false;
    if (['PENDING_WHITELIST', 'PENDING_REVIEW'].includes(r.status) && r.createdAt && (now - new Date(r.createdAt).getTime()) > staleMs) return false;
    return true;
  });
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
  // Базовый фильтр по запрещённым словам/паттернам — до проверки формата.
  const filter = checkNicknameFilter(nick);
  if (!filter.ok) return { ok: false, reason: 'filtered' };

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
    const key = check.reason === 'format' ? 'nickname_invalid_format' : check.reason === 'not_found' ? 'nickname_profile_not_found' : check.reason === 'filtered' ? 'nickname_filtered' : 'nickname_check_failed';
    await dmUser(message.author, replace(text(key), { nickname: nick }));
    return true;
  }
  const normalized = nick;
  if (config.flow?.prevent_duplicate_minecraft_nick && store.requests.some(r => r.minecraftNick.toLowerCase() === normalized.toLowerCase() && ['PENDING_WHITELIST', 'COMPLETED', 'PENDING_REVIEW'].includes(r.status))) {
    await dmUser(message.author, text('nickname_already_used', 'Этот Minecraft-ник уже указан в другой заявке. Обратись к администратору, если это ошибка.'));
    return true;
  }
  await clearSession(message.author.id);
  try {
    await createRequest({ userId: message.author.id, minecraftNick: normalized, type: session.type, reason: session.reason, source: session.source, createdBy: session.createdBy });
  } catch (e) {
    console.error('[createRequest]', e);
    await dmUser(message.author, text('generic_error', 'Произошла ошибка при создании заявки. Попробуй позже.'));
    return true;
  }
  return true;
}

function checkNicknameFilter(nick) {
  const filter = config.nickname_filter || {};
  if (filter.enabled === false) return { ok: true };

  const raw = String(nick).toLowerCase();
  const stripped = raw.replace(/[^a-z0-9]/g, '');

  const terms = Array.isArray(filter.terms) ? filter.terms.map(t => String(t).toLowerCase()) : [];
  const blocked = Array.isArray(filter.blocked_usernames) ? filter.blocked_usernames.map(t => String(t).toLowerCase()) : [];
  const patterns = Array.isArray(filter.reserved_patterns) ? filter.reserved_patterns : [];

  if (blocked.includes(raw)) return { ok: false, reason: 'exact' };

  for (const term of terms) {
    if (!term) continue;
    if (raw.includes(term)) return { ok: false, reason: 'term' };
    if (filter.strip_separator_check !== false && stripped.includes(term.replace(/[^a-z0-9]/g, ''))) {
      return { ok: false, reason: 'stripped_term' };
    }
  }

  for (const pat of patterns) {
    try {
      const rx = new RegExp(pat, 'i');
      if (rx.test(raw) || rx.test(stripped)) return { ok: false, reason: 'pattern' };
    } catch (e) {
      console.warn(`[nickname filter] Некорректный паттерн "${pat}": ${e.message}`);
    }
  }
  return { ok: true };
}

// Отправка команды на сервер через RCON.
// Вся низкоуровневая работа (TCP, AUTH, обработка ошибок сети и «не-RCON порта»)
// вынесена в rcon.js — раньше сбой RCON мог уронить весь процесс бота.
async function sendRconCommand(command) {
  return rconSend(config.rcon || {}, command, console);
}

// Разбор ответа сервера и генерацию тестовых ников — см. whitelist-utils.js.
// Здесь только вызовы RCON: всё, что можно проверить тестами, вынесено в модуль.
async function executeWhitelistCommand(nick, { template = null } = {}) {
  const tpl = String(template || config.rcon?.command_template || 'whitelist add {nick}');
  const command = tpl.replace(/\{nick\}/g, nick);
  const rcon = await sendRconCommand(command);

  if (!rcon.ok) {
    return { success: false, response: rcon.response, error: rcon.error, code: rcon.code, command, port: rcon.port };
  }

  const verdict = interpretWhitelistResponse(rcon.response, {
    successKeywords: config.rcon?.success_keywords || [],
    failureKeywords: config.rcon?.failure_keywords || []
  });
  return {
    success: verdict.success,
    already: Boolean(verdict.already),
    response: rcon.response,
    error: verdict.success ? null : verdict.reason,
    code: verdict.success ? 'ok' : 'server_rejected',
    command,
    port: rcon.port
  };
}

async function executeWhitelistRemove(nick) {
  const template = String(config.rcon?.remove_command_template || 'whitelist remove {nick}');
  const command = template.replace(/\{nick\}/g, nick);
  const rcon = await sendRconCommand(command);
  if (!rcon.ok) return { success: false, response: rcon.response, error: rcon.error, code: rcon.code, command, port: rcon.port };
  const lower = String(rcon.response || '').toLowerCase();
  const removed = lower.includes('removed') || lower.includes('удал');
  return { success: removed, response: rcon.response, error: removed ? null : 'not_removed', code: removed ? 'ok' : 'server_rejected', command, port: rcon.port };
}
function panelEmbed(userId = null) {
  const owner = userId ? `\n\n*Панель вызвана <@${userId}>. Её видит только этот администратор.*` : '';
  return embed(text('panel_title', 'Панель управления проходками'), `${text('panel_description', 'Выбери действие.')}${owner}`).setFooter({
    text: config.votes?.enabled === false ? 'Голосования отключены в конфиге' : 'Голосования анонимные: никто не увидит твой голос'
  });
}
function panelComponents() {
  const options = [
    { label: config.buttons?.paid_access?.label || 'Платная проходка', value: 'paid', emoji: config.buttons?.paid_access?.emoji || '💳' },
    { label: config.buttons?.free_access?.label || 'Бесплатная проходка', value: 'free', emoji: config.buttons?.free_access?.emoji || '🎁' },
    { label: config.buttons?.send_message?.label || 'Отправить сообщение', value: 'message', emoji: config.buttons?.send_message?.emoji || '✉️' }
  ];
  const select = new StringSelectMenuBuilder().setCustomId('panel:action').setPlaceholder('Выбери действие').addOptions(...options);
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
  return [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(statusButton, bulkButton), panelVoteRow()];
}

// Отдельная строка кнопок панели: голосования и диагностика RCON.
// Схлопывать её с остальными нельзя — Discord разрешает максимум 5 кнопок в строке.
function panelVoteRow() {
  const row = new ActionRowBuilder();
  if (config.votes?.enabled !== false) {
    row.addComponents(
      new ButtonBuilder().setCustomId('panel:vote_new').setLabel('Начать голосование').setEmoji('🗳️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('panel:votes').setLabel('Голосования').setEmoji('📊').setStyle(ButtonStyle.Secondary)
    );
  }
  row.addComponents(
    new ButtonBuilder().setCustomId('panel:rcon_test').setLabel('Диагностика RCON').setEmoji('🩺').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel:test_whitelist').setLabel('Тест вайтлиста').setEmoji('🧪').setStyle(ButtonStyle.Secondary)
  );
  return row;
}

// Панель — админский инструмент, поэтому каждое действие из неё проверяет права.
// Возвращает true, если действие разрешено; иначе сам отвечает пользователю.
function denyIfNotPanelAdmin(interaction) {
  if (isPanelAdmin(interaction.user.id)) return false;
  const reply = { content: text('panel_no_permission', '⛔ У тебя нет прав для использования этой панели.'), ephemeral: true };
  if (interaction.replied || interaction.deferred) interaction.followUp(reply).catch(() => {});
  else interaction.reply(reply).catch(() => {});
  return true;
}

function getPassStatus(userId) {
  const requests = store.requests.filter(r => r.userId === String(userId));
  if (requests.some(r => r.status === 'COMPLETED')) return true;
  return false;
}

// ------------------------------- RCON / whitelist -------------------------------

// Логгер для rcon.js: обычные строки пишем всегда, подробные — только при
// rcon.debug.enabled (режим отладки включается в config.json).
const rconLog = {
  log(message) { if (config.rcon?.debug?.verbose === true) console.log(`[rcon:debug] ${message}`); },
  warn(message) { console.warn(message); },
  error(message) { console.error(message); }
};

// Журналирует попытку RCON в data/requests.json, чтобы после перезапуска бота
// можно было посмотреть историю: что отправляли и что ответил сервер.
async function logRconTest(entry) {
  store.whitelistTests.push({ at: new Date().toISOString(), ...entry });
  if (store.whitelistTests.length > 200) store.whitelistTests = store.whitelistTests.slice(-200);
  await saveStore();
}

function rconConfigForPort(port) {
  return { ...(config.rcon || {}), port };
}

// Пакетный тест: добавляет несколько тестовых ников подряд (Test1, Test2, Test3)
// и возвращает сводку. Так видно, что RCON работает стабильно, а не один раз.
async function runWhitelistBatch(count = 3, { template = null } = {}) {
  const existing = store.whitelistTests.map(t => t.nick);
  const nicks = buildTestNicknames(count, existing);
  const results = [];
  for (const nick of nicks) {
    console.log(`[whitelist test] RCON-тест для ника ${nick}`);
    results.push(await runWhitelistTest(nick, { template }));
  }
  const passed = results.filter(r => r.ok).length;
  return { nicks, results, passed, total: results.length, ok: passed === results.length && passed > 0 };
}

// Сравнение кастомной команды (zwl) и штатной (whitelist) — чтобы понять,
// проблема в плагине или в RCON. Возвращает два набора отчётов.
async function runWhitelistCommandComparison(count = 2) {
  const existingZwl = store.whitelistTests.map(t => t.nick);
  const zwlNicks = buildTestNicknames(count, existingZwl, 'Test');
  const vanillaNicks = buildTestNicknames(count, [...existingZwl, ...zwlNicks], 'WlTest');
  const custom = [];
  const vanilla = [];
  for (let i = 0; i < count; i++) {
    if (zwlNicks[i]) custom.push(await runWhitelistTest(zwlNicks[i], { template: config.rcon?.command_template || 'zwl add {nick}' }));
    if (vanillaNicks[i]) vanilla.push(await runWhitelistTest(vanillaNicks[i], { template: config.rcon?.vanilla_command_template || 'whitelist add {nick}' }));
  }
  const passed = arr => arr.filter(r => r.ok).length;
  return { custom, vanilla, zwlPassed: passed(custom), vanillaPassed: passed(vanilla), count };
}

// Добавляет один тестовый ник в вайтлист и возвращает подробный шаг-отчёт.
async function runWhitelistTest(nick, { port = null, template = null } = {}) {
  const cfg = port ? { ...(config.rcon || {}), port } : (config.rcon || {});
  const report = { nick, port: Number(cfg.port) || 25746, steps: [], ok: false, response: null, command: null, testedAt: new Date().toISOString() };
  const push = (name, ok, detail) => report.steps.push({ name, ok: Boolean(ok), detail: String(detail ?? '').slice(0, 400) });

  push('Конфиг', true,
    `host=${cfg.host} port=${cfg.port} команда="${template || cfg.command_template}" auto_whitelist=${cfg.auto_whitelist} dry_run=${Boolean(cfg.dry_run)} debug=${Boolean(config.rcon?.debug?.enabled)}`);

  // Шаг 1-3: TCP, AUTH и пробная команда.
  const diagnose = await rconDiagnose(cfg, console);
  report.port = diagnose.port;
  push(`TCP ${diagnose.host}:${diagnose.port}`, diagnose.tcp?.ok,
    diagnose.tcp?.ok ? `порт открыт за ${diagnose.tcp.ms} мс` : `${diagnose.tcp?.code}: ${diagnose.message}`);

  if (!diagnose.tcp?.ok) {
    push('AUTH', false, 'пропущено — TCP-соединение не установлено');
    push('Итог', false, `${diagnose.message} → проблема на стороне хостинга (RCON выключен или порт не проброшен).`);
    await logRconTest({ nick, port: report.port, ok: false, stage: 'tcp', code: diagnose.code, message: diagnose.message });
    return report;
  }
  push('AUTH', diagnose.auth, diagnose.auth ? 'пароль принят' : diagnose.message);
  if (!diagnose.auth) {
    push('Итог', false, `${diagnose.message} → порт живой и это RCON, значит неверный пароль.`);
    await logRconTest({ nick, port: report.port, ok: false, stage: 'auth', code: diagnose.code, message: diagnose.message });
    return report;
  }
  push(`Пробная команда "${diagnose.command}"`, diagnose.ok,
    diagnose.ok ? `"${diagnose.response}"` : diagnose.message);

  // Шаг 4: реальное добавление тестового ника.
  const result = await executeWhitelistCommand(nick, { template });
  report.command = result.command;
  report.response = result.response;
  report.ok = result.success;
  push(`Команда "${result.command}"`, result.success,
    result.success
      ? `"${result.response || 'пустой ответ'}"${result.already ? ' — ник уже был в вайтлисте' : ''}`
      : `${result.error} — ${result.response || 'нет ответа'}`);
  push('Итог', result.success,
    result.success
      ? 'ник принят сервером'
      : 'сервер не подтвердил добавление — добавь вручную и проверь команду zwl/whitelist');

  await logRconTest({
    nick, port: report.port, ok: result.success, stage: 'whitelist',
    command: result.command, response: result.response, error: result.error
  });
  return report;
}

// Диагностика RCON для админа: шаги + вердикт «бот или хостинг».
async function showRconDiagnostics(interaction) {
  if (denyIfNotPanelAdmin(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  const cfg = config.rcon || {};
  const debugOn = Boolean(cfg.debug?.enabled) || ['1', 'true'].includes(String(process.env.RCON_DEBUG || '').toLowerCase());
  const probe = await rconDiagnose(cfg, console);
  const password = process.env[cfg.password_env || 'RCON_PASSWORD'];

  const steps = [
    {
      name: 'Пароль',
      ok: probe.passwordPresent,
      detail: probe.passwordPresent ? `переменная ${probe.passwordEnv} найдена (длина ${String(password).length})` : `нет ${probe.passwordEnv} в .env`
    },
    {
      name: `TCP ${probe.host}:${probe.port}`,
      ok: Boolean(probe.tcp?.ok),
      detail: probe.tcp?.ok ? `порт открыт за ${probe.tcp.ms} мс` : `${probe.tcp?.code}: ${probe.message}`
    }
  ];
  if (probe.tcp?.ok) {
    steps.push({ name: 'AUTH', ok: Boolean(probe.auth), detail: probe.auth ? 'пароль принят сервером' : probe.message });
    steps.push({ name: `Команда "${probe.command}"`, ok: probe.ok, detail: probe.ok ? `"${String(probe.response).slice(0, 120)}"` : probe.message });
  }

  const body = steps.map(s => `${s.ok ? '✅' : '❌'} **${s.name}** — ${String(s.detail).slice(0, 300)}`).join('\n');

  let verdict;
  if (probe.ok) {
    verdict = '🟢 **RCON бота в порядке.** Порт открыт, пароль принят, команды выполняются.';
  } else if (!probe.tcp?.ok) {
    verdict = '🔴 **Проблема на стороне хостинга.** Порты бота не достучались до сервера: RCON выключен в панели или порт не проброшен наружу. Нажми «Подобрать порт».';
  } else if (!probe.auth) {
    verdict = '🟠 **Проблема с паролем.** Порт открыт и это точно RCON, но пароль отвергнут. Сверь `RCON_PASSWORD` в `.env` с паролем в настройках RCON панели хостинга.';
  } else {
    verdict = '🟠 **RCON подключается, но команда не выполняется.** Проблема в плагине/правах, а не в боте.';
  }

  const recent = store.whitelistTests.slice(-5).reverse();
  const recentText = recent.length
    ? `\n\n**Последние тесты вайтлиста:**\n${recent.map(t => `• \`${t.nick}\` :${t.port} — ${t.ok ? '✅' : '❌'} ${String(t.error || t.message || t.response || '').slice(0, 100)}`).join('\n')}`
    : '';

  const debugText = `\n\n**Режим отладки:** ${debugOn ? 'включён — подробный лог пишется в консоль бота' : 'выключен (включи `rcon.debug.enabled: true` в config.json или `RCON_DEBUG=1` в .env)'}`;

  return interaction.editReply({
    embeds: [embed('🩺 Диагностика RCON', `${body}\n\n${verdict}${debugText}${recentText}`.slice(0, 4000))],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel:rcon_test').setLabel('Повторить').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel:rcon_scan').setLabel('Подобрать порт').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel:test_whitelist').setLabel('Тест Test1..Test3').setEmoji('🧪').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('panel:test_whitelist_compare').setLabel('zwl против whitelist').setEmoji('⚖️').setStyle(ButtonStyle.Secondary)
    )]
  });
}

async function scanRconPorts(interaction) {
  if (denyIfNotPanelAdmin(interaction)) return;
  await interaction.deferReply({ ephemeral: true });
  const scan = await rconFindEndpoint(config.rcon || {}, console);
  const lines = scan.attempts.map(a => `${a.ok ? '✅' : '❌'} \`${a.port}\` — ${a.ok ? `AUTH OK, ответ на "${a.command}": "${String(a.response).slice(0, 80)}"` : `${a.code}: ${a.message.slice(0, 160)}`}`);
  const summary = scan.endpoint
    ? `🟢 **Рабочий порт: ${scan.endpoint.port}.** Пропиши его в config.json → rcon.port.`
    : '🔴 **Ни один порт не принял RCON-подключение.** Это проблема на стороне хостинга: RCON не включён в панели или его порт не проксируется наружу.';
  return interaction.editReply({ content: `**Проверка портов RCON:**\n${lines.join('\n')}\n\n${summary}`.slice(0, 1900) });
}

// Тест добавления тестовых ников (Test1, Test2, Test3) в вайтлист.
// Реальные ники игроков не используются никогда.
async function testWhitelistAdd(interaction, count = 3) {
  if (denyIfNotPanelAdmin(interaction)) return;
  await interaction.deferReply({ ephemeral: true });
  console.log(`[whitelist test] Запуск пакетного теста RCON: ${count} ника.`);
  const batch = await runWhitelistBatch(count);
  return interaction.editReply({
    embeds: [embed(
      `🧪 Тест вайтлиста: ${batch.nicks.join(', ') || '—'}`,
      `${formatBatchReport(batch)}\n\nПорт: \`${batch.results[0]?.port ?? '—'}\`, команда: \`${batch.results[0]?.command || config.rcon?.command_template}\``
    )],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel:test_whitelist').setLabel('Повторить').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel:test_whitelist_compare').setLabel('Сравнить с whitelist add').setEmoji('⚖️').setStyle(ButtonStyle.Secondary)
    )]
  });
}

// Сравнивает поведение кастомной команды zwl и штатной whitelist add:
// так видно, проблема в плагине или в самом RCON.
async function testWhitelistCompare(interaction) {
  if (denyIfNotPanelAdmin(interaction)) return;
  await interaction.deferReply({ ephemeral: true });
  console.log('[whitelist test] Сравнение zwl add и whitelist add.');
  const result = await runWhitelistCommandComparison(2);
  const line = r => `${r.ok ? '✅' : '❌'} \`${r.nick}\` → ${r.response || r.steps.find(s => !s.ok)?.detail || 'нет ответа'}`;
  const body = [
    `**zwl add** — успешно ${result.zwlPassed}/${result.count}`,
    result.custom.map(line).join('\n') || '—',
    '',
    `**whitelist add** — успешно ${result.vanillaPassed}/${result.count}`,
    result.vanilla.map(line).join('\n') || '—',
    '',
    compareVerdict(result)
  ].join('\n');
  return interaction.editReply({ embeds: [embed('⚖️ zwl add против whitelist add', body.slice(0, 4000))] });
}
// ------------------------------- Анонимные голосования -------------------------------

const MAX_VOTE_OPTIONS = 10;

function makeVoteId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Варианты вводятся в многострочном поле модалки — по одному в строке.
// Маркеры вида «- », «1. », «•» срезаем сами, дубликаты и пустые строки отбрасываем.
function parseVoteOptions(raw, maxOptions = MAX_VOTE_OPTIONS) {
  const seen = new Set();
  const options = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const item = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (!item || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    options.push(item.slice(0, 120));
  }
  return options.slice(0, maxOptions);
}

// При анонимном голосовании участнику нужна возможность честно не выбирать вариант,
// поэтому по умолчанию добавляется «Воздержался» (голос учитывается в кворуме).
function voteOptionsWithAbstain(options) {
  const extended = [...options];
  if (config.votes?.allow_abstain !== false && !extended.some(o => o.toLowerCase() === 'воздержался')) {
    extended.push('Воздержался');
  }
  return extended;
}

async function fetchGuildHumanMembers(guildId) {
  const guild = await client.guilds.fetch(String(guildId)).catch(() => null);
  if (!guild) return [];
  const members = await guild.members.fetch().catch(() => null);
  if (!members) return [];
  return [...members.values()].filter(m => !m.user.bot && m.id !== client.user.id);
}

// Кому уходит бюллетень: everyone, ID роли (можно несколько через пробел/запятую).
async function resolveVoteRecipients(raw, guildId) {
  const value = String(raw ?? '').trim();
  if (!value || /^(everyone|@everyone|все)$/i.test(value)) {
    return (await fetchGuildHumanMembers(guildId)).map(m => m.id);
  }
  const roleIds = [...new Set(value.match(/\d{17,20}/g) || [])];
  if (!roleIds.length) throw new Error('Аудитория не распознана. Укажи `everyone` или ID роли.');
  const wanted = new Set(roleIds);
  return (await fetchGuildHumanMembers(guildId))
    .filter(m => m.roles.cache.some(r => wanted.has(r.id)))
    .map(m => m.id);
}

// Ключ бюллетеня — sha256(guild + user + соль голосования). В data/requests.json
// не остаётся ни user id, ни открытого списка проголосовавших, даже если файл
// кто-то прочитает. Повторный голос перезаписывает прежний (оверрайд до закрытия).
function voteBallotKey(vote, userId) {
  return crypto.createHash('sha256').update(`${vote.id}:${vote.guildId}:${userId}:${vote.secret}`).digest('hex').slice(0, 40);
}

function findVote(voteId) {
  return store.votes.find(v => v.id === String(voteId)) || null;
}

function activeVotes() {
  return store.votes.filter(isVoteOpen);
}

// Публичный embed голосования. Только вопрос, варианты, кворум и печать итога —
// ни одного упоминания, кто голосовал.
function voteEmbed(vote, { closed = false, revealSecret = false } = {}) {
  const totals = voteTotals(vote);
  const deadline = vote.mode === 'timed'
    ? `<t:${Math.floor(new Date(vote.closesAt).getTime() / 1000)}:R>`
    : 'по решению администратора';
  const description = [
    `**${vote.question}**`,
    '',
    vote.options.map((o, i) => `**${i + 1}.** ${o}`).join('\n'),
    '',
    `Голосов подано: **${totals.voted}** из **${totals.eligible}**`,
    `Голосование ${closed ? 'закрыто' : 'закроется'} ${deadline}`,
    '',
    '🔒 **Анонимно:** бюллетень приходит боту в личные сообщения — в канале не видно, кто и как голосовал.',
    `Итог публикуется вместе с печатью \`${vote.seal}\`${revealSecret ? ` и солью \`${vote.secret}\`` : ''} — так видно, что результат не подменили.`
  ].join('\n');
  const color = closed ? (config.colors?.success || '#57F287') : (config.colors?.primary || '#5865F2');
  return embed(`🗳️ Голосование ${closed ? 'закрыто' : 'открыто'}`, description, color)
    .setFooter({ text: `Голосование ${vote.id}` });
}

function dmVoteBallot(vote, user) {
  const rows = buildVoteButtons({ ActionRowBuilder, ButtonBuilder, ButtonStyle }, vote);
  const content = [
    '🗳️ **Анонимное голосование**',
    `**${vote.question}**`,
    '',
    vote.options.map((o, i) => `**${i + 1}.** ${o}`).join('\n'),
    '',
    'Выбери вариант кнопкой ниже — в канал уйдёт только общий счёт, кто как проголосовал, не видно никому.',
    'Передумал — просто нажми другой вариант, учитывается последний выбор.',
    vote.mode === 'timed'
      ? `Закрытие <t:${Math.floor(new Date(vote.closesAt).getTime() / 1000)}:R>.`
      : 'Закрытие — вручную администратором.'
  ].join('\n');
  return dmUser(user, { content, components: rows }, { retries: 2 });
}

// Рассылка бюллетеня всей аудитории. Пачки по несколько штук, чтобы
// не упираться в rate-limit при большом сервере.
async function broadcastVoteBallots(vote, recipientIds) {
  let delivered = 0;
  let failed = 0;
  for (const userId of recipientIds) {
    const user = client.users.cache.get(String(userId)) || await client.users.fetch(String(userId)).catch(() => null);
    if (!user) { failed++; continue; }
    if (await dmVoteBallot(vote, user)) delivered++;
    else failed++;
    await sleep(config.votes?.dm_delay_ms ?? 250);
  }
  return { delivered, failed };
}

async function createVote({ guildId, channelId, invokerId, question, options, recipientIds, minutes }) {
  const secret = crypto.randomBytes(16).toString('hex');
  const open = voteOptionsWithAbstain(options);
  const vote = {
    id: makeVoteId(),
    guildId: String(guildId),
    channelId: String(channelId),
    invokerId: String(invokerId),
    question: String(question).slice(0, 200),
    options: open,
    anonymous: true,
    mode: minutes > 0 ? 'timed' : 'manual',
    closesAt: minutes > 0 ? new Date(Date.now() + minutes * 60000).toISOString() : null,
    createdAt: new Date().toISOString(),
    closedAt: null,
    status: 'open',
    eligibleIds: recipientIds,
    ballots: {},
    secret,
    seal: ''
  };
  vote.seal = voteSecretHash(vote);
  store.votes.push(vote);
  await saveStore();
  return vote;
}
// Голос приходит кнопкой в ЛС. Ответ всегда эфемерный, и в нём нет ни того,
// как голосовали другие, ни подсказок, кто ещё уже проголосовал.
async function castVote(interaction, voteId, optionIndex) {
  const vote = findVote(voteId);
  if (!vote) return interaction.reply({ content: 'Это голосование больше не существует.', ephemeral: true });
  if (!isVoteOpen(vote)) {
    return interaction.reply({ content: '🔒 Это голосование уже закрыто, голос не принимается.', ephemeral: true });
  }
  const index = Number(optionIndex);
  if (!Number.isInteger(index) || index < 0 || index >= vote.options.length) {
    return interaction.reply({ content: 'Такого варианта нет в этом голосовании.', ephemeral: true });
  }
  const key = voteBallotKey(vote, interaction.user.id);
  const changed = Number.isInteger(vote.ballots[key]);
  vote.ballots[key] = index;
  vote.updatedAt = new Date().toISOString();
  await saveStore();

  const totals = voteTotals(vote);
  return interaction.reply({
    content: [
      `✅ Голос ${changed ? 'изменён' : 'принят'}: **${vote.options[index]}**`,
      '',
      `Проголосовало ${totals.voted} из ${totals.eligible}. Голос анонимный — в канал уходят только общие числа.`
    ].join('\n'),
    ephemeral: true
  });
}

// Карточка одного голосования для администратора.
function buildVoteDetailsReply(vote) {
  const totals = voteTotals(vote);
  const open = isVoteOpen(vote);
  const body = [
    `**${vote.question}**`,
    '',
    formatVoteResults(vote),
    '',
    `Проголосовало: **${totals.voted}** из **${totals.eligible}**`,
    `Статус: **${open ? 'идёт' : 'закрыто'}**`,
    `Создано <t:${Math.floor(new Date(vote.createdAt).getTime() / 1000)}:R>`,
    open && vote.mode === 'timed'
      ? `Закроется <t:${Math.floor(new Date(vote.closesAt).getTime() / 1000)}:R>`
      : '',
    `Печать: \`${vote.seal}\``
  ].filter(line => line !== '').join('\n');
  const rows = [];
  if (open) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vote:close:${vote.id}`).setLabel('Закрыть и опубликовать итог').setEmoji('🔒').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`vote:resend:${vote.id}`).setLabel('Разослать заново').setEmoji('📨').setStyle(ButtonStyle.Secondary)
    ));
  } else {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vote:publish:${vote.id}`).setLabel('Опубликовать в канал').setEmoji('📢').setStyle(ButtonStyle.Primary)
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel:votes').setLabel('К списку').setEmoji('↩️').setStyle(ButtonStyle.Secondary)
  ));
  return {
    embeds: [embed(`🗳️ ${open ? 'Голосование' : 'Итог голосования'}`, body.slice(0, 4000))],
    components: rows,
    ephemeral: true
  };
}

// Показ карточки голосования по кнопке (из эфемерного сообщения).
async function showVoteDetails(interaction, vote) {
  const reply = buildVoteDetailsReply(vote);
  if (interaction.isButton()) return interaction.update(reply).catch(() => interaction.reply(reply));
  return interaction.reply(reply);
}

// Список голосований в панели. Отдаётся селектом: значение — id голосования.
async function showVotesMenu(interaction) {
  if (!isPanelAdmin(interaction.user.id)) {
    return interaction.reply({ content: text('panel_no_permission'), ephemeral: true });
  }
  const list = [...store.votes].reverse();
  if (!list.length) {
    return interaction.reply({
      content: 'Голосований пока нет. Нажми «Новое голосование» в панели.',
      ephemeral: true
    });
  }

  const options = list.slice(0, 25).map(vote => {
    const totals = voteTotals(vote);
    const counts = voteCounts(vote);
    const summary = vote.options.map((option, index) => `${option}: ${counts[index]}`).join(', ');
    return {
      label: `${isVoteOpen(vote) ? '🟢' : '🔴'} ${vote.question}`.slice(0, 100),
      description: `${totals.voted}/${totals.eligible} голосов • ${summary}`.slice(0, 100),
      value: vote.id
    };
  });
  const select = new StringSelectMenuBuilder().setCustomId('panel:vote_view').setPlaceholder('Выбери голосование').addOptions(options);
  const opened = list.filter(isVoteOpen).length;

  const reply = {
    embeds: [embed('🗳️ Голосования',
      `Всего: **${list.length}**, идут сейчас: **${opened}**.\n\n` +
      'Выбери голосование: там видно итог, кнопки закрытия и повторной рассылки бюллетеней.\n' +
      'Голосование анонимное — бот знает только общий счёт, кто как голосовал, не видно никому.')],
    components: [new ActionRowBuilder().addComponents(select)],
    ephemeral: true
  };
  if (interaction.isButton()) return interaction.update(reply).catch(() => interaction.reply(reply));
  return interaction.reply(reply);
}

// Публикация итогов в канал. Никаких упоминаний людей — только общие числа.
async function publishVoteResult(vote) {
  const channel = await client.channels.fetch(vote.channelId).catch(() => null);
  if (!channel || typeof channel.send !== 'function') {
    console.warn(`[vote] Канал ${vote.channelId} недоступен, итог ${vote.id} не опубликован.`);
    return false;
  }
  const totals = voteTotals(vote);
  const content = [
    formatVoteResults(vote),
    '',
    `Всего голосов: **${totals.voted}** из **${totals.eligible}**.`,
    'Голосование было анонимным: кто как голосовал, бот не сохраняет и не публикует.',
    `Печать итога: \`${vote.seal}\`.`
  ].join('\n');
  const message = await channel.send({ embeds: [embed(`🗳️ Итог: ${vote.question}`.slice(0, 250), content.slice(0, 4000))] }).catch(e => {
    console.warn(`[vote] Не удалось опубликовать итог ${vote.id} в ${vote.channelId}: ${e.message}`);
    return null;
  });
  if (message) {
    vote.resultMessageId = message.id;
    await saveStore();
  }
  return Boolean(message);
}

async function closeVote(interaction, voteId) {
  const vote = findVote(voteId);
  if (!vote) return interaction.reply({ content: 'Голосование не найдено.', ephemeral: true });
  if (!isPanelAdmin(interaction.user.id)) {
    return interaction.reply({ content: text('panel_no_permission'), ephemeral: true });
  }
  if (!isVoteOpen(vote)) return interaction.reply({ content: 'Голосование уже закрыто.', ephemeral: true });

  vote.status = 'closed';
  vote.closedAt = new Date().toISOString();
  vote.closedBy = interaction.user.id;
  await saveStore();

  await interaction.reply({ content: 'Голосование закрыто, публикую итог в канал.', ephemeral: true });
  const published = await publishVoteResult(vote);
  console.log(`[vote] ${vote.id} закрыто (${Object.keys(vote.ballots).length} голосов), публикация: ${published ? 'ok' : 'ошибка'}`);
  return published;
}

// Автозакрытие по расписанию, а не setTimeout: таймер не должен теряться
// при перезапуске бота, а голосование — зависнуть в статусе «идёт».
async function checkVoteTimers() {
  const expired = store.votes.filter(v => v.status === 'open' && v.mode === 'timed' && Date.now() > new Date(v.closesAt).getTime());
  for (const vote of expired) {
    vote.status = 'closed';
    vote.closedAt = new Date().toISOString();
    vote.closedBy = 'timer';
    await saveStore();
    await publishVoteResult(vote);
    console.log(`[vote] ${vote.id} закрыто по таймеру.`);
  }
}

// Рассылка бюллетеней заново — на случай, если у кого-то потерялось сообщение.
async function resendVoteBallots(interaction, voteId) {
  const vote = findVote(voteId);
  if (!vote) return interaction.reply({ content: 'Голосование не найдено.', ephemeral: true });
  if (!isPanelAdmin(interaction.user.id)) {
    return interaction.reply({ content: text('panel_no_permission'), ephemeral: true });
  }
  if (!isVoteOpen(vote)) return interaction.reply({ content: 'Голосование уже закрыто — рассылать бюллетени поздно.', ephemeral: true });

  await interaction.reply({ content: `📨 Рассылаю бюллетени ${vote.eligibleIds.length} участникам...`, ephemeral: true });
  const { delivered, failed } = await broadcastVoteBallots(vote, vote.eligibleIds);
  vote.resendAt = new Date().toISOString();
  await saveStore();
  console.log(`[vote] ${vote.id}: повторная рассылка — доставлено ${delivered}, не доставлено ${failed}.`);
  return interaction.editReply({
    content: `📨 Готово. Доставлено: **${delivered}**, не доставлено: **${failed}** (у кого закрыты ЛС — не получили).`
  }).catch(() => {});
}

// Повторная публикация итога закрытого голосования в канал.
async function publishClosedVote(interaction, voteId) {
  const vote = findVote(voteId);
  if (!vote) return interaction.reply({ content: 'Голосование не найдено.', ephemeral: true });
  if (!isPanelAdmin(interaction.user.id)) {
    return interaction.reply({ content: text('panel_no_permission'), ephemeral: true });
  }
  const published = await publishVoteResult(vote);
  return interaction.reply({
    content: published ? '📢 Итог опубликован в канал.' : '⚠️ Не удалось опубликовать итог — проверь права бота в канале.',
    ephemeral: true
  });
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

// Панель вызывается слеш-командой и всегда эфемерная: её видит только тот,
// кто вызвал команду. Старый текстовый вызов !панель больше не публикует панель
// в канал (раньше ответ видели все) — он лишь предлагает перейти на /панель.
async function handlePanelSlash(interaction) {
  if (config.panel?.enabled === false) {
    return interaction.reply({ content: 'Панель отключена в конфиге.', ephemeral: true });
  }
  if (config.security?.allow_commands_only_in_configured_guild !== false && !isGuild(interaction.guildId)) {
    return interaction.reply({ content: text('panel_wrong_server', '⛔ Эта команда недоступна на данном сервере.'), ephemeral: true });
  }
  if (!isPanelAdmin(interaction.user.id)) {
    return interaction.reply({ content: text('panel_no_permission', '⛔ У тебя нет прав для использования этой панели.'), ephemeral: true });
  }
  // Панель отдаёт админские действия, поэтому по умолчанию доступна только в каналах,
  // где у участника есть «Управлять сервером» (config.panel.require_manage_guild).
  if (config.panel?.require_manage_guild === true && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: text('panel_channel_no_permission', '⛔ Панель доступна только в каналах, где у тебя есть право «Управлять сервером».'), ephemeral: true });
  }

  // Запоминаем, что панель открыл именно этот админ (см. restrictToPanelOwner).
  const session = (store.panelSessions[interaction.user.id] ||= {});
  session.openedAt = Date.now();
  session.channelId = interaction.channelId;
  saveStore().catch(() => {});

  const channelName = interaction.channel?.name ? `#${interaction.channel.name}` : 'этот канал';
  return interaction.reply({
    embeds: [panelEmbed(interaction.user.id).setFooter({
      text: config.votes?.enabled === false
        ? 'Голосования отключены в конфиге'
        : `Панель в ${channelName} • видна только тебе • голосования анонимные`
    })],
    components: panelComponents(),
    ephemeral: true
  });
}

// [!]панель оставлен только как подсказка: меню вызывается слеш-командой,
// чтобы его видел лишь тот администратор, который его открыл.
async function showPanelLegacy(message) {
  if (!isGuild(message.guildId)) return replyTemp(message, text('panel_wrong_server'));
  if (!isPanelAdmin(message.author.id)) return replyTemp(message, text('panel_no_permission'));
  return replyTemp(message, text('panel_use_slash', `Панель вызывается командой \`/${panelCommandName()}\` — это видно только тебе.`));
}
async function completeRequest(interaction, requestId) {
  const req = store.requests.find(r => r.id === requestId);
  if (!req) return interaction.reply({ content: 'Заявка не найдена.', ephemeral: true });
  if (!isAdmin(interaction.user.id)) return interaction.reply({ content: text('panel_no_permission'), ephemeral: true });
  if (req.status === 'COMPLETED') return interaction.reply({ content: replace(text('request_already_completed'), { admin_mention: `<@${req.completedBy}>` }), ephemeral: true });
  if (!['PENDING_WHITELIST', 'PENDING_REVIEW'].includes(req.status)) return interaction.reply({ content: 'Эта заявка больше не ожидает подтверждения.', ephemeral: true });
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
  // Модалка голосования живёт отдельно: у неё свои поля (вопрос, варианты, аудитория).
  if (type === 'vote') return voteModal();
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

// Модалка создания голосования. Пять полей — это максимум, который позволяет Discord,
// поэтому длительность и аудитория вводятся текстом, а не селектами.
function voteModal() {
  const defaults = config.votes || {};
  return new ModalBuilder()
    .setCustomId('panelmodal:vote')
    .setTitle('Новое анонимное голосование')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('question')
        .setLabel('Вопрос голосования')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(200)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('options')
        .setLabel(`Варианты — по одному в строке (2–${MAX_VOTE_OPTIONS})`)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000)
        .setPlaceholder('Да\nНет\nНе решил')),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('audience')
        .setLabel('Кому разослать: everyone или ID роли')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(200)
        .setValue(String(defaults.default_audience || 'everyone'))),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('minutes')
        .setLabel('Длительность, минут (0 — закрыть вручную)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(6)
        .setValue(String(defaults.default_minutes ?? 30))),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('channel')
        .setLabel('ID канала для итогов (пусто — текущий)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(25))
    );
}

// Обработка модалки голосования: создаёт голосование, рассылает бюллетени в ЛС
// и публикует в канал карточку с общим счётом (без имён).
async function handleVoteModal(interaction) {
  if (config.votes?.enabled === false) {
    return interaction.reply({ content: 'Голосования отключены в конфиге.', ephemeral: true });
  }
  if (!isPanelAdmin(interaction.user.id)) {
    return interaction.reply({ content: text('panel_no_permission'), ephemeral: true });
  }
  if (!isGuild(interaction.guildId)) {
    return interaction.reply({ content: text('panel_wrong_server'), ephemeral: true });
  }

  const question = interaction.fields.getTextInputValue('question').trim();
  const options = parseVoteOptions(interaction.fields.getTextInputValue('options'), config.votes?.max_options || MAX_VOTE_OPTIONS);
  const audience = interaction.fields.getTextInputValue('audience') || 'everyone';
  const minutesRaw = (interaction.fields.getTextInputValue('minutes') || '').trim();
  const channelRaw = (interaction.fields.getTextInputValue('channel') || '').trim();

  if (!question) return interaction.reply({ content: 'Вопрос не может быть пустым.', ephemeral: true });
  if (options.length < 2) return interaction.reply({ content: 'Нужно минимум два варианта — каждый с новой строки.', ephemeral: true });

  const minutes = minutesRaw ? Number(minutesRaw.replace(',', '.')) : 0;
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 20160) {
    return interaction.reply({ content: 'Длительность должна быть числом от 0 до 20160 минут (14 дней).', ephemeral: true });
  }
  if (channelRaw && !/^\d{17,20}$/.test(channelRaw)) {
    return interaction.reply({ content: 'ID канала выглядит некорректно.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  let recipientIds;
  try {
    recipientIds = await resolveVoteRecipients(audience, interaction.guildId);
  } catch (e) {
    return interaction.editReply({ content: `❌ ${e.message}` });
  }
  if (!recipientIds.length) {
    return interaction.editReply({ content: '❌ Не нашёл ни одного получателя по указанной аудитории (боты исключены).' });
  }

  const channelId = channelRaw || interaction.channelId;
  const vote = await createVote({
    guildId: interaction.guildId,
    channelId,
    invokerId: interaction.user.id,
    question,
    options,
    recipientIds,
    minutes
  });

  const channel = await client.channels.fetch(channelId).catch(() => null);
  const message = channel && typeof channel.send === 'function'
    ? await channel.send({ embeds: [voteEmbed(vote)] }).catch(e => {
      console.warn(`[vote] Не удалось опубликовать голосование ${vote.id}: ${e.message}`);
      return null;
    })
    : null;
  if (message) {
    vote.messageId = message.id;
    await saveStore();
  }

  const { delivered, failed } = await broadcastVoteBallots(vote, recipientIds);
  console.log(`[vote] ${vote.id} «${question}»: бюллетеней доставлено ${delivered}, не доставлено ${failed}.`);

  return interaction.editReply({
    content: [
      `🗳️ Голосование создано: **${question}**`,
      `Варианты: ${vote.options.join(' • ')}`,
      `Бюллетени в ЛС: ✅ ${delivered}, ❌ ${failed} (у кого закрыты ЛС — не получили).`,
      message ? `Карточка опубликована в <#${channelId}>.` : `⚠️ Не удалось опубликовать карточку в <#${channelId}> — проверь права бота.`,
      vote.mode === 'timed'
        ? `Закроется автоматически <t:${Math.floor(new Date(vote.closesAt).getTime() / 1000)}:R>.`
        : 'Закроется, когда ты нажмёшь «Закрыть» в панели: кнопка «Голосования».'
    ].join('\n').slice(0, 1900)
  });
}

async function registerRulesSlash() {
  if (config.rules?.register_slash_command === false) return;
  const guildId = String(config.discord?.guild_id || '');
  if (!guildId) return;
  try {
    const guild = await client.guilds.fetch(guildId);
    const existing = await guild.commands.fetch();
    const name = 'правила';
    const payload = { name, description: 'Показать правила проекта (видно только тебе)' };
    const command = existing.find(c => c.name === name);
    if (command) await command.edit(payload);
    else await guild.commands.create(payload);
    console.log(`[rules] Slash-команда /${name} зарегистрирована.`);
  } catch (e) {
    console.warn(`[rules] Не удалось зарегистрировать slash-команду: ${e.message}`);
  }
}

// Имя слеш-команды панели: берётся из config.bot.panel_command (по умолчанию «панель»).
// Discord допускает латиницу в нижнем регистре, цифры и дефис, поэтому кириллица
// допустима как есть, а пробелы приходится отбрасывать.
function panelCommandName() {
  const raw = String(config.bot?.panel_command || 'панель').trim().toLowerCase().replace(/\s+/g, '-');
  return /^[a-zа-яё0-9-]{1,32}$/u.test(raw) ? raw : 'панель';
}

// Регистрирует /панель. Команда эфемерная: её видит только тот, кто вызвал.
async function registerPanelSlash() {
  if (config.panel?.register_slash_command === false) return;
  const guildId = String(config.discord?.guild_id || '');
  if (!guildId) return;
  const name = panelCommandName();
  try {
    const guild = await client.guilds.fetch(guildId);
    const existing = await guild.commands.fetch();
    const command = existing.find(c => c.name === name);
    const payload = { name, description: 'Панель управления — только для администраторов (видна только тебе)' };
    // Скрываем команду из списка для всех, у кого нет прав администратора сервера:
    // в меню сможет увидеть только владелец / админ, и то лишь после вызова.
    if (config.panel?.hide_from_non_admins !== false) payload.defaultMemberPermissions = '0';
    if (command) await command.edit(payload);
    else await guild.commands.create(payload);
    console.log(`[panel] Slash-команда /${name} зарегистрирована (эфемерная, только для админов).`);
  } catch (e) {
    console.warn(`[panel] Не удалось зарегистрировать slash-команду /${name}: ${e.message}`);
  }
}

// /zwl — ручное управление вайтлистом и тесты RCON прямо из Discord.
//   /zwl add <ник>      — добавить ник в вайтлист через RCON
//   /zwl remove <ник>   — удалить ник
//   /zwl test [кол-во]  — добавить тестовые ники Test1..TestN
//   /zwl compare        — сравнить zwl add и whitelist add
async function handleZwlSlash(interaction) {
  if (!isPanelAdmin(interaction.user.id)) return interaction.reply({ content: 'No permission.', ephemeral: true });
  const sub = interaction.options.getSubcommand();
  if (sub === 'test') return testWhitelistAdd(interaction, interaction.options.getInteger('count') || 3);
  if (sub === 'compare') return testWhitelistCompare(interaction);
  const nick = String(interaction.options.getString('nick') || '').trim();
  if (!isValidMinecraftNick(nick, config.minecraft?.nickname_pattern)) return interaction.reply({ content: 'Invalid Minecraft nickname.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const result = sub === 'remove' ? await executeWhitelistRemove(nick) : await runWhitelistTest(nick);
  const ok = Boolean(sub === 'remove' ? result.success : result.ok);
  return interaction.editReply({ content: (ok ? 'Success: ' : 'Failed: ') + nick + '. ' + (result.response || result.error || 'No RCON response') });
}
async function registerZwlSlash() {
  if (config.zwl?.register_slash_command === false) return;
  const guildId = String(config.discord?.guild_id || '');
  if (!guildId) return;
  const nickOption = {
    type: ApplicationCommandOptionType.String,
    name: 'nick',
    description: 'Minecraft-ник',
    required: true,
    max_length: 16
  };
  const payload = {
    name: 'zwl',
    description: 'Управление вайтлистом сервера (только администраторы)',
    options: [
      { type: ApplicationCommandOptionType.Subcommand, name: 'add', description: 'Добавить ник в вайтлист', options: [nickOption] },
      { type: ApplicationCommandOptionType.Subcommand, name: 'remove', description: 'Удалить ник из вайтлиста', options: [nickOption] },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'test',
        description: 'Добавить тестовые ники Test1..TestN',
        options: [{
          type: ApplicationCommandOptionType.Integer,
          name: 'count',
          description: 'Сколько ников добавить (1–5)',
          required: false,
          min_value: 1,
          max_value: 5
        }]
      },
      { type: ApplicationCommandOptionType.Subcommand, name: 'compare', description: 'Сравнить zwl add и whitelist add' }
    ]
  };
  try {
    const guild = await client.guilds.fetch(guildId);
    const existing = await guild.commands.fetch();
    const command = existing.find(c => c.name === 'zwl');
    if (command) await command.edit(payload);
    else await guild.commands.create(payload);
    console.log('[zwl] Slash-команда /zwl зарегистрирована.');
  } catch (e) {
    console.warn(`[zwl] Не удалось зарегистрировать slash-команду /zwl: ${e.message}`);
  }
}

// Периодическая проверка таймеров голосований. Обычный setInterval:
// состояние хранится в data/requests.json, поэтому перезапуск бота его не теряет.
function startVoteTimer() {
  if (config.votes?.enabled === false) return null;
  const seconds = Math.max(15, Number(config.votes?.auto_close_check_seconds) || 60);
  const timer = setInterval(() => {
    checkVoteTimers().catch(e => console.error('[vote timer]', e));
  }, seconds * 1000);
  console.log(`[vote] Автозакрытие голосований проверяется каждые ${seconds} с.`);
  return timer;
}

client.once(Events.ClientReady, c => {
  console.log(replace(text('bot_ready', 'Bot ready: {bot_tag}'), { bot_tag: c.user.tag }));
  registerRulesSlash();
  registerPanelSlash();
  registerZwlSlash();
  startVoteTimer();
  checkVoteTimers().catch(e => console.error('[vote timer]', e));
  rconPreflight(config.rcon || {}, console).catch(e => console.warn('[rcon] preflight:', e.message));
});
async function processMemberAccessRoles(member, previous = null) {
  if (!isGuild(member.guild.id)) return;
  const current = member;
  const oldRoles = previous?.roles?.cache;
  const gained = accessRoles.filter(id => current.roles.cache.has(id) && (!oldRoles || !oldRoles.has(id)));
  const lost = oldRoles ? accessRoles.filter(id => oldRoles.has(id) && !current.roles.cache.has(id)) : [];
  const types = config.discord?.role_access_types || {};
  if (gained.length) {
    await notifyRoleAdmins(current, 'gained', gained.map(id => current.guild.roles.cache.get(id)?.name || id));
    if (config.flow?.auto_dm_on_role !== false && !getPassStatus(current.id) && !hasActiveRequest(current.id)) await startNicknameFlow(current.id, gained.map(id => types[id]).find(v => v === 'free') || 'paid', 'role');
  }
  if (lost.length && !accessRoles.some(id => current.roles.cache.has(id))) await notifyRoleAdmins(current, 'lost', lost.map(id => current.guild.roles.cache.get(id)?.name || id));
}
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    const freshMember = await newMember.guild.members.fetch(newMember.id).catch(() => newMember);
    await processMemberAccessRoles(freshMember, oldMember);
  } catch (e) { console.error('[role update]', e); }
});
client.on(Events.GuildMemberAdd, async member => {
  try {
    const freshMember = await member.guild.members.fetch(member.id).catch(() => member);
    await processMemberAccessRoles(freshMember);
  } catch (e) { console.error('[role add]', e); }
});
client.on(Events.MessageCreate, async message => {
  try {
    if (message.author.bot) return;
    const content = message.content.trim().toLowerCase();
    const prefix = config.bot?.prefix || '!';
    const rulesAliases = [config.bot?.rules_command || 'правила', ...(config.rules?.aliases || [])].map(a => `${prefix}${String(a).toLowerCase()}`);
    if (message.guild && rulesAliases.includes(content)) return await sendRules(message);
    if (message.guild && content === `${prefix}${config.bot?.panel_command || 'панель'}`) return await showPanelLegacy(message);
    if (!message.guild) await handleNicknameMessage(message);
  } catch (e) { console.error('[message]', e); }
});
client.on(Events.InteractionCreate, async interaction => {
  try {
    // ---- Слеш-команды ----
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'правила') return await handleRulesSlash(interaction);
      if (interaction.commandName === 'zwl') return await handleZwlSlash(interaction);
      if (interaction.commandName === panelCommandName()) return await handlePanelSlash(interaction);
    }

    // ---- Кнопки и селекты панели ----
    // Панель эфемерная: customId общий для всех, поэтому доступ проверяется
    // и по правам (panel_admin_ids), и по владельцу открытой сессии.
    if (interaction.isButton() && interaction.customId.startsWith('panel:')) {
      if (denyIfNotPanelAdmin(interaction)) return;
      switch (interaction.customId) {
        case 'panel:pass_status': return await showPassStatus(interaction);
        case 'panel:bulk_access': return await bulkStartMissingPassFlows(interaction);
        case 'panel:rcon_test': return await showRconDiagnostics(interaction);
        case 'panel:rcon_scan': return await scanRconPorts(interaction);
        case 'panel:test_whitelist': return await testWhitelistAdd(interaction);
        case 'panel:test_whitelist_compare': return await testWhitelistCompare(interaction);
        case 'panel:votes': return await showVotesMenu(interaction);
        case 'panel:vote_new': {
          // Голосование создаётся из модалки: вопрос, варианты, аудитория, длительность.
          if (config.votes?.enabled === false) {
            return interaction.reply({ content: 'Голосования отключены в конфиге.', ephemeral: true });
          }
          if (config.security?.allow_commands_only_in_configured_guild !== false && !isGuild(interaction.guildId)) {
            return interaction.reply({ content: text('panel_wrong_server'), ephemeral: true });
          }
          return interaction.showModal(voteModal());
        }
        default:
          return interaction.reply({ content: 'Неизвестная кнопка панели.', ephemeral: true });
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'panel:action') {
      if (denyIfNotPanelAdmin(interaction)) return;
      const choice = interaction.values[0];
      if (choice === 'paid' && config.flow?.allow_paid_access === false) return interaction.reply({ content: 'Платная выдача отключена в конфиге.', ephemeral: true });
      if (choice === 'free' && config.flow?.allow_free_access === false) return interaction.reply({ content: 'Бесплатная выдача отключена в конфиге.', ephemeral: true });
      return interaction.showModal(panelModal(choice));
    }

    // Выбор конкретного голосования из списка в панели.
    // update() редактирует исходное эфемерное сообщение списка — без новых сообщений.
    if (interaction.isStringSelectMenu() && interaction.customId === 'panel:vote_view') {
      if (denyIfNotPanelAdmin(interaction)) return;
      const vote = findVote(interaction.values[0]);
      if (!vote) return interaction.reply({ content: 'Голосование не найдено.', ephemeral: true });
      return interaction.update(buildVoteDetailsReply(vote));
    }

    // ---- Модалки панели ----
    if (interaction.isModalSubmit() && interaction.customId.startsWith('panelmodal:')) {
      if (denyIfNotPanelAdmin(interaction)) return;
      const kind = interaction.customId.split(':')[1];
      // У голосования своя обработка и свои поля — без общего поля target.
      if (kind === 'vote') return await handleVoteModal(interaction);

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
    // ---- Голосования ----
    // vote:cast:<id>:<index> — голос в ЛС. Отдельный префикс канала не нужен:
    // команда не привязана к админским правам, проголосовать может любой получатель.
    if (interaction.isButton() && interaction.customId.startsWith('vote:cast:')) {
      const [, , voteId, index] = interaction.customId.split(':');
      if (!interaction.guildId) return await castVote(interaction, voteId, index);
      // В канале голосовать нельзя: бюллетень приходит только в ЛС, иначе в
      // журнале канала будет видно, кто голосовал.
      return interaction.reply({ content: '🗳️ Голосовать можно кнопками из личных сообщений бота (так голос остаётся анонимным).', ephemeral: true });
    }
    if (interaction.isButton() && interaction.customId.startsWith('vote:close:')) {
      if (denyIfNotPanelAdmin(interaction)) return;
      return await closeVote(interaction, interaction.customId.slice('vote:close:'.length));
    }
    if (interaction.isButton() && interaction.customId.startsWith('vote:resend:')) {
      if (denyIfNotPanelAdmin(interaction)) return;
      return await resendVoteBallots(interaction, interaction.customId.slice('vote:resend:'.length));
    }
    if (interaction.isButton() && interaction.customId.startsWith('vote:publish:')) {
      if (denyIfNotPanelAdmin(interaction)) return;
      return await publishClosedVote(interaction, interaction.customId.slice('vote:publish:'.length));
    }
  } catch (e) {
    console.error('[interaction]', e);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) await interaction.reply({ content: text('generic_error', 'Произошла ошибка.'), ephemeral: true }).catch(() => {});
  }
});

// В .env нельзя оставлять кавычки, пробелы или переносы строк вокруг токена.
// dotenv с override=true гарантирует, что старый DISCORD_TOKEN из окружения
// процесса не перекроет новый токен из файла.
const discordToken = String(process.env.DISCORD_TOKEN || '').trim().replace(/^['"]|['"]$/g, '');
if (!discordToken) { console.error('Missing DISCORD_TOKEN in .env'); process.exit(1); }
if (/\s/.test(discordToken) || discordToken.split('.').length !== 3) { console.error('Invalid DISCORD_TOKEN format'); process.exit(1); }
client.login(discordToken).catch(e => {
  console.error('Discord login failed:', e?.code === 'TokenInvalid' ? 'TokenInvalid; verify token and environment overrides.' : (e?.message || e));
  client.destroy().catch(() => {}); setImmediate(() => process.exit(1));
});
