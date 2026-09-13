import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { textParts } from '../bridge/messages.ts';
import { matchesSignature, readArtifact, validateArtifactRoot } from '../artifacts/artifacts.ts';
import type { HubConfig } from './config.ts';
import { HubStore, digest } from './store.ts';
import type { Host } from './store.ts';
import { HttpError, parseEvent, parseSync, record, secret } from './protocol.ts';
import type { RemoteEvent } from './protocol.ts';

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(request.headers['content-length']) > limit) throw new HttpError(413, 'Превышен размер запроса.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Превышен размер запроса.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const bytes = await readBody(request, 2 * 1024 * 1024);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new HttpError(400, 'Неверный JSON.'); }
}
function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
export class HubServer {
  private config: HubConfig;
  private directory: string;
  private store: HubStore;
  private server: Server | undefined;
  private requests = new Set<Promise<void>>();
  private pairingWindow = 0;
  private pairingAttempts = 0;
  constructor(config: HubConfig, directory: string, store: HubStore) { this.config = config; this.directory = directory; this.store = store; }
  async listen(): Promise<number> {
    const handler = (request: IncomingMessage, response: ServerResponse) => {
      const task = this.handle(request).then((result) => reply(response, 200, result)).catch((error: unknown) => {
        reply(response, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Узел не смог обработать запрос. Повторите подключение.' });
      }).finally(() => this.requests.delete(task));
      this.requests.add(task);
    };
    const tls = this.config.listen.tls;
    this.server = tls ? httpsServer({ cert: await readFile(tls.certPath), key: await readFile(tls.keyPath), minVersion: 'TLSv1.2', maxHeaderSize: 16384 }, handler) : httpServer({ maxHeaderSize: 16384 }, handler);
    this.server.requestTimeout = 30000; this.server.headersTimeout = 10000; this.server.timeout = 30000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.listen.port, this.config.listen.host, () => { this.server!.off('error', reject); resolve(); });
    });
    return (this.server.address() as { port: number }).port;
  }
  async close(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    await Promise.allSettled(this.requests);
  }
  private authenticated(request: IncomingMessage): Host {
    const token = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const host = token ? this.store.authenticate(token) : undefined;
    if (!host) throw new HttpError(401, 'Подключение не разрешено. Проверьте ключ или выполните новую привязку.');
    return host;
  }
  private requireActive(host: Host): void {
    if (!this.store.host(host.id) || this.store.host(host.id)!.revoked) throw new HttpError(401, 'Ключ компьютера отозван.');
  }
  private async handle(request: IncomingMessage): Promise<unknown> {
    if (request.method !== 'POST') throw new HttpError(405, 'Используйте POST.');
    if (request.url === '/v1/pair') {
      if (Date.now() - this.pairingWindow > 60000) { this.pairingWindow = Date.now(); this.pairingAttempts = 0; }
      if (++this.pairingAttempts > 30) throw new HttpError(429, 'Слишком много попыток подключения. Повторите через минуту.');
      const data = record(await jsonBody(request));
      let host: Host;
      try { host = this.store.pair(secret(data.code), secret(data.token)); }
      catch { throw new HttpError(401, 'Код недействителен, использован или просрочен.'); }
      return { hubId: this.config.id, hostId: host.id, name: host.name, chatId: this.config.telegram.chatId, artifacts: this.config.artifacts, notifications: this.config.notifications };
    }
    const host = this.authenticated(request);
    if (request.url === '/v1/check') return { hubId: this.config.id, hostId: host.id, name: host.name };
    if (request.url === '/v1/sync') {
      const sync = parseSync(await jsonBody(request)); this.requireActive(host);
      return this.store.transaction(() => {
        for (const report of sync.reports) {
          if (this.store.job(report.id)?.hostId !== host.id) throw new HttpError(403, 'Чужое поручение.');
          this.store.report(host.id, report);
        }
        this.store.heartbeat(host.id, sync.tasks, sync.codexOnline);
        return { hubId: this.config.id, hostId: host.id, jobs: this.store.dispatch(host.id).slice(0, 100) };
      });
    }
    if (request.url === '/v1/events') {
      const event = parseEvent(await jsonBody(request)); this.requireActive(host);
      if (event.body.kind !== 'text') throw new HttpError(400, 'Для файла нужен адрес /v1/files.');
      this.acceptEvent(host, event);
      return { accepted: true };
    }
    if (request.url === '/v1/files') {
      let metadata: unknown;
      try { metadata = JSON.parse(Buffer.from(String(request.headers['x-codex-event'] ?? ''), 'base64url').toString('utf8')); }
      catch { throw new HttpError(400, 'Неверное описание вложения.'); }
      const event = parseEvent(metadata);
      if (event.body.kind !== 'file') throw new HttpError(400, 'Ожидается файл.');
      this.validateEvent(host, event);
      const bytes = await readBody(request, this.config.artifacts.maxFileBytes); this.requireActive(host);
      if (digest(bytes) !== event.body.sha256 || !matchesSignature(bytes, extname(event.body.name).toLowerCase())) throw new HttpError(400, 'Формат или контрольная сумма вложения не совпадают.');
      const expectedHash = event.body.sha256;
      const root = join(this.directory, 'artifacts', digest(`${host.id}:${event.key}`));
      await mkdir(root, { recursive: true, mode: 0o700 });
      await validateArtifactRoot(this.directory, root);
      const path = join(root, `${event.body.sha256}${extname(event.body.name).toLowerCase()}`);
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST' || digest(await readArtifact(root, path, this.config.artifacts.maxFileBytes)) !== expectedHash) throw error;
      });
      this.requireActive(host);
      this.acceptEvent(host, event, { root, path });
      return { accepted: true };
    }
    throw new HttpError(404, 'Неизвестный адрес протокола.');
  }
  private validateEvent(host: Host, event: RemoteEvent): void {
    if (event.replyTo !== undefined) {
      if (!this.store.ownsMessage(host.id, event.replyTo, event.threadId)) throw new HttpError(403, 'Ответ адресован чужой задаче.');
    } else if (event.body.kind === 'file') throw new HttpError(403, 'Файл должен быть связан с поручением владельца.');
    const previous = this.store.eventFingerprint(`${host.id}:${event.key}`);
    if (!previous && event.body.kind === 'file' && this.store.fileCount(host.id, event.replyTo!) >= this.config.artifacts.maxFiles) throw new HttpError(400, 'Превышено количество вложений поручения.');
    if (previous && previous !== digest(JSON.stringify(event))) throw new HttpError(409, 'Событие с этим идентификатором уже имеет другое содержимое.');
  }
  private acceptEvent(host: Host, event: RemoteEvent, file?: { root: string; path: string }): void {
    this.store.transaction(() => {
      this.validateEvent(host, event);
      const key = `${host.id}:${event.key}`;
      if (this.store.eventFingerprint(key)) return;
      const route = { hostId: host.id, threadId: event.threadId, ...(event.turnId ? { turnId: event.turnId } : {}) };
      if (event.body.kind === 'text') {
        const text = `${host.name} · ${event.body.text}`;
        textParts(text).forEach((part, index) => this.store.enqueue(`remote-text:${key}:${index}`, this.config.telegram.chatId, { kind: 'text', text: part }, route, event.replyTo));
        if (event.turnId && event.body.fullText) this.store.setMeta(`full:${host.id}:${event.threadId}:${event.turnId}`, event.body.fullText);
      } else {
        if (!file) throw new HttpError(400, 'Отсутствует файл.');
        this.store.enqueue(`remote-file:${key}`, this.config.telegram.chatId, { ...event.body, ...file }, route, event.replyTo);
      }
      this.store.rememberEvent(key, digest(JSON.stringify(event)));
    });
  }
}
