import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { defaults, loadConfig, saveConfig } from '../config/config.ts';
import type { Config } from '../config/config.ts';
import { TelegramClient } from '../telegram/client.ts';
import { acquireLock } from '../storage/lock.ts';

export async function setup(directory: string): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('Пошаговая настройка требует терминал. Для автоматической настройки используйте config.example.json и TELEGRAM_BOT_TOKEN.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await acquireLock(directory);
  let hidden = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  const ask = async (prompt: string): Promise<string> => (await input.question(prompt)).trim();
  try {
    const hasConfig = await access(join(directory, 'config.json')).then(() => true, () => false);
    const existing = hasConfig ? await loadConfig(directory) : undefined;
    const config: Config = existing?.config ?? defaults();
    console.log(`Настройки и состояние: ${directory}\nСоздайте отдельного бота через @BotFather. Токен не будет отображаться.`);
    process.stdout.write(existing ? 'Токен бота [Enter — сохранить текущий]: ' : 'Токен бота: ');
    hidden = true;
    const enteredToken = await ask('');
    hidden = false; process.stdout.write('\n');
    const token = enteredToken || existing?.token || process.env.TELEGRAM_BOT_TOKEN;
    if (!token || !/^\d+:[\w-]{20,}$/.test(token)) throw new Error('Неверный формат токена.');
    const telegram = new TelegramClient(token);
    const me = await telegram.getMe();
    if ((await telegram.getWebhookInfo()).url) throw new Error('У этого бота уже настроен webhook. Используйте отдельного бота или отключите прежнюю интеграцию самостоятельно.');
    if (existing && me.id !== existing.config.telegram.botId) throw new Error('Для другого бота используйте отдельный CODEX_TELEGRAM_HOME, чтобы не смешивать задачи.');
    console.log(`Бот проверен: @${me.username}`);
    if (!existing) {
      const code = randomBytes(16).toString('hex');
      console.log(`Откройте https://t.me/${me.username}?start=${code} и нажмите «Запустить».\nОжидаю одноразовый код в личном чате (до двух минут).`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      let offset = 0;
      try {
        while (!controller.signal.aborted) {
          const updates = await telegram.getUpdates(offset, controller.signal);
          for (const update of updates) {
            offset = Math.max(offset, update.update_id + 1);
            const message = update.message;
            if (message?.text !== `/start ${code}` || message.chat.type !== 'private' || !message.from || message.from.is_bot || message.from.id !== message.chat.id) continue;
            config.telegram = { userId: message.from.id, chatId: message.chat.id, botId: me.id, initialOffset: offset };
            break;
          }
          if (config.telegram.userId) break;
        }
      } finally { clearTimeout(timer); }
      if (!config.telegram.userId) throw new Error('Привязка не завершена. Запустите настройку ещё раз.');
    }
    console.log(`Владелец Telegram: ${config.telegram.userId}`);
    config.codex.executable = await ask(`Программа Codex [${config.codex.executable}]: `) || config.codex.executable;
    const socket = await ask(`Адрес локального сокета Codex [${config.codex.socketPath}]: `);
    if (socket) config.codex.socketPath = isAbsolute(socket) ? socket : resolve(socket);
    const selected = await ask(`Задачи: all — все основные задачи, либо идентификаторы через запятую [${config.codex.threadIds.join(',') || 'all'}]: `);
    if (selected) config.codex.threadIds = selected === 'all' ? [] : selected.split(',').map((id) => id.trim()).filter(Boolean);
    const interval = await ask(`Интервал проверки в секундах [${config.codex.pollIntervalMs / 1000}]: `);
    if (interval) config.codex.pollIntervalMs = Number(interval) * 1000;
    await saveConfig(directory, config, token);
    await access(config.codex.socketPath).catch(() => console.log('Сокет пока не найден. Проверьте подключение к общему серверу Codex перед запуском.'));
    console.log('Настройка сохранена. Следующая команда: npm run doctor. Затем npm start.');
  } finally { hidden = false; input.close(); await release(); }
}
