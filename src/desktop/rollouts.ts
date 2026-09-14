import { desktopText } from './text.ts';
import { open, lstat } from 'node:fs/promises';
import { DesktopCatalog } from './catalog.ts';
import type { Thread, Turn } from '../types.ts';
import { CodexUnavailableError } from '../types.ts';

type Journal = { inode: number; offset: number; identity?: string; name?: string; cwd: string; turns: Map<string, Turn>; current?: string; updatedAt: number };
const MAX_LINE = 32 * 1024 * 1024;
const MAX_NAME = 180;
export function requestMarker(id: string): string { return `[codex-telegram:${id}]`; }

function taskName(text: unknown): string | undefined {
  if (typeof text !== 'string') return;
  const normalized = desktopText(text).replace(/\r\n?/g, '\n').trim();
  if (!normalized) return;
  const lines = normalized.split('\n').map((line) => line.trim());
  const requestIndex = lines.findIndex((line) => line === '## My request:');
  if (requestIndex < 0 && /^(?:<recommended_plugins>|<environment_context>|# AGENTS\.md instructions for )/.test(normalized)) return;
  const firstLine = (requestIndex >= 0 ? lines.slice(requestIndex + 1) : lines).find(Boolean);
  return firstLine?.replace(/\s+/g, ' ').slice(0, MAX_NAME) || undefined;
}

// Только законченные строки. Курсор не проходит незавершённую запись работающего приложения.
export class RolloutReader {
  private catalog: DesktopCatalog;
  private journals = new Map<string, Journal>();
  private ids: readonly string[];
  constructor(root: string, ids: readonly string[]) { this.catalog = new DesktopCatalog(root); this.ids = ids; }
  async discover(): Promise<string[]> {
    await this.catalog.refresh();
    return this.ids.length ? [...new Set(this.ids)] : this.catalog.ids();
  }
  async read(id: string): Promise<Thread> {
    if (this.ids.length && !this.ids.includes(id)) throw new CodexUnavailableError('Задача отсутствует в разрешённом списке.');
    const entry = await this.catalog.entry(id);
    if (!this.ids.length && !entry.primary) throw new CodexUnavailableError('Задача не относится к основным задачам приложения.');
    const path = entry.path;
    const info = await lstat(path);
    if (!info.isFile()) throw new CodexUnavailableError('Журнал должен быть обычным файлом.');
    let journal = this.journals.get(id);
    if (!journal || journal.inode !== info.ino || info.size < journal.offset) {
      journal = { inode: info.ino, offset: 0, cwd: '', turns: new Map(), updatedAt: 0 };
      this.journals.set(id, journal);
    }
    const handle = await open(path, 'r');
    try {
      let pending = Buffer.alloc(0);
      let position = journal.offset;
      const buffer = Buffer.alloc(256 * 1024);
      while (position < info.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - position), position);
        if (!bytesRead) break;
        position += bytesRead;
        pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
        let end: number;
        while ((end = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, end);
          if (line.length > MAX_LINE) throw new CodexUnavailableError('Запись журнала превышает допустимый размер.');
          if (line.length) {
            try { this.consume(journal, JSON.parse(line.toString('utf8'))); }
            catch { throw new CodexUnavailableError('Не удалось разобрать журнал Codex. Требуется проверка совместимости формата.'); }
          }
          journal.offset += end + 1;
          pending = pending.subarray(end + 1);
        }
        if (pending.length > MAX_LINE) throw new CodexUnavailableError('Запись журнала превышает допустимый размер.');
      }
    } finally { await handle.close(); }
    if (journal.identity !== id || typeof journal.cwd !== 'string' || !journal.cwd) throw new CodexUnavailableError('Формат или идентификатор журнала Codex не прошёл проверку.');
    const turns = [...journal.turns.values()];
    return { id, name: journal.name ?? id, cwd: journal.cwd, updatedAt: journal.updatedAt, canAcceptDirectInput: true,
      status: { type: turns.at(-1)?.status === 'inProgress' ? 'active' : 'idle' }, turns: structuredClone(turns) };
  }
  private consume(journal: Journal, row: any): void {
    const p = row.payload;
    if (!p || typeof p !== 'object') return;
    if (row.type === 'session_meta') {
      if (p.parent_thread_id || p.parentThreadId || (p.thread_source && p.thread_source !== 'user') || (p.source && typeof p.source === 'object')) throw new Error('Служебная задача');
      journal.identity = p.id; journal.cwd = p.cwd; return;
    }
    if (!journal.name && row.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const text = Array.isArray(p.content) ? p.content.filter((item: any) => item?.type === 'input_text').map((item: any) => item.text).join('\n') : p.content;
      journal.name = taskName(text);
    }
    if (row.type !== 'event_msg' || (p.thread_id !== undefined && p.thread_id !== journal.identity)) return;
    const timestamp = Date.parse(row.timestamp) / 1000;
    if (p.type === 'task_started' && typeof p.turn_id === 'string') {
      journal.current = p.turn_id;
      if (!journal.turns.has(p.turn_id)) journal.turns.set(p.turn_id, { id: p.turn_id, status: 'inProgress', startedAt: p.started_at ?? timestamp, items: [] });
    }
    const turn = journal.turns.get(p.turn_id ?? journal.current);
    if (!turn) return;
    if (Number.isFinite(timestamp)) journal.updatedAt = Math.max(journal.updatedAt, timestamp);
    // Сообщения встроенного инструмента записываются как вход FunctionCallOutput, а не role=user.
    const item = p.item;
    if (p.type === 'item_completed' && item?.type === 'FunctionCallOutput' && item.namespace === 'codex_app' && item.name === 'send_message_to_thread' && typeof item.output === 'string') {
      const marker = item.output.match(/<input>\[codex-telegram:([\w-]+)\]\n/);
      if (marker && !turn.items.some((i) => i.clientId === marker[1])) turn.items.push({ type: 'userMessage', clientId: marker[1] });
    }
    if (p.type === 'task_complete') {
      turn.status = 'completed'; turn.completedAt = Number.isFinite(timestamp) ? timestamp : p.completed_at;
      if (typeof p.last_agent_message === 'string') turn.items.push({ type: 'agentMessage', phase: 'final_answer', text: desktopText(p.last_agent_message) });
    }
    if (p.type === 'turn_aborted') { turn.status = 'interrupted'; turn.completedAt = timestamp; }
  }
}
