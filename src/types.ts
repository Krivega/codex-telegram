export type Thread = {
  id: string;
  name?: string | null;
  preview?: string;
  cwd: string;
  updatedAt: number;
  parentThreadId?: string | null;
  canAcceptDirectInput?: boolean | null;
  status: { type: string; activeFlags?: string[] };
  turns?: Turn[];
};
export type Turn = {
  id: string;
  status: string;
  startedAt?: number | null;
  completedAt?: number | null;
  error?: { message: string } | null;
  items: Array<{
    type: string;
    text?: string;
    phase?: string | null;
    clientId?: string | null;
  }>;
};
export type QueuedMessage = { id: string; clientUserMessageId: string };
export interface CodexPort {
  permitsThread?(id: string): boolean;
  onDiagnostic?: (message: string) => void;
  listThreads(): Promise<Thread[]>;
  readThread(id: string): Promise<Thread>;
  listTurns(thread: Thread): Promise<Turn[]>;
  queueMessage(threadId: string, clientId: string, text: string): Promise<QueuedMessage>;
  listQueue(threadId: string): Promise<QueuedMessage[]>;
  startQueued(threadId: string, queuedId: string): Promise<void>;
  close(): void;
}
export type TelegramMessage = {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; is_bot?: boolean };
  text?: string;
  reply_to_message?: { message_id: number };
};
export type TelegramUpdate = { update_id: number; message?: TelegramMessage };
export interface TelegramPort {
  getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendText(chatId: number, text: string, replyTo?: number): Promise<number>;
  sendDocument(chatId: number, file: Buffer, name: string, replyTo?: number): Promise<number>;
}
export class UncertainOperationError extends Error {}
export class CodexUnavailableError extends Error {}
export class RejectedOperationError extends Error {
  retryAfter: number | undefined;
  constructor(message: string, retryAfter?: number) {
    super(message);
    this.retryAfter = retryAfter;
  }
}
