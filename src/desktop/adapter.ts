import { join } from 'node:path';
import type { Config } from '../config/config.ts';
import type { CodexPort, Thread, Turn, QueuedMessage } from '../types.ts';
import { CodexUnavailableError, RejectedOperationError } from '../types.ts';
import { DesktopMailbox } from './mailbox.ts';
import { RolloutReader, requestMarker } from './rollouts.ts';

type DesktopSettings = Pick<Config, 'hostId' | 'codex'> & { telegram?: Config['telegram']; hubId?: string; chatId?: number };

export class DesktopAdapter implements CodexPort {
  onDiagnostic: (message: string) => void = () => {};
  readonly mailbox: DesktopMailbox;
  private reader: RolloutReader;
  private config: DesktopSettings;
  constructor(directory: string, config: DesktopSettings) {
    this.config = config;
    if (!config.codex.sessionsPath) throw new Error('Desktop требует sessionsPath.');
    this.reader = new RolloutReader(config.codex.sessionsPath, config.codex.threadIds);
    this.mailbox = new DesktopMailbox(join(directory, 'desktop.sqlite'), JSON.stringify([config.hostId, config.codex.sessionsPath, config.telegram?.botId, config.telegram?.userId, config.telegram?.chatId, config.hubId, config.chatId]));
  }
  close(): void { this.mailbox.close(); }
  permitsThread(id: string): boolean {
    return (!this.config.codex.threadIds.length || this.config.codex.threadIds.includes(id)) && !this.mailbox.dispatchers().includes(id);
  }
  async listThreads(): Promise<Thread[]> {
    const ids = (await this.reader.discover()).filter((id) => this.permitsThread(id));
    if (!this.config.codex.threadIds.length && !this.mailbox.dispatchers().length) throw new CodexUnavailableError('Сначала зарегистрируйте задачу-диспетчер через плагин: desktop_register.');
    const threads: Thread[] = [];
    for (const id of ids) {
      try { threads.push(await this.readThread(id)); }
      catch (error) {
        if (this.config.codex.threadIds.length) throw error;
        this.onDiagnostic(`Не удалось прочитать журнал задачи ${id}. Остальные задачи продолжают работать.`);
      }
    }
    return threads.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }
  async readThread(id: string): Promise<Thread> {
    if (!this.permitsThread(id)) throw new RejectedOperationError('Доступ к задаче отключён или она является диспетчером.');
    return this.reader.read(id);
  }
  async listTurns(thread: Thread): Promise<Turn[]> {
    const turns = (await this.readThread(thread.id)).turns!;
    for (const turn of turns) for (const item of turn.items) {
      if (item.clientId) this.mailbox.observe(item.clientId, thread.id);
    }
    return turns;
  }
  async queueMessage(threadId: string, clientId: string, text: string): Promise<QueuedMessage> {
    if (!this.permitsThread(threadId)) throw new RejectedOperationError('Доступ к задаче отключён.');
    if (!/^[\w-]+$/.test(clientId)) throw new RejectedOperationError('Недопустимый идентификатор поручения.');
    await this.readThread(threadId);
    this.mailbox.enqueue(clientId, threadId, `${requestMarker(clientId)}\n${text}`);
    return { id: clientId, clientUserMessageId: clientId };
  }
  async listQueue(threadId: string): Promise<QueuedMessage[]> {
    return this.mailbox.queue(threadId).map(({ id }) => ({ id, clientUserMessageId: id }));
  }
  async startQueued(threadId: string, id: string): Promise<void> { this.mailbox.ready(id, threadId); }
  async claim(): Promise<{ id: string; threadId: string; prompt: string; token: string } | null> {
    for (const thread of await this.listThreads()) {
      const id = thread.id;
      await this.listTurns(thread);
      if (thread.status.type !== 'idle') continue;
      const first = this.mailbox.queue(id)[0];
      if (first?.state !== 'ready') continue;
      const claimed = this.mailbox.claim(first.id);
      if (claimed) return { id: claimed.id, threadId: claimed.threadId, prompt: claimed.text, token: claimed.token! };
    }
    return null;
  }
}
