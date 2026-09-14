import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexUnavailableError } from '../types.ts';

type Entry = { path: string; id: string; primary: boolean; service: boolean };
const MAX_HEADER_BYTES = 32 * 1024 * 1024;

export class DesktopCatalog {
  private root: string;
  private entries = new Map<string, Entry>();
  private headers = new Map<string, Entry>();
  constructor(root: string) { this.root = root; }
  async refresh(): Promise<void> {
    const entries = new Map<string, Entry>();
    const duplicates = new Set<string>();
    const paths = new Set<string>();
    const visit = async (directory: string, depth: number): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory() && depth < 4) await visit(path, depth + 1);
        if (!item.isFile() || !item.name.startsWith('rollout-') || !item.name.endsWith('.jsonl')) continue;
        paths.add(path);
        const entry = this.headers.get(path) ?? await this.header(path);
        if (!entry) continue;
        this.headers.set(path, entry);
        if (entries.has(entry.id)) duplicates.add(entry.id);
        entries.set(entry.id, entry);
      }
    };
    try { await visit(this.root, 0); }
    catch { throw new CodexUnavailableError('Каталог журналов Codex недоступен. Проверьте sessionsPath.'); }
    for (const id of duplicates) entries.delete(id);
    for (const path of this.headers.keys()) if (!paths.has(path)) this.headers.delete(path);
    this.entries = entries;
  }
  ids(): string[] { return [...this.entries.values()].filter((entry) => entry.primary).map((entry) => entry.id); }
  async entry(id: string): Promise<Entry> {
    if (!this.entries.has(id)) await this.refresh();
    const entry = this.entries.get(id);
    if (!entry || entry.service) throw new CodexUnavailableError('Не найден журнал основной задачи Codex.');
    return entry;
  }
  private async header(path: string): Promise<Entry | undefined> {
    const handle = await open(path, 'r').catch(() => undefined);
    if (!handle) return;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      while (size < MAX_HEADER_BYTES) {
        const buffer = Buffer.alloc(Math.min(65536, MAX_HEADER_BYTES - size));
        const { bytesRead } = await handle.read(buffer);
        if (!bytesRead) return;
        const end = buffer.subarray(0, bytesRead).indexOf(10);
        chunks.push(buffer.subarray(0, end < 0 ? bytesRead : end));
        size += bytesRead;
        if (end < 0) continue;
        const row = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const p = row.payload;
        if (row.type !== 'session_meta' || typeof p?.id !== 'string' || !/^[\w-]+$/.test(p.id) || !path.endsWith(`-${p.id}.jsonl`)) return;
        const service = Boolean(p.parent_thread_id || p.parentThreadId || (p.thread_source && p.thread_source !== 'user') || (p.source && typeof p.source === 'object'));
        return { path, id: p.id, service, primary: !service && p.source === 'vscode' && p.originator === 'Codex Desktop' };
      }
    } catch { return; } finally { await handle.close(); }
  }
}
