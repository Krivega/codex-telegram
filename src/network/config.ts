import { readFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaults, validateConfig, validateExecutionSettings, writePrivateJson } from '../config/config.ts';
import type { Config } from '../config/config.ts';

export type HubConfig = {
  version: 2; role: 'hub'; id: string; publicUrl: string;
  listen: { host: string; port: number; tls?: { certPath: string; keyPath: string } };
  telegram: Config['telegram']; artifacts: Config['artifacts']; notifications: Config['notifications'];
  offlineAfterMs: number;
};
export type AgentConfig = {
  version: 2; role: 'agent'; hostId: string; hubId: string; serverUrl: string; chatId: number;
  codex: Config['codex']; artifacts: Config['artifacts']; notifications: Config['notifications'];
};
export type NetworkConfig = HubConfig | AgentConfig;
export function isLoopback(host: string): boolean { return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host); }
export function serverUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Укажите адрес единого узла.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Неверный адрес единого узла.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Укажите только протокол, имя узла и порт, без пути и секретов.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) throw new Error('Для удалённого соединения требуется HTTPS. HTTP разрешён только через локальный адрес, например внутри SSH-туннеля.');
  return url.origin;
}
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Неверные или неизвестные поля настроек. Секреты хранятся отдельно.');
}
export function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[\w-]{1,100}$/.test(value)) throw new Error('Неверный идентификатор.');
}
export function hubDefaults(): HubConfig {
  const base = defaults();
  return { version: 2, role: 'hub', id: randomUUID(), publicUrl: 'http://127.0.0.1:8787', listen: { host: '127.0.0.1', port: 8787 }, telegram: base.telegram, artifacts: base.artifacts, notifications: base.notifications, offlineAfterMs: 60000 };
}
export function validateNetworkConfig(value: unknown): NetworkConfig {
  object(value, ['version', 'role', 'id', 'hostId', 'hubId', 'publicUrl', 'serverUrl', 'listen', 'telegram', 'chatId', 'codex', 'artifacts', 'notifications', 'offlineAfterMs']);
  if (value.version !== 2) throw new Error('Неподдерживаемая версия сетевых настроек.');
  const config = value as NetworkConfig;
  if (config.role === 'hub') {
    object(config, ['version', 'role', 'id', 'publicUrl', 'listen', 'telegram', 'artifacts', 'notifications', 'offlineAfterMs']);
    identifier(config.id); serverUrl(config.publicUrl);
    object(config.listen, ['host', 'port', 'tls']);
    if (typeof config.listen.host !== 'string' || !config.listen.host || !Number.isInteger(config.listen.port) || config.listen.port < 1 || config.listen.port > 65535) throw new Error('Неверный адрес или порт приёма соединений.');
    if (config.listen.tls) {
      if (new URL(config.publicUrl).protocol !== 'https:') throw new Error('Для встроенного TLS укажите publicUrl с HTTPS.');
      object(config.listen.tls, ['certPath', 'keyPath']);
      if (![config.listen.tls.certPath, config.listen.tls.keyPath].every((path) => typeof path === 'string' && isAbsolute(path))) throw new Error('Пути сертификата и ключа TLS должны быть абсолютными.');
    } else if (!isLoopback(config.listen.host)) throw new Error('HTTP-сервер разрешено слушать только на локальном адресе. Настройте TLS или обратный прокси.');
    if (!Number.isInteger(config.offlineAfterMs) || config.offlineAfterMs < 10000 || config.offlineAfterMs > 3600000) throw new Error('offlineAfterMs должен быть от 10000 до 3600000.');
    validateConfig({ ...defaults(), telegram: config.telegram, notifications: config.notifications, artifacts: config.artifacts });
    return config;
  }
  if (config.role === 'agent') {
    object(config, ['version', 'role', 'hostId', 'hubId', 'serverUrl', 'chatId', 'codex', 'artifacts', 'notifications']);
    identifier(config.hostId); identifier(config.hubId); serverUrl(config.serverUrl);
    if (!Number.isSafeInteger(config.chatId) || config.chatId <= 0) throw new Error('Неверный идентификатор личного чата.');
    validateExecutionSettings(config);
    return config;
  }
  throw new Error('Выберите роль hub или agent.');
}
export async function saveNetworkConfig(directory: string, config: NetworkConfig, secret: string): Promise<void> {
  validateNetworkConfig(config);
  validateSecret(config, secret);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writePrivateJson(join(directory, 'secrets.json'), config.role === 'hub' ? { telegramBotToken: secret } : { agentToken: secret });
  await writePrivateJson(join(directory, 'config.json'), config);
}
function validateSecret(config: NetworkConfig, value: unknown): asserts value is string {
  const pattern = config.role === 'hub' ? /^\d+:[\w-]{20,}$/ : /^[a-f0-9]{64}$/;
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('Секрет не найден или имеет неверный формат. Повторите setup.');
}
export async function loadNetworkConfig(directory: string): Promise<{ config: NetworkConfig; secret: string }> {
  const config = validateNetworkConfig(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')));
  const secrets = JSON.parse(await readFile(join(directory, 'secrets.json'), 'utf8'));
  const secret: unknown = config.role === 'hub' ? process.env.TELEGRAM_BOT_TOKEN ?? secrets.telegramBotToken : secrets.agentToken;
  validateSecret(config, secret);
  return { config, secret };
}
