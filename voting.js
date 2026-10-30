// Анонимные голосования.
//
// Голос подаётся в личных сообщениях боту, поэтому в канале не видно,
// кто и как проголосовал. Результат публикуется только общими числами:
// ни список проголосовавших, ни то, как голосовал конкретный участник,
// в канал не попадают — это закрывает главную деанонимизацию в опросах Discord
// (кто нажал кнопку, видно в журнале событий).
//
// Чтобы результат нельзя было подделать после старта, при публикации опроса
// бот сохраняет sha256-«печать» итога (формат vote.id.secret), а bid
// публикуется в embed. После закрытия любой участник может проверить,
// что итог не менялся.

const crypto = require('node:crypto');

function voteSecretHash(vote) {
  return crypto.createHash('sha256').update(`${vote.id}:${vote.secret}`).digest('hex');
}

function voteCounts(vote) {
  const counts = new Array(vote.options.length).fill(0);
  for (const choice of Object.values(vote.ballots || {})) {
    if (Number.isInteger(choice) && choice >= 0 && choice < counts.length) counts[choice] += 1;
  }
  return counts;
}

// Общее число участников и статус для закрытой панели.
function voteTotals(vote) {
  const ballots = Object.values(vote.ballots || {});
  const eligible = Array.isArray(vote.eligibleIds) ? vote.eligibleIds.length : 0;
  return { voted: ballots.length, eligible, counts: voteCounts(vote) };
}

function isVoteOpen(vote) {
  if (!vote || vote.status !== 'open') return false;
  if (vote.mode === 'timed' && Date.now() > new Date(vote.closesAt).getTime()) return false;
  return true;
}

function isVoteAnonymous(vote) {
  return vote?.anonymous !== false;
}

// Форматирует строку результатов. Проценты считаются от поданных голосов.
function formatVoteResults(vote) {
  const counts = voteCounts(vote);
  const total = counts.reduce((a, b) => a + b, 0);
  return vote.options.map((option, index) => {
    const value = counts[index];
    const percent = total ? Math.round((value / total) * 1000) / 10 : 0;
    const barLength = total ? Math.round((value / total) * 10) : 0;
    const bar = '█'.repeat(barLength) + '░'.repeat(10 - barLength);
    return `**${index + 1}. ${option}** — ${value} (${percent}%)\n\`${bar}\``;
  }).join('\n');
}

// Кнопки для голосования в ЛС. Возвращает массив строк, по 5 кнопок в каждой.
function buildVoteButtons(discord, vote, disabled = false) {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = discord;
  const buttons = vote.options.map((option, index) => new ButtonBuilder()
    .setCustomId(`vote:cast:${vote.id}:${index}`)
    .setLabel(String(index + 1).slice(0, 80))
    .setStyle(index === 0 ? ButtonStyle.Primary : index === 1 ? ButtonStyle.Success : index === 2 ? ButtonStyle.Danger : ButtonStyle.Secondary)
    .setDisabled(disabled));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  return rows;
}

module.exports = {
  voteSecretHash, voteCounts, voteTotals, isVoteOpen, isVoteAnonymous, formatVoteResults, buildVoteButtons
};