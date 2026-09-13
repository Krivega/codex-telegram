import type { CodexPort, Thread, Turn, QueuedMessage } from '../types.ts';
import { CodexUnavailableError, RejectedOperationError } from '../types.ts';
import { CodexRpc, RpcError } from './rpc.ts';

export class CodexAdapter implements CodexPort {
  private rpc: CodexRpc;
  constructor(rpc: CodexRpc) { this.rpc = rpc; }
  private async call<T>(method: string, params: unknown): Promise<T> {
    await this.rpc.connect(); return this.rpc.request<T>(method, params);
  }
  async listThreads(): Promise<Thread[]> {
    const threads: Thread[] = [];
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const page: { data: Thread[]; nextCursor: string | null } = await this.call('thread/list', {
        cursor, limit: 100, sortKey: 'updated_at', sortDirection: 'desc', archived: false,
      });
      threads.push(...page.data.filter((thread) => !thread.parentThreadId));
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Codex повторил страницу задач.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return threads;
  }
  async readThread(id: string): Promise<Thread> {
    return (await this.call<{ thread: Thread }>('thread/read', { threadId: id, includeTurns: false })).thread;
  }
  async listTurns(thread: Thread): Promise<Turn[]> {
    const turns: Turn[] = [];
    let cursor: string | null = null;
    const cursors = new Set<string>();
    try {
      do {
        const page: { data: Turn[]; nextCursor: string | null } = await this.call('thread/turns/list', {
          threadId: thread.id, cursor, limit: 100, sortDirection: 'desc', itemsView: 'full',
        });
        turns.push(...page.data); cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('Codex повторил страницу истории.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return turns;
    } catch (error) {
      if (!(error instanceof RpcError) || error.code !== -32601) throw error;
      return (await this.call<{ thread: Thread }>('thread/read', { threadId: thread.id, includeTurns: true })).thread.turns ?? [];
    }
  }
  async queueMessage(threadId: string, clientId: string, text: string): Promise<QueuedMessage> {
    let thread: Thread;
    try { thread = await this.readThread(threadId); }
    catch { throw new CodexUnavailableError('Не удалось проверить задачу до отправки поручения.'); }
    if (thread.status.type === 'notLoaded' || thread.canAcceptDirectInput !== true) {
      throw new RejectedOperationError('Откройте эту задачу в Codex на подключённом компьютере. Служба продолжает только доступные задачи общего сервера.');
    }
    return (await this.call<{ queuedSubmission: QueuedMessage }>('thread/queue/add', {
      threadId, clientUserMessageId: clientId, input: [{ type: 'text', text, text_elements: [] }],
    })).queuedSubmission;
  }
  async listQueue(threadId: string): Promise<QueuedMessage[]> {
    const messages: QueuedMessage[] = [];
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const page: { data: QueuedMessage[]; nextCursor: string | null } = await this.call('thread/queue/list', { threadId, cursor, limit: 100 });
      if (!Array.isArray(page.data)) throw new Error('Версия Codex вернула неизвестный формат очереди.');
      messages.push(...page.data); cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Codex повторил страницу очереди.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return messages;
  }
  async startQueued(threadId: string, queuedId: string): Promise<void> {
    await this.call('thread/queue/start', { threadId, queuedSubmissionId: queuedId });
  }
  close(): void { this.rpc.close(); }
}
