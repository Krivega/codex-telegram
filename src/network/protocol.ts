import type { TaskSummary } from '../bridge/worker.ts';
import type { JobState } from '../storage/store.ts';
import type { JobReport } from './store.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Ожидается объект JSON.');
  return value as Record<string, unknown>;
}
export function string(value: unknown, max: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.length || value.length > max || (pattern && !pattern.test(value))) throw new HttpError(400, 'Неверный строковый параметр.');
  return value;
}
export function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new HttpError(400, 'Неверный числовой параметр.');
  return value as number;
}
export const idPattern = /^[\w-]{1,100}$/;
export function secret(value: unknown): string { return string(value, 64, /^[a-f0-9]{64}$/); }
export type Sync = { tasks: TaskSummary[]; codexOnline: boolean; reports: JobReport[] };
export function parseSync(value: unknown): Sync {
  const data = record(value);
  if (typeof data.codexOnline !== 'boolean' || !Array.isArray(data.tasks) || data.tasks.length > 1000 || !Array.isArray(data.reports) || data.reports.length > 200) throw new HttpError(400, 'Неверное состояние компьютера.');
  const tasks = data.tasks.map((value) => {
    const task = record(value);
    return { id: string(task.id, 100, idPattern), name: string(task.name, 180), status: string(task.status, 50) };
  });
  const states: JobState[] = ['pending', 'submitting', 'queued', 'submitted', 'uncertain', 'done', 'failed'];
  const reports = data.reports.map((value) => {
    const report = record(value); const state = string(report.state, 20) as JobState;
    if (!states.includes(state)) throw new HttpError(400, 'Неверное состояние поручения.');
    return { id: string(report.id, 100, idPattern), revision: positive(report.revision), state, ...(report.queuedId === undefined ? {} : { queuedId: string(report.queuedId, 100, idPattern) }) };
  });
  return { tasks, reports, codexOnline: data.codexOnline };
}
export type RemoteEvent = {
  key: string; threadId: string; turnId?: string; replyTo?: number;
  body: { kind: 'text'; text: string; fullText?: string } | { kind: 'file'; name: string; sha256: string };
};
export function parseEvent(value: unknown): RemoteEvent {
  const data = record(value); const body = record(data.body);
  const common = {
    key: string(data.key, 500), threadId: string(data.threadId, 100, idPattern),
    ...(data.turnId === undefined ? {} : { turnId: string(data.turnId, 100, idPattern) }),
    ...(data.replyTo === undefined ? {} : { replyTo: positive(data.replyTo) }),
  };
  if (body.kind === 'text') return { ...common, body: { kind: 'text', text: string(body.text, 4000), ...(body.fullText === undefined ? {} : { fullText: string(body.fullText, 1024 * 1024) }) } };
  if (body.kind === 'file') return { ...common, body: { kind: 'file', name: string(body.name, 150, /^[^/\\\x00-\x1f]+\.(pdf|png|jpe?g|webp)$/i), sha256: secret(body.sha256) } };
  throw new HttpError(400, 'Неверный тип события.');
}
