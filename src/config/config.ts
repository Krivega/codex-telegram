import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Config = {
  version: 1;
  hostId: string;
  telegram: { userId: number; chatId: number; botId: number; initialOffset: number };
  codex: { executable: string; socketPath: string; threadIds: string[]; pollIntervalMs: number };
  notifications: { maxTextLength: number };
  artifacts: { maxFileBytes: number; maxFiles: number };
};
export function configDirectory(): string {
  if (process.env.CODEX_TELEGRAM_HOME) return resolve(process.env.CODEX_TELEGRAM_HOME);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'codex-telegram');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? homedir(), 'codex-telegram');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'codex-telegram');
}
export function defaults(): Config {
  return {
    version: 1,
    hostId: randomUUID(),
    telegram: { userId: 0, chatId: 0, botId: 0, initialOffset: 0 },
    codex: {
      executable: 'codex',
      socketPath: join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock'),
      threadIds: [], pollIntervalMs: 5000,
    },
    notifications: { maxTextLength: 3200 },
    artifacts: { maxFileBytes: 20 * 1024 * 1024, maxFiles: 5 },
  };
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`Параметр ${name}: требуется целое число от ${min} до ${max}.`);
  }
  return value as number;
}
function fields(value: object, allowed: string[], name: string): void {
  if (Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`В разделе ${name} есть неизвестные поля. Сверьте настройки с config.example.json; секреты хранятся отдельно.`);
}
export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== 'object') throw new Error('Настройки должны быть объектом JSON.');
  const c = value as Config;
  if (c.version !== 1 || typeof c.hostId !== 'string' || !/^[\w-]{8,80}$/.test(c.hostId)) throw new Error('Неверная версия настроек или hostId.');
  if (!c.telegram || !c.codex || !c.notifications || !c.artifacts) throw new Error('В настройках отсутствует обязательный раздел.');
  fields(c, ['version', 'hostId', 'telegram', 'codex', 'notifications', 'artifacts'], 'config');
  fields(c.telegram, ['userId', 'chatId', 'botId', 'initialOffset'], 'telegram');
  fields(c.codex, ['executable', 'socketPath', 'threadIds', 'pollIntervalMs'], 'codex');
  fields(c.notifications, ['maxTextLength'], 'notifications');
  fields(c.artifacts, ['maxFileBytes', 'maxFiles'], 'artifacts');
  integer(c.telegram.userId, 'telegram.userId', 1, Number.MAX_SAFE_INTEGER);
  integer(c.telegram.chatId, 'telegram.chatId', 1, Number.MAX_SAFE_INTEGER);
  integer(c.telegram.botId, 'telegram.botId', 1, Number.MAX_SAFE_INTEGER);
  integer(c.telegram.initialOffset, 'telegram.initialOffset', 0, Number.MAX_SAFE_INTEGER);
  if (c.telegram.userId !== c.telegram.chatId) throw new Error('Первая версия поддерживает личный чат владельца с ботом.');
  if (typeof c.codex.executable !== 'string' || !c.codex.executable.trim()) throw new Error('Не указан исполняемый файл Codex.');
  if (typeof c.codex.socketPath !== 'string' || !isAbsolute(c.codex.socketPath)) throw new Error('codex.socketPath должен быть абсолютным путём.');
  if (!Array.isArray(c.codex.threadIds) || c.codex.threadIds.some((id) => typeof id !== 'string' || !/^[\w-]+$/.test(id))) throw new Error('Неверный список codex.threadIds.');
  integer(c.codex.pollIntervalMs, 'codex.pollIntervalMs', 1000, 300000);
  integer(c.notifications.maxTextLength, 'notifications.maxTextLength', 200, 3500);
  integer(c.artifacts.maxFileBytes, 'artifacts.maxFileBytes', 1024, 49 * 1024 * 1024);
  integer(c.artifacts.maxFiles, 'artifacts.maxFiles', 1, 10);
  return c;
}
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(tmp, path);
  await chmod(path, 0o600);
}
export async function saveConfig(directory: string, config: Config, token: string): Promise<void> {
  validateConfig(config);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writePrivateJson(join(directory, 'secrets.json'), { telegramBotToken: token });
  await writePrivateJson(join(directory, 'config.json'), config);
}
export async function loadConfig(directory: string): Promise<{ config: Config; token: string }> {
  let raw: string;
  try { raw = await readFile(join(directory, 'config.json'), 'utf8'); }
  catch { throw new Error('Настройки не найдены. Выполните npm run setup.'); }
  const config = validateConfig(JSON.parse(raw));
  let token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    try { token = JSON.parse(await readFile(join(directory, 'secrets.json'), 'utf8')).telegramBotToken; }
    catch { throw new Error('Не найден токен бота. Выполните настройку или задайте TELEGRAM_BOT_TOKEN.'); }
  }
  if (typeof token !== 'string' || !/^\d+:[\w-]{20,}$/.test(token)) throw new Error('Неверный формат токена Telegram.');
  return { config, token };
}
