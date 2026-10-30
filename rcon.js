// Диагностика и безопасная работа с RCON.
//
// Модуль нужен по двум причинам:
// 1. rcon-client падает с необработанным RangeError, если на порту RCON отвечает не RCON,
//    а обычный Minecraft-клиентский протокол (так ведут себя панели хостинга, где extern RCON
//    выдают на порт игрового сервера и входящий трафик перехватывает сам Minecraft). Такая
//    ошибка роняет весь процесс бота, поэтому разбор пакетов обёрнут в try/catch и все
//    слушатели 'error' всегда установлены.
// 2. Владельцу бота нужно понимать, кто виноват: бот или хостинг. Поэтому каждый шаг
//    (DNS, TCP, AUTH, ответ на команду) логируется отдельно, а результат возвращается
//    с кодом причины, который бот показывает прямо в Discord.

const net = require('node:net');
const dns = require('node:dns');
const { EventEmitter } = require('node:events');

// rcon-client@4.2.5's splitter incorrectly assumes complete RCON packets and
// can throw an uncaught RangeError on malformed/fragmented responses. This
// small client implements the vanilla Source RCON framing with strict checks.
class SafeRcon extends EventEmitter {
  constructor({ host, port, password, timeout = 8000 }) {
    super();
    this.host = host;
    this.port = port;
    this.password = password;
    this.timeout = timeout;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.authenticated = false;
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = this.socket = net.connect({ host: this.host, port: this.port });
      let settled = false;
      const timer = setTimeout(() => fail(new Error('RCON connection timeout')), this.timeout);
      const fail = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      socket.once('connect', () => {
        socket.setNoDelay(true);
        socket.on('data', chunk => this._onData(chunk));
        socket.on('error', error => this._onError(error));
        socket.on('close', () => this._onClose());
        this._request(3, this.password).then(packet => {
          if (packet.id === -1) throw new Error('Authentication failed');
          this.authenticated = true;
          this.emit('authenticated');
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(this);
          }
        }).catch(fail);
      });
      socket.once('error', fail);
    });
  }

  send(command) {
    if (!this.authenticated) return Promise.reject(new Error('Not connected'));
    return this._request(2, command).then(packet => packet.payload);
  }

  _request(type, payload) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('Connection closed'));
    const id = this.nextId++;
    const body = Buffer.from(String(payload), 'utf8');
    const packet = Buffer.alloc(body.length + 14);
    packet.writeInt32LE(body.length + 10, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    body.copy(packet, 12);
    packet.writeInt16LE(0, packet.length - 2);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout for RCON packet ${id}`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(packet, error => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0);
      if (length < 10 || length > 4 * 1024 * 1024) {
        this._onError(new Error(`Invalid RCON packet length: ${length}`));
        this.socket?.destroy();
        return;
      }
      if (this.buffer.length < length + 4) return;
      const id = this.buffer.readInt32LE(4);
      const type = this.buffer.readInt32LE(8);
      const payload = this.buffer.subarray(12, 4 + length - 2).toString('utf8');
      this.buffer = this.buffer.subarray(4 + length);
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve({ id, type, payload });
      }
    }
  }

  _onError(error) {
    this.emit('error', error);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  _onClose() {
    this.closed = true;
    this.authenticated = false;
    this.emit('end');
    const error = new Error('Connection closed');
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  end() {
    if (!this.socket || this.socket.destroyed || this.closed) return Promise.resolve();
    return new Promise(resolve => {
      this.socket.once('close', resolve);
      this.socket.end();
      setTimeout(() => {
        this.socket?.destroy();
        resolve();
      }, 250).unref();
    });
  }
}

// Порядок проверки портов, если в конфиге явно не задан rcon.alternative_ports:
// 25577 — стандартный internal-порт RCON в панелях на Pterodactyl/Pelican,
// 25575 — стандартный RCON, 25746 — второй (ALT) порт проекта.
const DEFAULT_ALTERNATIVE_PORTS = [25577, 25575, 25746];

const NOT_RCON_HINT = 'похоже, на этом порту отвечает Minecraft, а не RCON';

// ---------------------------------------------------------------------------
// Режим отладки
//
// Включается в config.json → rcon.debug.enabled (true) или переменной окружения
// RCON_DEBUG=1. Тогда на каждый RCON-вызов в лог пишутся все шаги (DNS, TCP, AUTH,
// сырые байты ответа) — по ним видно, ошибка в боте или на стороне хостинга.
// ---------------------------------------------------------------------------
function isDebugEnabled(cfg = {}) {
  const env = String(process.env.RCON_DEBUG || '').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(env)) return true;
  if (['0', 'false', 'no', 'off'].includes(env)) return false;
  return cfg.debug === true || cfg.debug?.enabled === true;
}

// Обёртка над logger: при отладке пишет всё, иначе — только предупреждения.
function makeDebugLogger(logger = console, enabled = false) {
  return {
    debug(message) { if (enabled) logger.log(`[rcon:debug] ${message}`); },
    info(message) { logger.log(message); },
    warn(message) { logger.warn(message); },
    error(message) { logger.error(message); }
  };
}

const maskSecret = secret => {
  const value = String(secret ?? '');
  if (!value) return '<пусто>';
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(Math.max(3, value.length - 4))}${value.slice(-2)}`;
};

// Пароль берём из окружения, а если переменная не задана — из rcon.password
// в config.json. Пустая строка/строка "undefined" считается отсутствием пароля.
function resolvePassword(cfg = {}) {
  const passwordEnv = cfg.password_env || 'RCON_PASSWORD';
  const fromEnv = process.env[passwordEnv];
  if (fromEnv && fromEnv !== 'undefined') return { password: fromEnv, passwordEnv, source: 'env' };
  const fromConfig = cfg.password;
  if (fromConfig && String(fromConfig) !== 'undefined') {
    return { password: String(fromConfig), passwordEnv, source: 'config' };
  }
  return { password: null, passwordEnv, source: null };
}

const hexPreview = buffer => Buffer.from(buffer || []).subarray(0, 48).toString('hex');

function tcpProbe(host, port, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = net.connect({ host, port, timeout: timeoutMs });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, ms: Date.now() - started });
    };
    socket.on('connect', () => finish({ ok: true, code: 'open' }));
    socket.on('timeout', () => finish({ ok: false, code: 'timeout' }));
    socket.on('error', err => finish({ ok: false, code: err.code || 'tcp_error', error: err.message }));
  });
}

function describeTcpFailure(probe) {
  if (probe.code === 'ECONNREFUSED') {
    return 'Порт закрыт (ECONNREFUSED): сервер или RCON не запущен, либо хостинг не проксирует этот порт наружу.';
  }
  if (probe.code === 'ETIMEDOUT' || probe.code === 'timeout') {
    return 'Порт не отвечает (таймаут): трафик блокирует firewall хостинга либо host/port указаны неверно.';
  }
  if (probe.code === 'ENOTFOUND' || probe.code === 'EAI_AGAIN') {
    return 'Не удалось разрешить хост (DNS). Проверь rcon.host.';
  }
  if (probe.code === 'EHOSTUNREACH' || probe.code === 'ENETUNREACH') {
    return 'Хост недоступен по сети (EHOSTUNREACH/ENETUNREACH).';
  }
  return `Не удалось открыть TCP-соединение: ${probe.error || probe.code}.`;
}

function classifyRconError(err) {
  const message = String(err?.message || err || '');
  if (err?.code === 'ECONNREFUSED') return { code: 'port_closed', message: describeTcpFailure({ code: 'ECONNREFUSED' }) };
  if (err?.code === 'ETIMEDOUT' || /timed? ?out/i.test(message)) {
    return { code: 'timeout', message: 'RCON не ответил вовремя. Порт перекрыт firewall или сервер завис.' };
  }
  if (err?.code === 'ENOTFOUND') return { code: 'dns', message: 'Не удалось разрешить хост RCON.' };
  if (err?.code === 'ERR_OUT_OF_RANGE' || /out of range/i.test(message)) {
    return { code: 'not_rcon', message: `${NOT_RCON_HINT} (ответ не в формате RCON).` };
  }
  if (/invalid rcon packet length/i.test(message)) {
    return { code: 'not_rcon', message: `${NOT_RCON_HINT} (некорректная длина пакета).` };
  }
  if (/authentication failed/i.test(message)) {
    return { code: 'auth_failed', message: 'RCON отклонил пароль. Проверь RCON_PASSWORD в .env и rcon.password в server.properties.' };
  }
  return { code: 'rcon_error', message: `Ошибка RCON: ${message || 'неизвестная'}` };
}
// Пробный запуск RCON: TCP → AUTH → команда rcon.probe_command.
// probe_command по умолчанию 'list' — она есть у обоих типов ядер (vanilla и Paper/Fabric/Spigot)
// и не меняет состояние сервера.
async function rconDiagnose(cfg = {}, logger = console) {
  const debug = isDebugEnabled(cfg);
  const log = makeDebugLogger(logger, debug);
  const host = String(cfg.host || '127.0.0.1');
  const port = Number(cfg.port) || 25575;
  const timeout = Number(cfg.timeout_ms) || 8000;
  const { password, passwordEnv, source: passwordSource } = resolvePassword(cfg);
  const probeCommand = String(cfg.probe_command || 'list');
  const started = Date.now();
  const result = {
    ok: false, host, port, passwordEnv, passwordPresent: Boolean(password), tcp: null, auth: null,
    command: probeCommand, response: null, code: null, message: '', ms: 0, at: new Date().toISOString(),
    debug, steps: []
  };
  const step = (name, ok, detail) => {
    result.steps.push({ name, ok, detail: String(detail).slice(0, 300), at: new Date().toISOString() });
    log.debug(`${ok ? 'OK ' : 'FAIL'} ${name}: ${detail}`);
  };

  log.debug(`старт диагностики: host=${host} port=${port} timeout=${timeout}ms passwordEnv=${passwordEnv}`);
  if (!password || password === 'undefined') {
  result.passwordSource = passwordSource;
  result.passwordPresent = Boolean(password);
    log.debug('пароль RCON не найден в окружении (или записан строкой "undefined")');
  } else {
    log.debug(`пароль найден: длина ${password.length}, значение ${maskSecret(password)}`);
  }

  if (cfg.enabled === false) {
    step('enabled', false, 'rcon.enabled = false — RCON отключён в конфиге');
    return { ...result, code: 'disabled', message: 'RCON отключён в конфиге (rcon.enabled = false).', ms: Date.now() - started };
  }
  if (!password) {
    step('password', false, `переменная ${passwordEnv} не задана в .env`);
    return { ...result, code: 'no_password', message: `Переменная ${passwordEnv} не задана в .env — авторизоваться не получится.`, ms: Date.now() - started };
  }
  step('password', true, `переменная ${passwordEnv} найдена (${maskSecret(password)})`);

  if (cfg.log_dns !== false && !net.isIP(host)) {
    try {
      const resolved = await dns.promises.lookup(host);
      result.resolved = resolved.address;
      step('dns', true, `${host} → ${resolved.address}`);
      log.info(`[rcon] DNS: ${host} → ${resolved.address}`);
    } catch (e) {
      step('dns', false, `не удалось разрешить ${host}: ${e.code || e.message}`);
      return { ...result, code: 'dns', message: `Не удалось разрешить хост ${host}: ${e.code || e.message}`, ms: Date.now() - started };
    }
  } else if (net.isIP(host)) {
    step('dns', true, `${host} — это уже IP, DNS не нужен`);
  }

  const tcp = await tcpProbe(host, port, timeout);
  result.tcp = tcp;
  step('tcp', Boolean(tcp.ok), tcp.ok ? `порт открыт за ${tcp.ms} мс` : `${tcp.code}: ${tcp.error || ''} (${tcp.ms} мс)`);
  log.info(`[rcon] TCP ${host}:${port} → ${tcp.ok ? 'OPEN' : tcp.code} (${tcp.ms} мс)`);
  if (!tcp.ok) {
    return { ...result, code: tcp.code === 'timeout' ? 'timeout' : 'port_closed', message: describeTcpFailure(tcp), ms: Date.now() - started };
  }

  let rcon = null;
  try {
    log.debug(`создаю RCON(${host}:${port}) и отправляю AUTH`);
    rcon = new SafeRcon({ host, port, password, timeout });
    // rcon-client эмитит 'error' без слушателя → падение процесса. Слушатель обязателен.
    rcon.on('error', e => log.debug(`событие error от сокета: ${e?.code || ''} ${e?.message || e}`));
    rcon.on('end', () => log.debug('соединение закрыто сервером (end)'));
    rcon.on('authenticated', () => log.debug('событие authenticated'));
    // rcon-client сам добавляет слушатель 'end'; без увеличения лимита Node
    // сыплет MaxListenersExceededWarning на каждый вызов.
    if (typeof rcon.setMaxListeners === 'function') rcon.setMaxListeners(10);

    const authStarted = Date.now();
    await rcon.connect();
    result.auth = true;
    step('auth', true, `пароль принят за ${Date.now() - authStarted} мс`);
    log.info(`[rcon] AUTH OK на ${host}:${port} (${Date.now() - started} мс)`);

    const commandStarted = Date.now();
    log.debug(`отправляю пробную команду "${probeCommand}"`);
    const response = await rcon.send(probeCommand);
    result.response = String(response ?? '').trim();
    result.ok = true;
    result.code = 'ok';
    result.ms = Date.now() - started;
    step('command', true, `"${probeCommand}" → "${result.response.slice(0, 200)}" (${Date.now() - commandStarted} мс)`);
    log.info(`[rcon] Команда "${probeCommand}" → "${result.response}" (${Date.now() - commandStarted} мс)`);
    return result;
  } catch (e) {
    const classified = classifyRconError(e);
    result.code = classified.code;
    result.message = classified.message;
    result.ms = Date.now() - started;
    if (classified.code === 'auth_failed') result.auth = false;
    step(classified.code === 'auth_failed' ? 'auth' : 'command', false, `${e?.code ? `[${e.code}] ` : ''}${e?.message || e}`);
    log.debug(`сырые данные ответа (hex): ${hexPreview(e?.raw)}`);
    log.warn(`[rcon] ОШИБКА на ${host}:${port}: [${classified.code}] ${classified.message}`);
    return result;
  } finally {
    if (rcon) {
      try { await rcon.end(); } catch {}
    }
  }
}

// Проверка RCON при старте бота. Возвращает короткий отчёт и печатает его в лог,
// чтобы владелец сразу видел: RCON работает / пароль не тот / порт закрыт.
async function rconPreflight(cfg = {}, logger = console) {
  const debug = isDebugEnabled(cfg);
  const log = makeDebugLogger(logger, debug);
  const host = String(cfg.host || '127.0.0.1');
  const port = Number(cfg.port) || 25575;

  log.info(`[rcon] Проверка при старте: ${host}:${port} (отладка ${debug ? 'включена' : 'выключена'}).`);

  if (cfg.enabled === false) {
    log.warn('[rcon] RCON отключён в конфиге (rcon.enabled = false) — проходки будут уходить в ручной режим.');
    return { ok: false, code: 'disabled', message: 'RCON отключён в конфиге.' };
  }
  if (cfg.dry_run) {
    log.warn('[rcon] rcon.dry_run = true — команды только логируются, на сервер не уходят.');
    return { ok: true, code: 'dry_run', message: 'Включён dry_run.' };
  }

  const probe = await rconDiagnose({ ...cfg, port }, logger);
  if (probe.ok) {
    log.info(`[rcon] ✅ RCON работает: AUTH принят, команда "${probe.command}" → "${probe.response}" (${probe.ms} мс).`);
    return { ok: true, code: 'ok', message: 'RCON доступен.', probe };
  }

  log.warn(`[rcon] ❌ RCON недоступен на ${host}:${port}: [${probe.code}] ${probe.message}`);
  if (['port_closed', 'not_rcon', 'timeout'].includes(probe.code) && cfg.auto_fallback_port !== false) {
    log.warn('[rcon] Пробую резервные порты...');
    const scan = await rconFindEndpoint(cfg, logger);
    if (scan.endpoint) {
      log.warn(`[rcon] ⚠️ Рабочий порт — ${scan.endpoint.port}. Замени rcon.port в config.json на это значение.`);
      return { ok: true, code: 'fallback', message: `Рабочий порт: ${scan.endpoint.port}`, endpoint: scan.endpoint, attempts: scan.attempts, probe };
    }
    log.warn('[rcon] Ни один порт не принял RCON. Это проблема на стороне хостинга: RCON выключен или порт не проброшен наружу.');
    return { ok: false, code: probe.code, message: 'Ни один порт не принял RCON-подключение.', attempts: scan.attempts };
  }
  if (probe.code === 'auth_failed') {
    log.warn('[rcon] Порт открыт и отвечает как RCON, но пароль отвергнут. Сверь RCON_PASSWORD в .env с password в RCON-настройках панели хостинга.');
  }
  return { ok: false, code: probe.code, message: probe.message, probe };
}

// Подбор рабочего порта: сначала основной из конфига, затем alternative_ports.
// Возвращает диагностику по всем проверенным портам, чтобы в Discord было видно,
// что именно отвечает на каждом из них.
async function rconFindEndpoint(cfg, logger = console) {
  const host = String(cfg.host || '127.0.0.1');
  const mainPort = Number(cfg.port) || 25575;
  const fallbacks = cfg.use_alternative_ports === false
    ? []
    : (Array.isArray(cfg.alternative_ports) ? cfg.alternative_ports.map(Number).filter(Boolean) : DEFAULT_ALTERNATIVE_PORTS);
  const ports = [...new Set([mainPort, ...fallbacks])];
  const attempts = [];
  for (const port of ports) {
    const attempt = await rconDiagnose({ ...cfg, port }, logger);
    attempts.push(attempt);
    if (attempt.ok) {
      fallbackState.port = port;
      fallbackState.checkedAt = Date.now();
      return { endpoint: { host, port }, attempts, success: attempt };
    }
  }
  return { endpoint: null, attempts, success: attempts[attempts.length - 1] || null };
}

// Отправка одной команды. Каждый вызов — новое соединение: RCON-сессии дешёвые,
// а долгоживущее соединение чаще рвётся хостингом.
//
// Если основной порт не отвечает (порт закрыт / не RCON / таймаут), а в конфиге
// включён rcon.auto_fallback_port, команда повторяется на резервных портах.
// Итоговый рабочий порт запоминается в module-level переменной fallbackState,
// чтобы не сканировать порты на каждой команде.
const fallbackState = { port: null, checkedAt: 0 };

function candidatePorts(cfg) {
  const mainPort = Number(cfg.port) || 25575;
  if (cfg.auto_fallback_port === false || cfg.use_alternative_ports === false) return [mainPort];
  // Если предыдущая команда уже нашла рабочий резервный порт, сначала пробуем его.
  const learned = fallbackState.port && Date.now() - fallbackState.checkedAt < 10 * 60 * 1000 ? [fallbackState.port] : [];
  const extra = Array.isArray(cfg.alternative_ports) && cfg.alternative_ports.length
    ? cfg.alternative_ports.map(Number).filter(Boolean)
    : [mainPort === 25746 ? 25577 : 25746, 25575, 25777];
  return [...new Set([...learned, mainPort, ...extra])].filter(port => port > 0 && port < 65536);
}

async function rconSend(cfg = {}, command, logger = console) {
  const host = String(cfg.host || '127.0.0.1');
  const timeout = Number(cfg.timeout_ms) || 8000;
  const retries = Math.max(0, Number(cfg.retries) || 0);
  const { password, passwordEnv } = resolvePassword(cfg);
  const debug = isDebugEnabled(cfg);
  const log = makeDebugLogger(logger, debug);

  if (cfg.enabled === false) return { ok: false, response: null, error: 'rcon_disabled', code: 'disabled' };
  if (cfg.dry_run) {
    log.info(`[rcon] DRY-RUN: команда "${command}" не отправлена (rcon.dry_run = true).`);
    return { ok: true, response: 'dry_run', error: null, code: 'dry_run', dryRun: true, command };
  }
  if (!password) return { ok: false, response: null, error: `no_${passwordEnv.toLowerCase()}`, code: 'no_password', port: null };

  const ports = candidatePorts(cfg);
  log.debug(`команда "${command}" → порты в порядке проверки: ${ports.join(', ')} (пароль ${maskSecret(password)})`);

  let last = { ok: false, response: null, error: 'rcon_retries_exhausted', code: 'rcon_error', port: ports[0] };

  for (const port of ports) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 500 * attempt));
      let rcon = null;
      const started = Date.now();
      try {
        log.debug(`соединение ${host}:${port} (попытка ${attempt + 1}/${retries + 1})`);
        // maxPending: 1 заставляет rcon-client сыпать MaxListenersExceededWarning:
        // его внутренний EventEmitter держит 2 слушателя 'end' на один пакет.
        rcon = new SafeRcon({ host, port, password, timeout });
        rcon.on('error', e => log.debug(`событие error ${host}:${port}: ${e?.code || ''} ${e?.message || e}`));
        // rcon-client сам добавляет слушатель 'end'; без увеличения лимита Node
        // сыплет MaxListenersExceededWarning на каждый вызов.
        if (typeof rcon.setMaxListeners === 'function') rcon.setMaxListeners(10);
        await rcon.connect();
        log.debug(`AUTH OK на ${host}:${port} за ${Date.now() - started} мс, отправляю команду`);

        const commandStarted = Date.now();
        const response = String((await rcon.send(command)) ?? '').trim();
        log.info(`[rcon] ${host}:${port} > ${command} → "${response}" (${Date.now() - commandStarted} мс)`);

        if (port !== Number(cfg.port)) {
          log.warn(`[rcon] Команда выполнена на резервном порту ${port} (в конфиге указан ${cfg.port}). ` +
            'Пропиши рабочий порт в config.json → rcon.port.');
        }
        fallbackState.port = port;
        fallbackState.checkedAt = Date.now();
        return { ok: true, response, error: null, code: 'ok', port, ms: Date.now() - started, command };
      } catch (e) {
        const classified = classifyRconError(e);
        last = {
          ok: false, response: null, error: `${classified.code}: ${classified.message}`,
          code: classified.code, port, ms: Date.now() - started, command
        };
        log.debug(`НЕ ВЫПОЛНЕНО ${host}:${port}: [${classified.code}] ${classified.message} (${e?.code || ''})`);
        log.warn(`[rcon] ${host}:${port} > ${command} НЕ ВЫПОЛНЕНО [${classified.code}]: ${classified.message}`);
        // Нет смысла повторять на этом порту, если пароль отвергнут:
        // порт живой и это именно RCON, но credentials неверные.
        if (classified.code === 'auth_failed' || classified.code === 'dns') return last;
        // Порт закрыт / не RCON / таймаут — пробуем следующий порт из списка.
        if (['port_closed', 'not_rcon', 'timeout'].includes(classified.code)) break;
      } finally {
        if (rcon) {
          try { await rcon.end(); } catch {}
        }
      }
    }
  }
  return last;
}
module.exports = {
  rconDiagnose, rconFindEndpoint, rconSend, rconPreflight, tcpProbe, classifyRconError,
  isDebugEnabled, candidatePorts, DEFAULT_ALTERNATIVE_PORTS, SafeRcon, resolvePassword
};
