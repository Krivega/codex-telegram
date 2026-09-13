import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { access, mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { defaults, loadConfig, saveConfig } from '../config/config.ts';
import type { Config } from '../config/config.ts';
import { configureTelegram } from './telegram.ts';
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
    console.log(`Настройки и состояние: ${directory}`);
    const binding = await configureTelegram(async (prompt) => {
      process.stdout.write(prompt); hidden = true;
      try { return await ask(''); } finally { hidden = false; process.stdout.write('\n'); }
    }, existing ? { telegram: config.telegram, token: existing.token } : undefined);
    config.telegram = binding.telegram;
    config.codex.executable = await ask(`Программа Codex [${config.codex.executable}]: `) || config.codex.executable;
    const socket = await ask(`Адрес локального сокета Codex [${config.codex.socketPath}]: `);
    if (socket) config.codex.socketPath = isAbsolute(socket) ? socket : resolve(socket);
    const selected = await ask(`Задачи: all — все основные задачи, либо идентификаторы через запятую [${config.codex.threadIds.join(',') || 'all'}]: `);
    if (selected) config.codex.threadIds = selected === 'all' ? [] : selected.split(',').map((id) => id.trim()).filter(Boolean);
    const interval = await ask(`Интервал проверки в секундах [${config.codex.pollIntervalMs / 1000}]: `);
    if (interval) config.codex.pollIntervalMs = Number(interval) * 1000;
    await saveConfig(directory, config, binding.token);
    await access(config.codex.socketPath).catch(() => console.log('Сокет пока не найден. Проверьте подключение к общему серверу Codex перед запуском.'));
    console.log('Настройка сохранена. Следующая команда: npm run doctor. Затем npm start.');
  } finally { hidden = false; input.close(); await release(); }
}
