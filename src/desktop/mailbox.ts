import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { RejectedOperationError } from '../types.ts';

type Request = { id: string; threadId: string; text: string; state: string; token: string | null };
export class DesktopMailbox {
  private db: DatabaseSync;
  constructor(path: string, identity: string) {
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS identity(value TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, token TEXT);`);
    this.db.prepare('INSERT INTO identity SELECT ? WHERE NOT EXISTS(SELECT 1 FROM identity)').run(identity);
    if ((this.db.prepare('SELECT value FROM identity').get() as { value: string }).value !== identity) {
      this.db.close(); throw new Error('Очередь Desktop принадлежит другой конфигурации компьютера. Используйте отдельный --home.');
    }
  }
  close(): void { this.db.close(); }
  enqueue(id: string, threadId: string, text: string): void {
    this.db.prepare("INSERT OR IGNORE INTO requests VALUES (?,?,?,'queued',NULL)").run(id, threadId, text);
    const saved = this.get(id)!;
    if (saved.threadId !== threadId || saved.text !== text) throw new RejectedOperationError('Идентификатор поручения уже занят другим содержимым.');
  }
  get(id: string): Request | undefined { return this.db.prepare('SELECT * FROM requests WHERE id=?').get(id) as Request | undefined; }
  queue(threadId: string): Request[] {
    return this.db.prepare("SELECT * FROM requests WHERE threadId=? AND state!='observed' ORDER BY rowid").all(threadId) as Request[];
  }
  ready(id: string, threadId: string): void {
    this.db.prepare("UPDATE requests SET state='ready' WHERE id=? AND threadId=? AND state='queued'").run(id, threadId);
  }
  claim(id: string): Request | undefined {
    const token = randomUUID();
    return this.db.prepare("UPDATE requests SET state='claimed',token=? WHERE id=? AND state='ready' RETURNING *").get(token, id) as Request | undefined;
  }
  report(id: string, token: string, state: 'accepted' | 'uncertain'): void {
    const result = this.db.prepare("UPDATE requests SET state=CASE WHEN state='observed' THEN state ELSE ? END WHERE id=? AND token=? AND state IN ('claimed','observed',?)").run(state, id, token, state);
    if (!result.changes) throw new Error('Выдача поручения не найдена или уже завершена другим результатом.');
  }
  observe(id: string, threadId: string): void {
    this.db.prepare("UPDATE requests SET state='observed' WHERE id=? AND threadId=? AND state IN ('claimed','accepted','uncertain')").run(id, threadId);
  }
  status(): unknown[] { return this.db.prepare("SELECT id,threadId,state FROM requests WHERE state!='observed' ORDER BY rowid").all(); }
}
