import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCodexReadiness, ensureCodexStartup } from '../src/codex/readiness.ts';
import { defaults } from '../src/config/config.ts';
import type { AgentConfig } from '../src/network/config.ts';
import { TestCodex, thread } from './helpers.ts';

test('проверка читает историю и очередь обеих выбранных задач без отправки поручений', async (t) => {
  const codex = new TestCodex(); codex.threads = [thread('first'), thread('second')];
  const history = t.mock.method(codex, 'listTurns');
  const queue = t.mock.method(codex, 'listQueue');
  assert.equal(await checkCodexReadiness(codex, ['first', 'second']), 2);
  assert.deepEqual(history.mock.calls.map((call) => call.arguments[0].id), ['first', 'second']);
  assert.deepEqual(queue.mock.calls.map((call) => call.arguments[0]), ['first', 'second']);
  assert.deepEqual(codex.submissions, []); assert.deepEqual(codex.starts, []);
});
test('одна доступная задача не скрывает отсутствующую, закрытую или несовместимую вторую', async () => {
  const codex = new TestCodex(); codex.threads = [thread('first')];
  await assert.rejects(checkCodexReadiness(codex, ['first', 'missing']), /все выбранные/);
  const second = { ...thread('second'), canAcceptDirectInput: false };
  codex.threads.push(second);
  await assert.rejects(checkCodexReadiness(codex, ['first', 'second']), /Не все/);
  second.canAcceptDirectInput = true;
  codex.listQueue = async (id) => { if (id === 'second') throw new Error('Queue unavailable'); return []; };
  await assert.rejects(checkCodexReadiness(codex, ['first', 'second']), /Queue unavailable/);
});
test('режим all проверяет открытые задачи и не требует загрузки всей сохранённой истории', async () => {
  const codex = new TestCodex();
  const stored = { ...thread('stored'), status: { type: 'notLoaded' as const }, canAcceptDirectInput: false };
  codex.threads = [stored];
  await assert.rejects(checkCodexReadiness(codex, []), /Нет открытых/);
  codex.threads.push(thread('open'));
  assert.equal(await checkCodexReadiness(codex, []), 1);
});
test('ошибка не разрешает запуск; успешная проверка позволяет восстановиться без Codex', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ct-ready-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = defaults(); const codex = new TestCodex();
  const resultPath = join(directory, 'codex-readiness.json');
  await assert.rejects(ensureCodexStartup(directory, config, codex), /Нет открытых/);
  await assert.rejects(stat(resultPath), { code: 'ENOENT' });
  codex.threads = [thread('open')];
  await ensureCodexStartup(directory, config, codex);
  const saved = await readFile(resultPath, 'utf8');
  assert.ok(!saved.includes(config.codex.socketPath));
  assert.ok(!saved.includes('open'));
  if (process.platform !== 'win32') assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
  codex.listThreads = async () => { throw new Error('Offline'); };
  await ensureCodexStartup(directory, config, codex);
  await assert.rejects(checkCodexReadiness(codex, []), /Offline/);
  const changed = [
    { ...config, codex: { ...config.codex, socketPath: join(directory, 'other.sock') } },
    { ...config, codex: { ...config.codex, threadIds: ['different'] } },
    { ...config, hostId: 'other-host' },
    { ...config, telegram: { ...config.telegram, botId: 999 } },
  ];
  for (const settings of changed) await assert.rejects(ensureCodexStartup(directory, settings, codex), /Offline/);
  await writeFile(resultPath, '{broken');
  await assert.rejects(ensureCodexStartup(directory, config, codex), /Offline/);
});

test('результат проверки одного компьютера не разрешает запуск другого подключения', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ct-agent-ready-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = defaults(); const codex = new TestCodex(); codex.threads = [thread('same-id')];
  const config: AgentConfig = { version: 2, role: 'agent', hostId: 'first-host', hubId: 'hub', serverUrl: 'https://hub.example', chatId: 42,
    codex: { ...base.codex, threadIds: ['same-id'] }, artifacts: base.artifacts, notifications: base.notifications };
  await ensureCodexStartup(directory, config, codex);
  codex.listThreads = async () => { throw new Error('Offline'); };
  for (const changed of [{ ...config, hostId: 'second-host' }, { ...config, hubId: 'other-hub' }, { ...config, serverUrl: 'https://other.example' }]) {
    await assert.rejects(ensureCodexStartup(directory, changed, codex), /Offline/);
  }
  await ensureCodexStartup(directory, config, codex);
});
