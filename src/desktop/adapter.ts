import { join } from 'node:path';
import type { Config } from '../config/config.ts';
import type { CodexPort, Thread, Turn, QueuedMessage } from '../types.ts';
import { RejectedOperationError } from '../types.ts';
import { DesktopMailbox } from './mailbox.ts';
import { RolloutReader, requestMarker } from './rollouts.ts';

type DesktopSettings = Pick<Config, 'hostId' | 'codex'> & { telegram?: Config['telegram']; hubId?: string; chatId?: number };

export class DesktopAdapter implements CodexPort {
  readonly mailbox: DesktopMailbox;
  private reader: RolloutReader;
  private config: DesktopSettings;
  constructor(directory: string, config: DesktopSettings) {
    this.config = config;
    if (!config.codex.threadIds.length || !config.codex.sessionsPath) throw new Error('Desktop требует sessionsPath и явный список threadIds.');
    this.reader = new RolloutReader(config.codex.sessionsPath, config.codex.threadIds);
    this.mailbox = new DesktopMailbox(join(directory, 'desktop.sqlite'), JSON.stringify([config.hostId, config.codex.sessionsPath, config.telegram?.botId, config.telegram?.userId, config.telegram?.chatId, config.hubId, config.chatId]));
  }
  close(): void { this.mailbox.close(); }
  async listThreads(): Promise<Thread[]> { return Promise.all(this.config.codex.threadIds.map((id) => this.readThread(id))); }
  async readThread(id: string): Promise<Thread> { return this.reader.read(id); }
  async listTurns(thread: Thread): Promise<Turn[]> {
    const turns = (await this.readThread(thread.id)).turns!;
    for (const turn of turns) for (const item of turn.items) {
      if (item.clientId) this.mailbox.observe(item.clientId, thread.id);
    }
    return turns;
  }
  async queueMessage(threadId: string, clientId: string, text: string): Promise<QueuedMessage> {
    if (!this.config.codex.threadIds.includes(threadId)) throw new RejectedOperationError('Доступ к задаче отключён.');
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
    for (const id of this.config.codex.threadIds) {
      const thread = await this.readThread(id);
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
