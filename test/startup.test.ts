import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start, doctor } from '../src/cli.ts';
import { startNetwork } from '../src/network/runtime.ts';
import { saveNetworkConfig } from '../src/network/config.ts';
import type { AgentConfig } from '../src/network/config.ts';
import { defaults, saveConfig } from '../src/config/config.ts';
import { CodexAdapter } from '../src/codex/adapter.ts';
import { Store } from '../src/storage/store.ts';
import { thread } from './helpers.ts';

test('первый start после отказа doctor не создаёт базу и не получает сообщения Telegram', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ct-start-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = defaults(); config.telegram = { userId: 42, chatId: 42, botId: 123, initialOffset: 0 };
  config.codex.socketPath = join(directory, 'unused.sock');
  await writeFile(config.codex.socketPath, '');
  await saveConfig(directory, config, '123:synthetic_test_token_1234567');
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const method = input.split('/').at(-1)!; requests.push(method);
    assert.ok(['getMe', 'getWebhookInfo'].includes(method));
    return Response.json({ ok: true, result: method === 'getMe' ? { id: 123, username: 'test' } : { url: '' } });
  });
  t.mock.method(CodexAdapter.prototype, 'listThreads', async () => [{ ...thread('stored'), status: { type: 'notLoaded' }, canAcceptDirectInput: false }]);
  await assert.rejects(doctor(directory), /Проверка обнаружила/);
  await assert.rejects(start(directory), /Нет открытых/);
  assert.ok(!requests.includes('getUpdates'));
  for (const file of ['state.sqlite', 'codex-readiness.json', 'service.lock']) {
    await assert.rejects(stat(join(directory, file)), { code: 'ENOENT' });
  }
  const legacy = new Store(join(directory, 'state.sqlite')); legacy.setMeta('telegramOffset', '77'); legacy.close();
  await assert.rejects(start(directory), /Нет открытых/);
  const unchanged = new Store(join(directory, 'state.sqlite'));
  assert.equal(unchanged.getMeta('telegramOffset'), '77'); unchanged.close();
  assert.ok(!requests.includes('getUpdates'));
});

test('агент при первой неуспешной проверке не создаёт базу и не обращается к узлу', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ct-agent-start-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = defaults();
  const config: AgentConfig = { version: 2, role: 'agent', hostId: 'agent-test', hubId: 'hub-test', serverUrl: 'http://127.0.0.1:1', chatId: 42,
    codex: base.codex, artifacts: base.artifacts, notifications: base.notifications };
  await saveNetworkConfig(directory, config, 'a'.repeat(64));
  const fetcher = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network must not be used'); });
  t.mock.method(CodexAdapter.prototype, 'listThreads', async () => []);
  await assert.rejects(startNetwork(directory), /Нет открытых/);
  assert.equal(fetcher.mock.callCount(), 0);
  await assert.rejects(stat(join(directory, 'state.sqlite')), { code: 'ENOENT' });
});

test('start без CLI проходит проверку один раз, после отключения Codex сохраняет очередь и смещение Telegram', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ct-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = defaults(); config.telegram = { userId: 42, chatId: 42, botId: 123, initialOffset: 20 };
  config.codex.socketPath = join(directory, 'unused.sock');
  await saveConfig(directory, config, '123:synthetic_test_token_1234567');
  const threads = t.mock.method(CodexAdapter.prototype, 'listThreads', async () => [thread('original')]);
  t.mock.method(CodexAdapter.prototype, 'listTurns', async () => []);
  t.mock.method(CodexAdapter.prototype, 'listQueue', async () => []);
  let polls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const method = input.split('/').at(-1);
    if (method === 'getUpdates') {
      polls++;
      assert.equal(JSON.parse(init.body as string).offset, polls === 1 ? 20 : 77);
      process.emit('SIGINT');
      return Response.json({ ok: true, result: [] });
    }
    assert.ok(['getMe', 'getWebhookInfo'].includes(method!));
    return Response.json({ ok: true, result: method === 'getMe' ? { id: 123 } : { url: '' } });
  });
  await start(directory);
  assert.equal(threads.mock.callCount(), 1);
  const store = new Store(join(directory, 'state.sqlite'));
  const job = { id: 'pending', threadId: 'original', clientId: 'client', chatId: 42, messageId: 1, text: 'test', state: 'pending' as const };
  store.saveJob(job); store.setMeta('telegramOffset', '77'); store.close();
  threads.mock.mockImplementation(async () => { throw new Error('Offline'); });
  await start(directory);
  assert.equal(polls, 2); assert.equal(threads.mock.callCount(), 1);
  const restored = new Store(join(directory, 'state.sqlite'));
  assert.deepEqual(restored.job(job.id), job); assert.equal(restored.getMeta('telegramOffset'), '77'); restored.close();
});
