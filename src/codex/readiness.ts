import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateJson } from '../config/config.ts';
import type { Config } from '../config/config.ts';
import type { AgentConfig } from '../network/config.ts';
import type { CodexPort, Thread } from '../types.ts';

function acceptsInput(thread: Thread): boolean {
  return thread.status.type !== 'notLoaded' && thread.canAcceptDirectInput === true;
}

export async function checkCodexReadiness(codex: CodexPort, threadIds: readonly string[]): Promise<number> {
  const threads = await codex.listThreads();
  const selected = threadIds.length ? [...new Set(threadIds)].map((id) => {
    const thread = threads.find((thread) => thread.id === id);
    if (!thread) throw new Error('Сервер не вернул все выбранные задачи. Проверьте codex.threadIds и подключение к исходному клиенту.');
    return thread;
  }) : threads.filter(acceptsInput);
  if (!selected.length) throw new Error('Нет открытых задач, принимающих сообщения. Откройте задачу в исходном клиенте и проверьте подключение к его серверу.');
  for (const thread of selected) {
    if (!acceptsInput(thread)) throw new Error('Не все выбранные задачи открыты и принимают сообщения. Откройте их в исходном клиенте и повторите doctor.');
    await codex.listTurns(thread);
    await codex.listQueue(thread.id);
  }
  return selected.length;
}

export async function ensureCodexStartup(directory: string, config: Config | AgentConfig, codex: CodexPort): Promise<void> {
  const identity = 'role' in config
    ? ['agent', config.hostId, config.hubId, config.serverUrl, config.chatId]
    : ['local', config.hostId, config.telegram.botId, config.telegram.userId, config.telegram.chatId];
  const fingerprint = createHash('sha256').update(JSON.stringify([
    identity, config.codex.transport ?? 'unix', config.codex.sessionsPath, config.codex.socketPath, [...new Set(config.codex.threadIds)].sort(),
  ])).digest('hex');
  const path = join(directory, 'codex-readiness.json');
  const raw = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw new Error('Не удалось прочитать результат проверки Codex. Проверьте права на каталог настроек.');
  });
  let saved: { version?: number; fingerprint?: string } | null = null;
  try { saved = JSON.parse(raw); } catch { /* Отсутствующий или повреждённый результат требует новой проверки. */ }
  if (saved?.version === 1 && saved.fingerprint === fingerprint) return;
  await checkCodexReadiness(codex, config.codex.threadIds);
  // Сохраняется только успешная проверка протокола, а не доказательство связи с окном приложения.
  await writePrivateJson(path, { version: 1, fingerprint });
}
