import { desktopText } from './text.ts';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Thread, Turn } from '../types.ts';
import { CodexUnavailableError } from '../types.ts';

type Journal = { inode: number; offset: number; identity?: string; cwd: string; turns: Map<string, Turn>; current?: string; updatedAt: number };
const MAX_LINE = 32 * 1024 * 1024;
export function requestMarker(id: string): string { return `[codex-telegram:${id}]`; }

// Только законченные строки. Курсор не проходит незавершённую запись работающего приложения.
export class RolloutReader {
  private paths = new Map<string, string>();
  private journals = new Map<string, Journal>();
  private root: string;
  private ids: readonly string[];
  constructor(root: string, ids: readonly string[]) { this.root = root; this.ids = ids; }
  private async locate(id: string): Promise<string> {
    const cached = this.paths.get(id);
    if (cached) return cached;
    const found: string[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory() && depth < 4) await visit(path, depth + 1);
        if (entry.isFile() && entry.name.endsWith(`-${id}.jsonl`)) found.push(path);
      }
    };
    await visit(this.root, 0);
    if (found.length !== 1) throw new CodexUnavailableError('Не найден единственный журнал выбранной задачи. Проверьте sessionsPath и threadIds.');
    this.paths.set(id, found[0]!); return found[0]!;
  }
  async read(id: string): Promise<Thread> {
    if (!this.ids.includes(id)) throw new CodexUnavailableError('Задача отсутствует в разрешённом списке.');
    const path = await this.locate(id);
    const info = await stat(path);
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
    if (journal.identity !== id || typeof journal.cwd !== 'string' || !journal.cwd || !journal.turns.size) throw new CodexUnavailableError('Формат или идентификатор журнала Codex не прошёл проверку.');
    const turns = [...journal.turns.values()];
    return { id, name: id, cwd: journal.cwd, updatedAt: journal.updatedAt, canAcceptDirectInput: true,
      status: { type: turns.at(-1)?.status === 'inProgress' ? 'active' : 'idle' }, turns: structuredClone(turns) };
  }
  private consume(journal: Journal, row: any): void {
    const p = row.payload;
    if (!p || typeof p !== 'object') return;
    if (row.type === 'session_meta') { journal.identity = p.id; journal.cwd = p.cwd; return; }
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
      turn.status = 'completed'; turn.completedAt = p.completed_at ?? timestamp;
      if (typeof p.last_agent_message === 'string') turn.items.push({ type: 'agentMessage', phase: 'final_answer', text: desktopText(p.last_agent_message) });
    }
    if (p.type === 'turn_aborted') { turn.status = 'interrupted'; turn.completedAt = timestamp; }
  }
}
