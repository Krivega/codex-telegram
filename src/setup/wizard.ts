import { configureExecution } from './execution.ts';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
    config.codex = await configureExecution(config.codex, ask);
    await saveConfig(directory, config, binding.token);
    if (config.codex.transport !== 'desktop') await access(config.codex.socketPath).catch(() => console.log('Сокет пока не найден. Проверьте подключение к общему серверу Codex перед запуском.'));
    console.log('Настройка сохранена. Следующая команда: npm run doctor. Затем npm start.');
  } finally { hidden = false; input.close(); await release(); }
}
