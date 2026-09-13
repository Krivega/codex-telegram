import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../storage/store.ts';
import type { Job, JobState } from '../storage/store.ts';
import type { TaskSummary } from '../bridge/worker.ts';

export function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export type Host = { id: string; name: string; lastSeen: number; codexOnline: boolean; revoked: boolean; tasks: TaskSummary[] };
export type JobReport = { id: string; revision: number; state: JobState; queuedId?: string };
export class HubStore extends Store {
  constructor(path: string) {
    super(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, last_seen INTEGER NOT NULL DEFAULT 0, codex_online INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, tasks TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS pairings (code_hash TEXT PRIMARY KEY, host_id TEXT NOT NULL, name TEXT NOT NULL, expires_at INTEGER NOT NULL, key_hash TEXT);
      CREATE TABLE IF NOT EXISTS host_reports (job_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
    `);
  }
  issuePairing(name: string, now = Date.now()): { code: string; hostId: string; expiresAt: number } {
    if (!name.trim() || name.length > 60 || /[\x00-\x1f]/.test(name)) throw new Error('Название компьютера должно содержать от 1 до 60 символов без управляющих знаков.');
    const code = randomBytes(32).toString('hex'); const hostId = randomUUID(); const expiresAt = now + 300000;
    this.db.prepare('DELETE FROM pairings WHERE expires_at<?').run(now);
    this.db.prepare('INSERT INTO pairings(code_hash,host_id,name,expires_at) VALUES (?,?,?,?)').run(digest(code), hostId, name.trim(), expiresAt);
    return { code, hostId, expiresAt };
  }
  pair(code: string, token: string, now = Date.now()): Host {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM pairings WHERE code_hash=?').get(digest(code)) as { host_id: string; name: string; expires_at: number; key_hash: string | null } | undefined;
      if (!row || row.expires_at < now || (row.key_hash && row.key_hash !== digest(token))) throw new Error('Код недействителен, использован или просрочен.');
      const other = this.authenticate(token);
      if (other && other.id !== row.host_id) throw new Error('Ключ уже принадлежит другому компьютеру.');
      const existing = this.host(row.host_id);
      if (existing?.revoked) throw new Error('Ключ отозван. Создайте новое подключение.');
      this.db.prepare('INSERT OR IGNORE INTO hosts(id,name,key_hash) VALUES (?,?,?)').run(row.host_id, row.name, digest(token));
      this.db.prepare('UPDATE pairings SET key_hash=? WHERE code_hash=?').run(digest(token), digest(code));
      return this.host(row.host_id)!;
    });
  }
  authenticate(token: string): Host | undefined {
    const row = this.db.prepare('SELECT id FROM hosts WHERE key_hash=? AND revoked=0').get(digest(token)) as { id: string } | undefined;
    return row ? this.host(row.id) : undefined;
  }
  host(id: string): Host | undefined { return this.hosts().find((host) => host.id === id); }
  hosts(): Host[] {
    return (this.db.prepare('SELECT id,name,last_seen,codex_online,revoked,tasks FROM hosts ORDER BY rowid').all() as { id: string; name: string; last_seen: number; codex_online: number; revoked: number; tasks: string }[])
      .map((row) => ({ id: row.id, name: row.name, lastSeen: row.last_seen, codexOnline: Boolean(row.codex_online), revoked: Boolean(row.revoked), tasks: JSON.parse(row.tasks) }));
  }
  revoke(id: string): void {
    if (!this.db.prepare('UPDATE hosts SET revoked=1 WHERE id=?').run(id).changes) throw new Error('Компьютер не найден.');
  }
  heartbeat(hostId: string, tasks: TaskSummary[], codexOnline: boolean): void {
    this.db.prepare('UPDATE hosts SET last_seen=?,codex_online=?,tasks=? WHERE id=? AND revoked=0').run(Date.now(), Number(codexOnline), JSON.stringify(tasks), hostId);
  }
  dispatch(hostId: string): Job[] {
    return this.jobs().filter((job) => job.hostId === hostId && !this.db.prepare('SELECT 1 FROM host_reports WHERE job_id=?').get(job.id));
  }
  report(hostId: string, report: JobReport): void {
    const job = this.job(report.id);
    if (!job || job.hostId !== hostId) throw new Error('Поручение не принадлежит этому компьютеру.');
    const previous = this.db.prepare('SELECT revision FROM host_reports WHERE job_id=?').get(job.id) as { revision: number } | undefined;
    if (previous && previous.revision >= report.revision) return;
    if (!['done', 'failed'].includes(job.state)) this.saveJob({ ...job, state: report.state, queuedId: report.queuedId });
    this.db.prepare('INSERT INTO host_reports VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET revision=excluded.revision').run(job.id, report.revision);
  }
  override status(): { deliveries: unknown[]; jobs: unknown[]; hosts: Omit<Host, 'tasks'>[] } {
    return { ...super.status(), jobs: this.jobs().map((job) => ({ id: job.id, hostId: job.hostId, host: job.hostId ? this.host(job.hostId)?.name : undefined, state: job.state })), hosts: this.hosts().map(({ tasks: _tasks, ...host }) => host) };
  }
  ownsMessage(hostId: string, messageId: number, threadId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM jobs WHERE json_extract(payload,'$.hostId')=? AND json_extract(payload,'$.messageId')=? AND json_extract(payload,'$.threadId')=?").get(hostId, messageId, threadId));
  }
  fileCount(hostId: string, messageId: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE json_extract(payload,'$.body.kind')='file' AND json_extract(payload,'$.route.hostId')=? AND json_extract(payload,'$.replyTo')=?").get(hostId, messageId) as { count: number }).count;
  }
  eventFingerprint(key: string): string | undefined {
    return (this.db.prepare('SELECT fingerprint FROM events WHERE key=?').get(key) as { fingerprint: string } | undefined)?.fingerprint;
  }
  rememberEvent(key: string, fingerprint: string): void { this.db.prepare('INSERT INTO events VALUES (?,?)').run(key, fingerprint); }
}
export class AgentStore extends Store {
  constructor(path: string) {
    super(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reports (job_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1, acknowledged INTEGER NOT NULL DEFAULT 0);
      CREATE TRIGGER IF NOT EXISTS report_insert AFTER INSERT ON jobs BEGIN INSERT INTO reports(job_id) VALUES (new.id); END;
      CREATE TRIGGER IF NOT EXISTS report_update AFTER UPDATE ON jobs BEGIN UPDATE reports SET revision=revision+1 WHERE job_id=new.id; END;
    `);
  }
  recoverRemoteDeliveries(): void {
    this.db.exec("UPDATE outbox SET state='pending',error=NULL WHERE state IN ('sending','uncertain')");
  }
  accept(job: Job): void { if (!this.job(job.id)) this.saveJob(job); }
  reports(): JobReport[] {
    const rows = this.db.prepare('SELECT job_id,revision FROM reports WHERE acknowledged<revision ORDER BY rowid LIMIT 200').all() as { job_id: string; revision: number }[];
    return rows.map((row) => { const job = this.job(row.job_id)!; return { id: job.id, revision: row.revision, state: job.state, queuedId: job.queuedId }; });
  }
  acknowledgeReports(reports: JobReport[]): void {
    for (const report of reports) this.db.prepare('UPDATE reports SET acknowledged=MAX(acknowledged,?) WHERE job_id=?').run(report.revision, report.id);
  }
}
