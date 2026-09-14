import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '../src/config/config.ts';
import { DesktopAdapter } from '../src/desktop/adapter.ts';
import { Store } from '../src/storage/store.ts';
import { Bridge } from '../src/bridge/bridge.ts';
import { TestTelegram } from './helpers.ts';
import { checkCodexReadiness, ensureCodexStartup } from '../src/codex/readiness.ts';
import { configureExecution } from '../src/setup/execution.ts';

function row(type: string, payload: object, time = Date.now()): string {
  return JSON.stringify({ timestamp: new Date(time).toISOString(), type, payload }) + '\n';
}
function header(id: string, extra = {}): string {
  return row('session_meta', { id, cwd: tmpdir(), source: 'vscode', originator: 'Codex Desktop', thread_source: 'user', ...extra });
}
function turn(id: string, text: string, time: number): string {
  return row('event_msg', { type: 'task_started', turn_id: id, started_at: time / 1000 }, time)
    + row('event_msg', { type: 'task_complete', turn_id: id, completed_at: Math.floor(time / 1000), last_agent_message: text }, time);
}
function userMessage(text: string): string {
  return row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ct-discovery-'));
  const config = defaults(); config.telegram = { userId: 42, chatId: 42, botId: 123, initialOffset: 0 };
  config.codex = { ...config.codex, transport: 'desktop', sessionsPath: join(directory, 'sessions'), threadIds: [] };
  await mkdir(config.codex.sessionsPath!);
  const adapter = new DesktopAdapter(directory, config);
  const path = (id: string) => join(config.codex.sessionsPath!, `rollout-${id}.jsonl`);
  return { directory, config, adapter, path, async cleanup() { adapter.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('пустой каталог готов после регистрации диспетчера; новые задачи появляются без перезапуска', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await assert.rejects(ensureCodexStartup(f.directory, f.config, f.adapter), /диспетчер/);
  f.adapter.mailbox.registerDispatcher('dispatcher');
  await ensureCodexStartup(f.directory, f.config, f.adapter);
  assert.deepEqual(await f.adapter.listThreads(), []);
  await writeFile(f.path('new'), header('new'));
  assert.deepEqual((await f.adapter.listThreads()).map(x => x.id), ['new']);
  await f.adapter.queueMessage('new', 'client', 'Первое поручение'); await f.adapter.startQueued('new', 'client');
  assert.equal((await f.adapter.claim())?.threadId, 'new');
});

test('список Desktop показывает первую строку пользовательского запроса вместо UUID', async (t) => {
  const f = await fixture(); t.after(f.cleanup); f.adapter.mailbox.registerDispatcher('dispatcher');
  await writeFile(f.path('named'), header('named') + userMessage('<recommended_plugins>\nсписок интеграций\n</recommended_plugins>')
    + userMessage('# Files mentioned by the user\n\n## My request:\nСобери отчёт по проекту\nПодробности поручения'));
  const thread = await f.adapter.readThread('named');
  assert.equal(thread.name, 'Собери отчёт по проекту');

  const store = new Store(join(f.directory, 'state.sqlite')); t.after(() => store.close());
  const telegram = new TestTelegram(); const bridge = new Bridge(f.config, f.directory, store, f.adapter, telegram);
  store.ingest([{ update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/tasks' } }]);
  await bridge.receive(); await bridge.deliver();
  assert.equal(telegram.texts[0]!.text, 'Собери отчёт по проекту\nОтветьте на это сообщение, чтобы продолжить задачу.');
  assert.deepEqual(store.route(42, telegram.texts[0]!.id), { threadId: 'named' });
  assert.ok(!telegram.texts[0]!.text.includes('named'));
});

test('новое завершение создаёт уведомление и постоянную привязку; старая история не рассылается', async (t) => {
  const f = await fixture(); t.after(f.cleanup); f.adapter.mailbox.registerDispatcher('dispatcher');
  const store = new Store(join(f.directory, 'state.sqlite')); t.after(() => store.close());
  const telegram = new TestTelegram(); const bridge = new Bridge(f.config, f.directory, store, f.adapter, telegram);
  const enabled = Number(store.getMeta('enabledAt')) * 1000;
  await writeFile(f.path('old'), header('old') + turn('past', 'Старый итог', enabled - 1));
  await bridge.synchronize(); await bridge.deliver(); assert.equal(telegram.texts.length, 0);
  await writeFile(f.path('new'), header('new') + turn('new-turn', 'Новый итог', enabled + 1));
  await appendFile(f.path('old'), turn('continuation', 'Продолжение существующей задачи', enabled + 2));
  await bridge.synchronize(); await bridge.deliver();
  assert.equal(telegram.texts.length, 2);
  const notification = telegram.texts.find(x => x.text.includes('Новый итог'))!;
  assert.deepEqual(store.route(42, notification.id), { threadId: 'new', turnId: 'new-turn' });
  store.ingest([{ update_id: 1, message: { message_id: 1000, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: 'Продолжи', reply_to_message: { message_id: notification.id } } }]);
  await bridge.receive(); await bridge.submit(); await bridge.synchronize();
  assert.equal((await f.adapter.claim())?.threadId, 'new');
  const restart = new DesktopAdapter(f.directory, f.config); t.after(() => restart.close());
  const receiver = new TestTelegram(); const restored = new Bridge(f.config, f.directory, store, restart, receiver);
  await restored.synchronize(); await restored.deliver();
  assert.ok(receiver.texts.every(x => !x.text.includes('Ответ готов')));
});

test('диспетчеры, подзадачи, неизвестные источники и архивы исключаются; повреждённая запись не мешает новым задачам', async (t) => {
  const f = await fixture(); t.after(f.cleanup); f.adapter.mailbox.registerDispatcher('dispatcher');
  const now = Date.now();
  for (const [id, extra] of Object.entries({ good: {}, dispatcher: {}, child: { parent_thread_id: 'good' }, guardian: { source: { subagent: { other: 'guardian' } } }, service: { thread_source: 'subagent' }, unknown: { source: 'unknown' }, cli: { source: 'cli' } })) {
    await writeFile(f.path(id), header(id, extra) + turn('turn', 'Итог', now));
  }
  await writeFile(f.path('broken'), header('broken') + '{broken}\n');
  assert.deepEqual((await f.adapter.listThreads()).map(x => x.id), ['good']);
  await assert.rejects(f.adapter.queueMessage('dispatcher', 'x', 'Нельзя'));
  await assert.rejects(f.adapter.queueMessage('child', 'x', 'Нельзя'));
  await assert.rejects(f.adapter.queueMessage('unknown', 'x', 'Нельзя'));
  await mkdir(join(f.directory, 'archived_sessions'));
  await rename(f.path('good'), join(f.directory, 'archived_sessions', 'rollout-good.jsonl'));
  assert.deepEqual(await f.adapter.listThreads(), []);
  await writeFile(f.path('later'), header('later'));
  assert.deepEqual((await f.adapter.listThreads()).map(x => x.id), ['later']);
});

test('незаконченный заголовок перечитывается; ссылки и дубликаты не становятся адресатами', async (t) => {
  const f = await fixture(); t.after(f.cleanup); f.adapter.mailbox.registerDispatcher('dispatcher');
  const metadata = header('partial');
  await writeFile(f.path('partial'), metadata.slice(0, -2));
  assert.deepEqual(await f.adapter.listThreads(), []);
  await appendFile(f.path('partial'), metadata.slice(-2));
  assert.equal((await f.adapter.listThreads()).length, 1);
  await symlink(f.path('partial'), f.path('link'));
  await mkdir(join(f.config.codex.sessionsPath!, 'next'));
  await writeFile(join(f.config.codex.sessionsPath!, 'next', 'rollout-partial.jsonl'), metadata);
  assert.deepEqual(await f.adapter.listThreads(), []);
});

test('регистрация второго диспетчера действует в работающем процессе и запрещает отложенную доставку', async (t) => {
  const f = await fixture(); t.after(f.cleanup); f.adapter.mailbox.registerDispatcher('first');
  const store = new Store(join(f.directory, 'state.sqlite')); t.after(() => store.close());
  const telegram = new TestTelegram(); const bridge = new Bridge(f.config, f.directory, store, f.adapter, telegram);
  await writeFile(f.path('second'), header('second') + turn('done', 'Не рассылать диспетчер', Date.now() + 100));
  await bridge.synchronize();
  const other = new DesktopAdapter(f.directory, f.config); t.after(() => other.close());
  other.mailbox.registerDispatcher('second');
  await bridge.deliver(); assert.equal(telegram.texts.length, 0);
  assert.deepEqual(await f.adapter.listThreads(), []);
  await assert.rejects(f.adapter.queueMessage('second', 'client', 'Не выполнять'));
});

test('ручной список остаётся ограничением, мастер предлагает автоматический выбор по умолчанию', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  for (const id of ['selected', 'outside']) await writeFile(f.path(id), header(id));
  const limited = new DesktopAdapter(f.directory, { ...f.config, codex: { ...f.config.codex, threadIds: ['selected'] } }); t.after(() => limited.close());
  assert.deepEqual((await limited.listThreads()).map(x => x.id), ['selected']);
  limited.mailbox.registerDispatcher('outside');
  assert.equal(await checkCodexReadiness(limited, ['selected', 'outside']), 1);
  await assert.rejects(limited.queueMessage('outside', 'client', 'Нельзя'));
  const prompts: string[] = [];
  const config = await configureExecution(defaults().codex, async prompt => { prompts.push(prompt); return ''; });
  assert.equal(config.transport, 'desktop'); assert.deepEqual(config.threadIds, []);
  assert.ok(prompts.some(prompt => prompt.includes('[all]')));
});

test('компьютер не передаёт узлу ожидающее уведомление зарегистрированного диспетчера', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const { AgentStore } = await import('../src/network/store.ts');
  const { AgentLink } = await import('../src/network/agent.ts');
  const { HubClient } = await import('../src/network/client.ts');
  const store = new AgentStore(join(f.directory, 'agent.sqlite')); t.after(() => store.close());
  const client = new HubClient('http://127.0.0.1:1', 'a'.repeat(64));
  const request = t.mock.method(client, 'request', async () => { throw new Error('Не должно отправляться'); });
  const config = { version: 2 as const, role: 'agent' as const, hostId: f.config.hostId, hubId: 'hub', serverUrl: 'http://127.0.0.1:1', chatId: 42, codex: f.config.codex, artifacts: f.config.artifacts, notifications: f.config.notifications };
  const link = new AgentLink(config, f.directory, store, client);
  link.permitsThread = (id) => f.adapter.permitsThread(id);
  store.enqueue('dispatcher-final', 42, { kind: 'text', text: 'Служебный итог' }, { threadId: 'dispatcher' });
  f.adapter.mailbox.registerDispatcher('dispatcher');
  await link.publish();
  assert.equal(request.mock.callCount(), 0);
  assert.equal(store.deliveries().length, 0);
});
