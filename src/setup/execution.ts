import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Config } from '../config/config.ts';

export async function configureExecution(current: Config['codex'], ask: (prompt: string) => Promise<string>): Promise<Config['codex']> {
  const config = structuredClone(current);
  const transport = await ask(`Подключение: desktop — через приложение и плагин, unix — общий сервер [${config.transport ?? 'desktop'}]: `) || config.transport || 'desktop';
  if (transport !== 'desktop' && transport !== 'unix') throw new Error('Выберите desktop или unix.');
  config.transport = transport;
  if (transport === 'desktop') {
    const path = config.sessionsPath ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
    config.sessionsPath = resolve(await ask(`Каталог журналов Codex [${path}]: `) || path);
  } else {
    config.socketPath = resolve(await ask(`Сокет общего сервера Codex [${config.socketPath}]: `) || config.socketPath);
  }
  const hint = transport === 'desktop' ? 'явные идентификаторы через запятую' : 'all или идентификаторы через запятую';
  const selected = await ask(`Задачи: ${hint} [${config.threadIds.join(',') || (transport === 'desktop' ? 'обязательно' : 'all')}]: `);
  if (selected) config.threadIds = selected === 'all' ? [] : [...new Set(selected.split(',').map((id) => id.trim()).filter(Boolean))];
  if (transport === 'desktop' && !config.threadIds.length) throw new Error('Для Desktop укажите хотя бы одну задачу. Попросите Codex показать её идентификатор.');
  const interval = await ask(`Интервал проверки Codex, секунды [${config.pollIntervalMs / 1000}]: `);
  if (interval) config.pollIntervalMs = Number(interval) * 1000;
  return config;
}
