import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexPort, QueuedMessage, TelegramPort, Thread, Turn } from '../src/types.ts';
import { defaults } from '../src/config/config.ts';
import { Store } from '../src/storage/store.ts';
import { Bridge } from '../src/bridge/bridge.ts';

export class TestCodex implements CodexPort {
  threads: Thread[] = [];
  turns = new Map<string, Turn[]>();
  queue = new Map<string, QueuedMessage[]>();
  submissions: { threadId: string; clientId: string; text: string }[] = [];
  starts: string[] = [];
  submitError: Error | undefined;
  listThreads = async () => this.threads;
  readThread = async (id: string) => this.threads.find((thread) => thread.id === id)!;
  listTurns = async (thread: Thread) => this.turns.get(thread.id) ?? [];
  async queueMessage(threadId: string, clientId: string, text: string): Promise<QueuedMessage> {
    this.submissions.push({ threadId, clientId, text });
    if (this.submitError) throw this.submitError;
    const message = { id: `queue-${clientId}`, clientUserMessageId: clientId };
    this.queue.set(threadId, [...this.queue.get(threadId) ?? [], message]);
    return message;
  }
  listQueue = async (threadId: string) => this.queue.get(threadId) ?? [];
  async startQueued(threadId: string, queuedId: string): Promise<void> {
    this.starts.push(queuedId);
    this.queue.set(threadId, (this.queue.get(threadId) ?? []).filter((item) => item.id !== queuedId));
    this.threads.find((thread) => thread.id === threadId)!.status = { type: 'active' };
  }
  close(): void {}
}
export class TestTelegram implements TelegramPort {
  texts: { id: number; chatId: number; text: string; replyTo?: number }[] = [];
  files: { id: number; bytes: Buffer; name: string }[] = [];
  error: Error | undefined;
  nextId = 100;
  getUpdates = async () => [];
  async sendText(chatId: number, text: string, replyTo?: number): Promise<number> {
    if (this.error) throw this.error;
    const id = this.nextId++;
    this.texts.push({ id, chatId, text, replyTo }); return id;
  }
  async sendDocument(_chatId: number, file: Buffer, name: string): Promise<number> {
    if (this.error) throw this.error;
    const id = this.nextId++; this.files.push({ id, bytes: file, name }); return id;
  }
}
export function thread(id: string): Thread {
  return { id, name: `Задача ${id}`, cwd: tmpdir(), updatedAt: Math.ceil(Date.now() / 1000), status: { type: 'idle' }, canAcceptDirectInput: true };
}
export function completed(id: string, clientId?: string): Turn {
  return { id, status: 'completed', completedAt: Date.now() / 1000 + 1, items: [
    ...(clientId ? [{ type: 'userMessage', clientId }] : []),
    { type: 'agentMessage', text: 'Промежуточный комментарий', phase: 'commentary' },
    { type: 'agentMessage', text: 'Готово. Проверки прошли.', phase: 'final_answer' },
  ] };
}
export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-telegram-test-'));
  const config = defaults();
  config.telegram = { userId: 42, chatId: 42, botId: 123, initialOffset: 0 };
  const store = new Store(join(directory, 'state.sqlite'));
  const codex = new TestCodex(); const telegram = new TestTelegram();
  const bridge = new Bridge(config, directory, store, codex, telegram);
  return { directory, config, store, codex, telegram, bridge, async cleanup() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}
