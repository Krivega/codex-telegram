import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import type { TelegramUpdate } from '../types.ts';

export type Route = { hostId?: string; threadId: string; turnId?: string };
export type JobState = 'pending' | 'submitting' | 'queued' | 'submitted' | 'uncertain' | 'done' | 'failed';
export type Job = {
  hostId?: string; id: string; threadId: string; chatId: number; messageId: number;
  text: string; clientId: string; state: JobState; queuedId?: string;
};
export type DeliveryBody =
  | { kind: 'text'; text: string; fullText?: string }
  | { kind: 'file'; root: string; path: string; name: string; sha256: string };
export type Delivery = {
  id: number; key: string; chatId: number; replyTo?: number;
  route?: Route; body: DeliveryBody;
  state: 'pending' | 'sending' | 'sent' | 'uncertain' | 'failed';
  error?: string;
};
export class Store {
  protected db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 1) throw new Error('База создана более новой версией программы.');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS routes (chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(chat_id,message_id));
      CREATE TABLE IF NOT EXISTS turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, PRIMARY KEY(thread_id,turn_id));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', retry_at INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY, message TEXT NOT NULL, route TEXT, created_at TEXT NOT NULL);
      PRAGMA user_version=1;
    `);
  }
  close(): void { this.db.close(); }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getMeta(key: string): string | undefined { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value; }
  setMeta(key: string, value: string): void { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  bindIdentity(identity: string): void {
    const existing = this.getMeta('identity');
    if (existing && existing !== identity) throw new Error('База принадлежит другому компьютеру или Telegram-боту. Используйте отдельный каталог настроек.');
    this.setMeta('identity', identity);
  }
  recover(): void {
    this.recoverJobs();
    this.db.exec("UPDATE outbox SET state='uncertain',error='Отправка прервалась; требуется проверка доставки.' WHERE state='sending';");
  }
  recoverJobs(): void { this.db.exec("UPDATE jobs SET state='uncertain' WHERE state='submitting'"); }
  ingest(updates: TelegramUpdate[]): void {
    this.transaction(() => {
      let offset = Number(this.getMeta('telegramOffset') ?? 0);
      for (const update of updates) {
        this.db.prepare('INSERT OR IGNORE INTO inbox(id,payload) VALUES (?,?)').run(update.update_id, JSON.stringify(update));
        offset = Math.max(offset, update.update_id + 1);
      }
      this.setMeta('telegramOffset', String(offset));
    });
  }
  incoming(): TelegramUpdate[] {
    return (this.db.prepare("SELECT payload FROM inbox WHERE state='pending' ORDER BY id").all() as { payload: string }[]).map((row) => JSON.parse(row.payload));
  }
  finishIncoming(id: number): void { this.db.prepare("UPDATE inbox SET state='done' WHERE id=?").run(id); }
  saveRoute(chatId: number, messageId: number, route: Route): void {
    this.db.prepare('INSERT OR REPLACE INTO routes VALUES (?,?,?)').run(chatId, messageId, JSON.stringify(route));
  }
  route(chatId: number, messageId: number): Route | undefined {
    const row = this.db.prepare('SELECT payload FROM routes WHERE chat_id=? AND message_id=?').get(chatId, messageId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  seenTurn(threadId: string, turnId: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM turns WHERE thread_id=? AND turn_id=?').get(threadId, turnId)); }
  markTurn(threadId: string, turnId: string): void { this.db.prepare('INSERT OR IGNORE INTO turns VALUES (?,?)').run(threadId, turnId); }
  saveJob(job: Job): void {
    this.db.prepare('INSERT INTO jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,state=excluded.state').run(job.id, JSON.stringify(job), job.state);
  }
  job(id: string): Job | undefined {
    const row = this.db.prepare('SELECT payload,state FROM jobs WHERE id=?').get(id) as { payload: string; state: JobState } | undefined;
    return row ? { ...JSON.parse(row.payload), state: row.state } : undefined;
  }
  jobs(): Job[] {
    return (this.db.prepare("SELECT payload,state FROM jobs WHERE state NOT IN ('done','failed') ORDER BY rowid").all() as { payload: string; state: JobState }[]).map((row) => ({ ...JSON.parse(row.payload), state: row.state }));
  }
  enqueue(key: string, chatId: number, body: DeliveryBody, route?: Route, replyTo?: number): void {
    this.db.prepare('INSERT OR IGNORE INTO outbox(key,payload) VALUES (?,?)').run(key, JSON.stringify({ key, chatId, body, route, replyTo }));
  }
  deliveries(): Delivery[] {
    return (this.db.prepare("SELECT id,payload,state,error FROM outbox WHERE state='pending' AND retry_at<=? ORDER BY id").all(Date.now()) as { id: number; payload: string; state: Delivery['state']; error: string }[])
      .map((row) => ({ ...JSON.parse(row.payload), id: row.id, state: row.state, error: row.error }));
  }
  setDeliveryState(id: number, state: Delivery['state'], error?: string, retryAt = 0): void {
    this.db.prepare('UPDATE outbox SET state=?,error=?,retry_at=? WHERE id=?').run(state, error ?? null, retryAt, id);
  }
  acknowledgeDelivery(delivery: Delivery, messageId: number): void {
    this.transaction(() => {
      if (delivery.route) this.saveRoute(delivery.chatId, messageId, delivery.route);
      this.setDeliveryState(delivery.id, 'sent');
    });
  }
  retryDelivery(id: number): void {
    const result = this.db.prepare("UPDATE outbox SET state='pending',retry_at=0,error=NULL WHERE id=? AND state IN ('uncertain','failed')").run(id);
    if (!result.changes) throw new Error('Не найдена доставка, которую можно повторить.');
  }
  saveFeedback(id: number, message: string, route?: Route): void {
    this.db.prepare('INSERT OR IGNORE INTO feedback VALUES (?,?,?,?)').run(id, message, route ? JSON.stringify(route) : null, new Date().toISOString());
  }
  feedback(): unknown[] { return this.db.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT 100').all(); }
  status(): { deliveries: unknown[]; jobs: unknown[] } {
    return {
      deliveries: this.db.prepare("SELECT id,state,error FROM outbox WHERE state IN ('uncertain','failed') ORDER BY id").all(),
      jobs: this.db.prepare("SELECT id,state FROM jobs WHERE state NOT IN ('done','failed') ORDER BY rowid").all(),
    };
  }
}
