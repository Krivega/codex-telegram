import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hubDefaults, validateNetworkConfig, saveNetworkConfig, loadNetworkConfig, serverUrl } from '../src/network/config.ts';
import type { AgentConfig } from '../src/network/config.ts';
import { defaults } from '../src/config/config.ts';
import { HubStore, AgentStore } from '../src/network/store.ts';
import { HubServer } from '../src/network/server.ts';
import { HubClient } from '../src/network/client.ts';
import { Coordinator } from '../src/network/coordinator.ts';
import { AgentLink } from '../src/network/agent.ts';
import { CodexWorker } from '../src/bridge/worker.ts';
import { jobDirectory } from '../src/artifacts/artifacts.ts';
import { HttpError } from '../src/network/protocol.ts';
import { UncertainOperationError } from '../src/types.ts';
import { TestCodex, TestTelegram, thread, completed } from './helpers.ts';

class LossyClient extends HubClient {
  lose: string | undefined;
  override async request(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await super.request(path, body, signal);
    if (this.lose === path) { this.lose = undefined; throw new HttpError(503, 'Потеря ответа после записи на сервере'); }
    return response;
  }
}
async function networkFixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-telegram-network-'));
  const directory = join(root, 'hub'); await mkdir(directory);
  const config = hubDefaults(); config.telegram = { userId: 42, chatId: 42, botId: 123, initialOffset: 0 }; config.listen.port = 0;
  let store = new HubStore(join(directory, 'state.sqlite'));
  const telegram = new TestTelegram(); let coordinator = new Coordinator(config, directory, store, telegram);
  let server = new HubServer(config, directory, store); config.listen.port = await server.listen(); config.publicUrl = `http://127.0.0.1:${config.listen.port}`;
  const agents: { store: AgentStore }[] = [];
  async function agent(name: string) {
    const pairing = store.issuePairing(name); const token = randomBytes(32).toString('hex');
    const client = new LossyClient(config.publicUrl, token);
    const paired = await client.request('/v1/pair', { code: pairing.code, token }) as { hostId: string };
    const directory = join(root, paired.hostId); await mkdir(directory);
    const base = defaults();
    const configAgent: AgentConfig = { version: 2, role: 'agent', hostId: paired.hostId, hubId: config.id, serverUrl: config.publicUrl, chatId: 42, codex: base.codex, notifications: base.notifications, artifacts: base.artifacts };
    const codex = new TestCodex(); let storeAgent = new AgentStore(join(directory, 'state.sqlite'));
    let link = new AgentLink(configAgent, directory, storeAgent, client); let worker = new CodexWorker(configAgent, directory, storeAgent, codex);
    const item = { config: configAgent, token, client, codex, directory,
      get store() { return storeAgent; }, get link() { return link; }, get worker() { return worker; },
      async announce() { await worker.synchronize(); await link.synchronize(worker, true); await link.publish(); },
      restart() {
        storeAgent.close(); storeAgent = new AgentStore(join(directory, 'state.sqlite'));
        link = new AgentLink(configAgent, directory, storeAgent, client); worker = new CodexWorker(configAgent, directory, storeAgent, codex);
      },
    };
    agents.push(item); return item;
  }
  let updateId = 0;
  return { config, root, telegram, agent, get store() { return store; }, get coordinator() { return coordinator; },
    message(text: string, replyTo?: number, owner = 42) {
      const id = ++updateId;
      const update = { update_id: id, message: { message_id: id, text, from: { id: owner }, chat: { id: 42, type: 'private' }, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) } };
      store.ingest([update, update]); coordinator.receive(); return id;
    },
    async restart() {
      await server.close(); store.close(); store = new HubStore(join(directory, 'state.sqlite'));
      coordinator = new Coordinator(config, directory, store, telegram); server = new HubServer(config, directory, store); await server.listen();
    },
    async cleanup() { await server.close(); store.close(); agents.forEach((agent) => agent.store.close()); await rm(root, { recursive: true, force: true }); },
  };
}

test('два компьютера с одинаковыми задачами: ответ доставляется только исходному компьютеру после восстановления связи', async (t) => {
  const f = await networkFixture(); t.after(f.cleanup);
  const a = await f.agent('MacBook'); const b = await f.agent('Mac mini');
  for (const agent of [a, b]) {
    agent.codex.threads = [thread('same-thread')]; agent.codex.turns.set('same-thread', [completed('same-turn')]); await agent.announce();
  }
  await f.coordinator.sender.deliver();
  const messages = f.telegram.texts.filter((message) => message.text.includes('Ответ готов'));
  assert.equal(messages.length, 2);
  const noticeA = messages.find((message) => message.text.startsWith('MacBook'))!;
  const noticeB = messages.find((message) => message.text.startsWith('Mac mini'))!;
  assert.equal(f.store.route(42, noticeA.id)!.hostId, a.config.hostId);
  assert.equal(f.store.route(42, noticeB.id)!.hostId, b.config.hostId);
  f.message('Сделай PDF', noticeA.id); f.message('Сделай снимок', noticeB.id);
  await b.link.synchronize(b.worker, true); await b.worker.submit();
  assert.equal(a.codex.submissions.length, 0); assert.equal(b.codex.submissions.length, 1);
  await f.restart();
  await a.link.synchronize(a.worker, true); a.restart();
  await a.link.synchronize(a.worker, true); await a.worker.submit();
  await a.link.synchronize(a.worker, true); await a.worker.submit();
  assert.equal(a.codex.submissions.length, 1);
  assert.ok(a.codex.submissions[0]!.text.startsWith('Сделай PDF'));
  assert.ok(b.codex.submissions[0]!.text.startsWith('Сделай снимок'));
});

test('потеря ответа узла и перезапуск не дублируют уведомление или поручение', async (t) => {
  const f = await networkFixture(); t.after(f.cleanup); const a = await f.agent('A');
  a.codex.threads = [thread('a')]; a.codex.turns.set('a', [completed('turn')]);
  await a.worker.synchronize(); a.client.lose = '/v1/events'; await a.link.publish();
  a.restart(); await a.link.publish(); await f.coordinator.sender.deliver();
  assert.equal(f.telegram.texts.length, 1);
  const messageId = f.message('Продолжай', f.telegram.texts[0]!.id);
  a.client.lose = '/v1/sync'; await assert.rejects(a.link.synchronize(a.worker, true));
  assert.equal(a.store.jobs().length, 0);
  await a.link.synchronize(a.worker, true); await a.worker.submit();
  a.client.lose = '/v1/sync'; await assert.rejects(a.link.synchronize(a.worker, true));
  a.restart(); await a.link.synchronize(a.worker, true); await a.worker.submit();
  assert.equal(a.codex.submissions.length, 1);
  assert.equal(f.store.job(`tg-123-${messageId}`)!.state, 'queued');
});

test('PDF и снимок проходят через узел; ответ на файл сохраняет компьютер и задачу', async (t) => {
  const f = await networkFixture(); t.after(f.cleanup); const a = await f.agent('MacBook');
  a.codex.threads = [thread('a')]; a.codex.turns.set('a', [completed('first')]); await a.announce(); await f.coordinator.sender.deliver();
  const incoming = f.message('Сделай PDF и PNG', f.telegram.texts[0]!.id);
  await a.link.synchronize(a.worker, true); await a.worker.submit(); const job = a.store.jobs()[0]!;
  const directory = jobDirectory(a.directory, job.id);
  const pdf = Buffer.from('%PDF-1.4\nfixture\n%%EOF'); const png = Buffer.from([137,80,78,71,13,10,26,10,1]);
  await writeFile(join(directory, 'report.pdf'), pdf); await writeFile(join(directory, 'page.png'), png);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ files: [{ path: 'report.pdf', name: 'Отчёт.pdf' }, { path: 'page.png' }] }));
  a.codex.turns.set('a', [completed('result', job.clientId)]); await a.worker.synchronize(); await a.link.synchronize(a.worker, true); await a.link.publish();
  await f.coordinator.sender.deliver();
  assert.equal(f.telegram.files.length, 2); assert.deepEqual(f.telegram.files[0]!.bytes, pdf); assert.deepEqual(f.telegram.files[1]!.bytes, png);
  for (const file of f.telegram.files) assert.deepEqual(f.store.route(42, file.id), { hostId: a.config.hostId, threadId: 'a', turnId: 'result' });
  f.message('Исправь документ', f.telegram.files[0]!.id);
  await a.link.synchronize(a.worker, true); await a.worker.submit(); assert.equal(a.codex.submissions.length, 2);
  assert.equal(f.store.job(`tg-123-${incoming}`)!.state, 'done');
});

test('полный итог доступен без компьютера; список задач и отзыв ключа сохраняют границы маршрута', async (t) => {
  const f = await networkFixture(); t.after(f.cleanup); const a = await f.agent('Ноутбук');
  const full = 'Проверенный результат. '.repeat(400);
  a.codex.threads = [thread('a')]; a.codex.turns.set('a', [{ ...completed('turn'), items: [{ type: 'agentMessage', phase: 'final_answer', text: full }] }]);
  await a.announce(); await f.coordinator.sender.deliver(); const notice = f.telegram.texts[0]!.id;
  await f.restart(); const request = f.message('/full', notice); await f.coordinator.sender.deliver();
  assert.equal(f.telegram.texts.filter((message) => message.replyTo === request).map((message) => message.text).join(''), full.trim());
  f.message('/tasks'); await f.coordinator.sender.deliver();
  const task = f.telegram.texts.find((message) => message.text.includes('Ответьте на это сообщение'))!;
  assert.equal(f.store.route(42, task.id)!.hostId, a.config.hostId);
  f.message('Чужой запрос', task.id, 99); assert.equal(f.store.jobs().length, 0);
  f.store.revoke(a.config.hostId);
  await assert.rejects(a.client.request('/v1/check', {}), (error: unknown) => error instanceof HttpError && error.status === 401);
  f.message('Продолжи', notice); assert.equal(f.store.jobs().length, 0);
  f.message('/feedback Нужны более короткие итоги', notice); assert.equal(f.store.feedback().length, 1);
});

test('ключ компьютера не позволяет подтвердить чужое поручение или отправить к нему вложение', async (t) => {
  const f = await networkFixture(); t.after(f.cleanup); const a = await f.agent('A'); const b = await f.agent('B');
  a.codex.threads = [thread('a')]; a.codex.turns.set('a', [completed('turn')]); await a.announce(); await f.coordinator.sender.deliver();
  const request = f.message('PDF', f.telegram.texts[0]!.id);
  const denied = (error: unknown) => error instanceof HttpError && error.status === 403;
  await assert.rejects(b.client.request('/v1/sync', { tasks: [], codexOnline: true, reports: [{ id: `tg-123-${request}`, revision: 1, state: 'done' }] }), denied);
  await assert.rejects(b.client.request('/v1/events', { key: 'forged', threadId: 'a', replyTo: request, body: { kind: 'text', text: 'Чужой итог' } }), denied);
  assert.equal(f.store.job(`tg-123-${request}`)!.state, 'pending');
  await assert.rejects(new HubClient(f.config.publicUrl, '0'.repeat(64)).request('/v1/check', {}), (error: unknown) => error instanceof HttpError && error.status === 401);
});

test('одноразовый код допускает повтор только с тем же ключом, истекает и не обходит отзыв', async (t) => {
  const f = await networkFixture(); t.after(f.cleanup);
  const code = f.store.issuePairing('A'); const token = randomBytes(32).toString('hex'); const client = new HubClient(f.config.publicUrl, token);
  const first = await client.request('/v1/pair', { code: code.code, token });
  assert.deepEqual(await client.request('/v1/pair', { code: code.code, token }), first);
  const denied = (error: unknown) => error instanceof HttpError && error.status === 401;
  await assert.rejects(client.request('/v1/pair', { code: code.code, token: randomBytes(32).toString('hex') }), denied);
  const expired = f.store.issuePairing('B', Date.now() - 600000);
  await assert.rejects(client.request('/v1/pair', { code: expired.code, token }), denied);
  f.store.revoke(code.hostId); await assert.rejects(client.request('/v1/pair', { code: code.code, token }), denied);
  const raw = await readFile(join(f.root, 'hub', 'state.sqlite'));
  assert.ok(!raw.includes(Buffer.from(token))); assert.ok(!raw.includes(Buffer.from(code.code)));
});

test('повтор события с изменённым содержимым отклоняется, неизвестная доставка Telegram не повторяется', async (t) => {
  const f = await networkFixture(); t.after(f.cleanup); const a = await f.agent('A');
  const event = { key: 'turn:a:t', threadId: 'a', turnId: 't', body: { kind: 'text', text: 'Готово' } };
  await a.client.request('/v1/events', event);
  await assert.rejects(a.client.request('/v1/events', { ...event, body: { kind: 'text', text: 'Подмена' } }), (error: unknown) => error instanceof HttpError && error.status === 409);
  f.telegram.error = new UncertainOperationError('lost'); await f.coordinator.sender.deliver();
  f.telegram.error = undefined; await f.restart(); await a.client.request('/v1/events', event); await f.coordinator.sender.deliver();
  assert.equal(f.telegram.texts.length, 0); assert.equal(f.store.status().deliveries.length, 1);
});

test('сетевые настройки требуют шифрование удалённого соединения; компьютер не хранит токен бота', async (t) => {
  assert.throws(() => serverUrl('http://192.168.1.10:8787'));
  assert.throws(() => serverUrl('https://token:secret@example.com'));
  assert.throws(() => serverUrl('https://example.com/private?token=secret'));
  const f = await networkFixture(); t.after(f.cleanup); const a = await f.agent('A');
  assert.throws(() => validateNetworkConfig({ ...f.config, listen: { host: '0.0.0.0', port: 8787 } }));
  assert.throws(() => validateNetworkConfig({ ...a.config, telegramBotToken: 'secret' }));
  await saveNetworkConfig(a.directory, a.config, a.token);
  assert.equal((await loadNetworkConfig(a.directory)).config.role, 'agent');
  const saved = await readFile(join(a.directory, 'secrets.json'), 'utf8');
  assert.ok(saved.includes('agentToken')); assert.ok(!saved.includes('telegramBotToken'));
  assert.ok(!(await readFile(join(a.directory, 'config.json'), 'utf8')).includes(a.token));
});

test('узел проверяет владельца вложения, размер, формат, число файлов и неизменность повторной передачи', async (t) => {
  const f = await networkFixture(); t.after(f.cleanup); const a = await f.agent('A'); const b = await f.agent('B');
  a.codex.threads = [thread('a')]; a.codex.turns.set('a', [completed('turn')]); await a.announce(); await f.coordinator.sender.deliver();
  const messageId = f.message('PDF', f.telegram.texts[0]!.id);
  f.config.artifacts.maxFileBytes = 1024; f.config.artifacts.maxFiles = 1;
  const { digest } = await import('../src/network/store.ts');
  const pdf = Buffer.from('%PDF-1.4\nfixture\n%%EOF');
  const metadata = { key: 'pdf', threadId: 'a', turnId: 'result', replyTo: messageId, body: { kind: 'file', name: 'report.pdf', sha256: digest(pdf) } };
  const denied = (status: number) => (error: unknown) => error instanceof HttpError && error.status === status;
  await assert.rejects(b.client.file(metadata, pdf), denied(403));
  await assert.rejects(a.client.file({ ...metadata, body: { ...metadata.body, sha256: '0'.repeat(64) } }, pdf), denied(400));
  const wrong = Buffer.from('not a PDF');
  await assert.rejects(a.client.file({ ...metadata, body: { ...metadata.body, sha256: digest(wrong) } }, wrong), denied(400));
  const large = Buffer.concat([pdf, Buffer.alloc(1024)]);
  await assert.rejects(a.client.file({ ...metadata, body: { ...metadata.body, sha256: digest(large) } }, large), denied(413));
  await a.client.file(metadata, pdf); await a.client.file(metadata, pdf);
  await assert.rejects(a.client.file({ ...metadata, key: 'second' }, pdf), denied(400));
  await assert.rejects(a.client.file({ ...metadata, body: { ...metadata.body, name: 'changed.pdf' } }, pdf), denied(409));
  await f.coordinator.sender.deliver(); assert.equal(f.telegram.files.length, 1);
  assert.deepEqual(f.telegram.files[0]!.bytes, pdf);
});

test('устаревший отчёт не откатывает поручение, неопределённый запрос Codex не повторяется после перезапуска компьютера', async (t) => {
  const f = await networkFixture(); t.after(f.cleanup); const a = await f.agent('A');
  a.codex.threads = [thread('a')]; a.codex.turns.set('a', [completed('turn')]); await a.announce(); await f.coordinator.sender.deliver();
  f.message('Продолжай', f.telegram.texts[0]!.id); await a.link.synchronize(a.worker, true);
  const pending = a.store.reports()[0]!;
  a.codex.submitError = new UncertainOperationError('lost'); await a.worker.submit(); a.restart();
  await a.link.synchronize(a.worker, true); await a.worker.submit();
  const job = a.store.jobs()[0]!; assert.equal(job.state, 'uncertain'); assert.equal(a.codex.submissions.length, 1);
  await a.client.request('/v1/sync', { tasks: [], codexOnline: true, reports: [pending] });
  assert.equal(f.store.job(job.id)!.state, 'uncertain');
  a.codex.queue.set('a', [{ id: 'accepted', clientUserMessageId: job.clientId }]);
  await a.worker.synchronize(); await a.link.synchronize(a.worker, true);
  assert.equal(f.store.job(job.id)!.state, 'submitted'); assert.equal(a.codex.submissions.length, 1);
});

test('слишком большой запрос отклоняется; перенаправление не раскрывает ключ другому серверу', async (t) => {
  const f = await networkFixture(); t.after(f.cleanup); const a = await f.agent('A');
  await assert.rejects(a.client.request('/v1/events', { text: 'x'.repeat(2 * 1024 * 1024) }), (error: unknown) => error instanceof HttpError && error.status === 413);
  const { createServer } = await import('node:http'); let destinationCalls = 0;
  const destination = createServer((_request, response) => { destinationCalls++; response.end('{}'); });
  await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
  const port = (destination.address() as { port: number }).port;
  const redirect = createServer((_request, response) => { response.writeHead(307, { location: `http://127.0.0.1:${port}/key` }); response.end(); });
  await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const server of [redirect, destination]) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  });
  const client = new HubClient(`http://127.0.0.1:${(redirect.address() as { port: number }).port}`, a.token);
  await assert.rejects(client.request('/v1/check', {})); assert.equal(destinationCalls, 0);
});

test('перенос адреса узла сохраняет идентичность; подмена идентификатора узла останавливает синхронизацию', async (t) => {
  const f = await networkFixture(); t.after(f.cleanup); const a = await f.agent('A');
  const moved = { ...a.config, serverUrl: 'https://new-server.example.com' };
  assert.doesNotThrow(() => new AgentLink(moved, a.directory, a.store, a.client));
  assert.throws(() => new AgentLink({ ...moved, hubId: 'another-hub' }, a.directory, a.store, a.client));
  f.config.id = 'another-hub';
  await assert.rejects(a.link.synchronize(a.worker, true), (error: unknown) => error instanceof HttpError && error.status === 502);
});
