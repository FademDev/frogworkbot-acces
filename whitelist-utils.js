'use strict';

// Чистые функции тестов вайтлиста, вынесенные из bot.js, чтобы их можно было
// юнит-тестировать без запуска Discord-клиента и без сети.
//
// bot.js импортирует этот модуль; логика в одном месте, поведение проверяемое.

// Ключевые слова. Порядок важен: сначала ищем ЯВНЫЕ ошибки, потом «уже в списке»,
// потом успех. Ответ "Player is already whitelisted" — это НЕ ошибка для бота
// (ник уже в вайтлисте), но и не «добавлено сейчас».
const ALREADY_KEYWORDS = ['already whitelisted', 'already added', 'уже в белом списке', 'уже добавлен'];
const HARD_FAILURE_KEYWORDS = [
  'unknown command', 'неизвестная команда', 'unknown or incomplete', 'incorrect argument',
  'no player was found', 'that player does not exist', 'player does not exist',
  'не найден', 'could not', 'unable to', 'permission', 'нет прав'
];

// Разбирает ответ сервера на команду вайтлиста.
// Возвращает { success, already, reason }.
function interpretWhitelistResponse(response, { successKeywords = [], failureKeywords = [] } = {}) {
  const lower = String(response ?? '').toLowerCase().trim();

  if (!lower) return { success: true, already: false, reason: 'empty_response' };

  const hardFail = HARD_FAILURE_KEYWORDS.find(k => lower.includes(k));
  if (hardFail) return { success: false, already: false, reason: `failure_keyword:${hardFail}` };

  const configuredFailure = failureKeywords.find(k => lower.includes(String(k).toLowerCase()));
  if (configuredFailure) return { success: false, already: false, reason: `failure_keyword:${configuredFailure}` };

  const already = ALREADY_KEYWORDS.some(k => lower.includes(k));
  const configuredSuccess = successKeywords.find(k => lower.includes(String(k).toLowerCase()));
  if (configuredSuccess) return { success: true, already, reason: `success_keyword:${configuredSuccess}` };

  return { success: true, already, reason: 'no_explicit_error' };
}

// Генерирует тестовые ники: Test1, Test2, ... с обходом уже использованных.
// Minecraft разрешает 16 символов, поэтому длинные имена отбрасываются.
function buildTestNicknames(count = 3, existing = [], prefix = 'Test') {
  const used = new Set(existing.map(n => String(n).toLowerCase()));
  const safePrefix = String(prefix || 'Test').replace(/[^A-Za-z0-9_]/g, '').slice(0, 12) || 'Test';
  const names = [];
  for (let i = 1; names.length < count && i <= 9999; i++) {
    const nick = `${safePrefix}${i}`;
    if (nick.length > 16) break;
    if (!used.has(nick.toLowerCase())) { names.push(nick); used.add(nick.toLowerCase()); }
  }
  return names.slice(0, count);
}

// Сводка по пакетному тесту для embed.
function formatBatchReport(batch) {
  const header = batch.ok
    ? `🟢 Все тесты прошли: **${batch.passed}/${batch.total}**. RCON бота в порядке.`
    : `🔴 Успешно: **${batch.passed}/${batch.total}**. Смотри детали ниже.`;
  const rows = batch.results.map(r => {
    const failedStep = r.steps.find(s => !s.ok);
    return `${r.ok ? '✅' : '❌'} \`${r.nick}\` → ${r.response || (failedStep ? failedStep.detail : 'нет ответа')}`;
  });
  return `${header}\n\n${rows.join('\n')}`.slice(0, 4000);
}

// Подробный отчёт по одному нику.
function formatTestReport(report) {
  const header = `Ник: \`${report.nick}\`${report.port ? ` • порт \`${report.port}\`` : ''}`;
  const steps = report.steps.map(step => `${step.ok ? '✅' : '❌'} **${step.name}** — ${String(step.detail).slice(0, 300)}`);
  const verdict = report.ok
    ? '🟢 **RCON работает**, ник добавлен (или уже был в вайтлисте). Если в игре его всё равно не видно — дело в плагине zwl, а не в боте.'
    : '🔴 **RCON не сработал.** Смотри, на каком шаге ❌: TCP закрыт → проблема на хостинге; AUTH → пароль; команда → плагин/права.';
  return [header, '', steps.join('\n'), '', verdict].join('\n');
}

// Вердикт для сравнения zwl add и whitelist add.
function compareVerdict({ zwlPassed, vanillaPassed }) {
  if (zwlPassed && vanillaPassed) return '🟢 Обе команды работают. Если в игре игрока не видно — дело в плагине zwl.';
  if (!zwlPassed && vanillaPassed) return '🟠 `zwl add` не работает, а штатная `whitelist add` работает → проблема в плагине zwl, не в боте. Бот можно перевести на `whitelist add`: config.json → rcon.command_template.';
  if (!zwlPassed && !vanillaPassed) return '🔴 Не работают обе команды → проблема в RCON или правах, а не в плагине.';
  return '🟠 Штатная `whitelist add` не сработала, а `zwl add` сработала — проверь ядро сервера.';
}
// Безопасная валидация никнейма Java Edition без исключения для повреждённого regex в конфиге.
function isValidMinecraftNick(nick, pattern = '^[A-Za-z0-9_]{3,16}$') {
  const value = String(nick ?? '').trim();
  if (value.length < 3 || value.length > 16) return false;
  try { return new RegExp(pattern).test(value); }
  catch { return /^[A-Za-z0-9_]{3,16}$/.test(value); }
}



module.exports = {
  interpretWhitelistResponse,
  buildTestNicknames,
  formatBatchReport,
  formatTestReport,
  compareVerdict,
  ALREADY_KEYWORDS,
  isValidMinecraftNick,

  HARD_FAILURE_KEYWORDS
};