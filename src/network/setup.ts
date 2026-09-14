import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaults, writePrivateJson } from '../config/config.ts';
import { acquireLock } from '../storage/lock.ts';
import { configureTelegram } from '../setup/telegram.ts';
import { configureCodexExecutable } from '../setup/codex.ts';
import { HubClient } from './client.ts';
import { hubDefaults, loadNetworkConfig, saveNetworkConfig, serverUrl } from './config.ts';
import type { AgentConfig, HubConfig, NetworkConfig } from './config.ts';
import { record, secret, string, idPattern, positive } from './protocol.ts';

type Ask = (prompt: string) => Promise<string>;
async function configureHub(ask: Ask, hidden: Ask, existing?: { config: HubConfig; secret: string }): Promise<{ config: HubConfig; secret: string }> {
  const config = existing?.config ?? hubDefaults();
  console.log('Единый узел — единственная служба, которой нужен токен бота из @BotFather.');
  const binding = await configureTelegram(hidden, existing ? { telegram: config.telegram, token: existing.secret } : undefined);
  config.telegram = binding.telegram;
  config.publicUrl = serverUrl(await ask(`Адрес для компьютеров [${config.publicUrl}]: `) || config.publicUrl);
  config.listen.host = await ask(`Адрес приёма соединений [${config.listen.host}]: `) || config.listen.host;
  config.listen.port = Number(await ask(`Порт [${config.listen.port}]: `) || config.listen.port);
  const cert = await ask(`Сертификат TLS, абсолютный путь [${config.listen.tls?.certPath ?? 'Enter — HTTP только на локальном адресе'}]: `);
  if (cert) config.listen.tls = { certPath: resolve(cert), keyPath: resolve(await ask('Закрытый ключ TLS, путь: ')) };
  return { config, secret: binding.token };
}
async function configureAgent(directory: string, ask: Ask, hidden: Ask, existing?: { config: AgentConfig; secret: string }): Promise<{ config: AgentConfig; secret: string }> {
  let config: AgentConfig; let token: string;
  if (existing) {
    config = existing.config; token = existing.secret;
    config.serverUrl = serverUrl(await ask(`Адрес единого узла [${config.serverUrl}]: `) || config.serverUrl);
  }
  else {
    const pendingPath = join(directory, 'pending-pair.json');
    const hasPending = await access(pendingPath).then(() => true, () => false);
    let pending: { url: string; code: string; token: string };
    if (hasPending) {
      const saved = record(JSON.parse(await readFile(pendingPath, 'utf8')));
      pending = { url: serverUrl(saved.url), code: secret(saved.code), token: secret(saved.token) };
      console.log(`Продолжение подключения к ${pending.url}. Для другого подключения удалите pending-pair.json.`);
    } else {
      pending = { url: serverUrl(await ask('Адрес единого узла (HTTPS или локальный SSH-туннель): ')), code: secret(await hidden('Одноразовый код из команды pair на едином узле: ')), token: randomBytes(32).toString('hex') };
      // Сохраняем ключ до запроса: потерянный сетевой ответ не создаёт вторую регистрацию.
      await writePrivateJson(pendingPath, pending);
    }
    const paired = record(await new HubClient(pending.url, pending.token).request('/v1/pair', { code: pending.code, token: pending.token }));
    token = pending.token;
    config = { version: 2, role: 'agent', hostId: string(paired.hostId, 100, idPattern), serverUrl: pending.url, hubId: string(paired.hubId, 100, idPattern), chatId: positive(paired.chatId), codex: defaults().codex, notifications: paired.notifications as AgentConfig['notifications'], artifacts: paired.artifacts as AgentConfig['artifacts'] };
    // Привязка сохраняется сразу; дальнейшее прерывание мастера не теряет идентификатор.
    await saveNetworkConfig(directory, config, token);
    await unlink(pendingPath);
    console.log(`Компьютер зарегистрирован: ${string(paired.name, 60)}. Токен Telegram не передавался.`);
  }
  config.codex.executable = await configureCodexExecutable(ask, config.codex.executable);
  const socket = await ask(`Сокет общего сервера Codex [${config.codex.socketPath}]: `);
  if (socket) config.codex.socketPath = resolve(socket);
  const threads = await ask(`Задачи: all или идентификаторы через запятую [${config.codex.threadIds.join(',') || 'all'}]: `);
  if (threads) config.codex.threadIds = threads === 'all' ? [] : threads.split(',').map((id) => id.trim()).filter(Boolean);
  const interval = await ask(`Интервал проверки Codex, секунды [${config.codex.pollIntervalMs / 1000}]: `);
  if (interval) config.codex.pollIntervalMs = Number(interval) * 1000;
  return { config, secret: token };
}
export async function setupNetwork(directory: string, requestedRole?: string): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('Для пошаговой настройки откройте терминал. Образцы для автоматической установки находятся в examples/.');
  await mkdir(directory, { recursive: true, mode: 0o700 }); const release = await acquireLock(directory);
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done(); } });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  const ask: Ask = async (prompt) => (await input.question(prompt)).trim();
  const hidden: Ask = async (prompt) => { process.stdout.write(prompt); muted = true; try { return await ask(''); } finally { muted = false; process.stdout.write('\n'); } };
  try {
    const hasConfig = await access(join(directory, 'config.json')).then(() => true, () => false);
    const existing = hasConfig ? await loadNetworkConfig(directory) : undefined;
    const role = requestedRole ?? existing?.config.role ?? (await ask('Роль: 1 — единый узел с ботом, 2 — компьютер с Codex [1]: ') === '2' ? 'agent' : 'hub');
    if (role !== 'hub' && role !== 'agent') throw new Error('Укажите --role hub или --role agent.');
    if (existing && existing.config.role !== role) throw new Error('Для другой роли нужен отдельный каталог --home. Существующие настройки сохранены.');
    let result: { config: NetworkConfig; secret: string };
    if (role === 'hub') result = await configureHub(ask, hidden, existing?.config.role === 'hub' ? { config: existing.config, secret: existing.secret } : undefined);
    else result = await configureAgent(directory, ask, hidden, existing?.config.role === 'agent' ? { config: existing.config, secret: existing.secret } : undefined);
    await saveNetworkConfig(directory, result.config, result.secret);
    console.log(`Настройка сохранена: ${directory}. Выполните doctor, затем start с тем же --home.`);
  } finally { muted = false; input.close(); await release(); }
}
