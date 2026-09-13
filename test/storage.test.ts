import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.ts';
import { acquireLock } from '../src/storage/lock.ts';

test('перезапуск сохраняет сообщения, адреса и неопределённые операции', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-telegram-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const before = new Store(path);
  before.ingest([{ update_id: 10 }]); before.saveRoute(42, 100, { threadId: 'a' });
  before.saveJob({ id: 'job', threadId: 'a', chatId: 42, messageId: 1, text: 'go', clientId: 'client', state: 'submitting' });
  before.enqueue('event', 42, { kind: 'text', text: 'готово' });
  before.setDeliveryState(before.deliveries()[0]!.id, 'sending'); before.close();
  const after = new Store(path); t.after(() => after.close()); after.recover();
  assert.equal(after.getMeta('telegramOffset'), '11'); assert.equal(after.incoming().length, 1);
  assert.deepEqual(after.route(42, 100), { threadId: 'a' }); assert.equal(after.jobs()[0]!.state, 'uncertain');
  assert.equal(after.deliveries().length, 0); assert.equal(after.status().deliveries.length, 1);
  after.enqueue('event', 42, { kind: 'text', text: 'ещё' }); assert.equal(after.deliveries().length, 0);
});
test('другой компьютер или бот не может использовать сохранённые привязки', () => {
  const store = new Store(':memory:');
  try { store.bindIdentity('one'); assert.throws(() => store.bindIdentity('two'), /другому компьютеру/); }
  finally { store.close(); }
});
test('вторая копия службы не получает блокировку', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-telegram-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = await acquireLock(directory);
  await assert.rejects(acquireLock(directory), /уже работает/);
  await release(); const next = await acquireLock(directory); await next();
});
