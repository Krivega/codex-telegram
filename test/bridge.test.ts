import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, thread, completed } from './helpers.ts';
import { CodexUnavailableError, UncertainOperationError } from '../src/types.ts';
import { textParts } from '../src/bridge/bridge.ts';
import { jobDirectory } from '../src/artifacts/artifacts.ts';

test('ответы на две параллельные задачи сохраняют адресата; повтор события не запускает второе поручение', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  f.codex.threads = [thread('a'), thread('b')];
  f.codex.turns.set('a', [completed('a1')]); f.codex.turns.set('b', [completed('b1')]);
  await f.bridge.synchronize(); await f.bridge.deliver();
  assert.equal(f.telegram.texts.length, 2);
  assert.ok(f.telegram.texts.every((message) => !message.text.includes('Промежуточный')));
  const messageA = f.telegram.texts.find((message) => message.text.includes('Задача a'))!;
  const messageB = f.telegram.texts.find((message) => message.text.includes('Задача b'))!;
  const updates = [messageA, messageB].map((message, index) => ({ update_id: index + 1, message: {
    message_id: 10 + index, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: index ? 'Сделай PDF' : 'Сделай снимок', reply_to_message: { message_id: message.id },
  } }));
  f.store.ingest([...updates, updates[0]!]);
  await f.bridge.receive(); await f.bridge.submit(); await f.bridge.receive(); await f.bridge.submit();
  assert.deepEqual(f.codex.submissions.map((item) => item.threadId), ['a', 'b']);
  assert.equal(f.store.getMeta('telegramOffset'), '3');
  await f.bridge.synchronize(); await f.bridge.deliver();
  assert.equal(f.telegram.texts.filter((message) => message.text.startsWith('Ответ готов')).length, 2);
});
test('посторонний пользователь, другой чат и неизвестный ответ не запускают Codex', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  f.store.saveRoute(42, 100, { threadId: 'a' });
  f.store.ingest([
    { update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 99 }, text: 'run', reply_to_message: { message_id: 100 } } },
    { update_id: 2, message: { message_id: 2, chat: { id: 99, type: 'private' }, from: { id: 42 }, text: 'run', reply_to_message: { message_id: 100 } } },
    { update_id: 3, message: { message_id: 3, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: 'run', reply_to_message: { message_id: 101 } } },
  ]);
  await f.bridge.receive(); await f.bridge.submit(); await f.bridge.deliver();
  assert.equal(f.codex.submissions.length, 0); assert.equal(f.telegram.texts.length, 1);
});
test('потеря подтверждения Codex сверяется с очередью без повторной отправки', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  f.codex.threads = [thread('a')]; f.store.saveRoute(42, 100, { threadId: 'a' });
  f.store.ingest([{ update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: 'Продолжи', reply_to_message: { message_id: 100 } } }]);
  await f.bridge.receive(); f.codex.submitError = new UncertainOperationError('lost');
  await f.bridge.submit(); assert.equal(f.store.jobs()[0]!.state, 'uncertain');
  const job = f.store.jobs()[0]!;
  f.codex.queue.set('a', [{ id: 'accepted', clientUserMessageId: job.clientId }]);
  await f.bridge.submit(); await f.bridge.synchronize();
  assert.equal(f.codex.submissions.length, 1); assert.deepEqual(f.codex.starts, ['accepted']);
});
test('недоступный Codex до отправки оставляет поручение в ожидании', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  f.store.saveJob({ id: 'test', threadId: 'a', chatId: 42, messageId: 1, text: 'go', clientId: 'client', state: 'pending' });
  f.codex.submitError = new CodexUnavailableError();
  await f.bridge.submit(); assert.equal(f.store.jobs()[0]!.state, 'pending');
});
test('неопределённая доставка Telegram не повторяется автоматически', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  f.store.enqueue('one', 42, { kind: 'text', text: 'Готово' });
  f.telegram.error = new UncertainOperationError('timeout');
  await f.bridge.deliver(); f.telegram.error = undefined; await f.bridge.deliver();
  assert.equal(f.telegram.texts.length, 0);
  const uncertain = f.store.status().deliveries as { id: number; state: string }[];
  assert.equal(uncertain[0]!.state, 'uncertain');
  f.store.retryDelivery(uncertain[0]!.id); await f.bridge.deliver(); assert.equal(f.telegram.texts.length, 1);
});
test('поручение PDF завершается документом, ответ на документ сохраняет задачу', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  f.codex.threads = [thread('pdf')]; f.store.saveRoute(42, 100, { threadId: 'pdf' });
  f.store.ingest([{ update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: 'Сделай PDF', reply_to_message: { message_id: 100 } } }]);
  await f.bridge.receive(); await f.bridge.submit();
  const job = f.store.jobs()[0]!; const dir = jobDirectory(f.directory, job.id);
  const content = Buffer.from('%PDF-1.4\nfixture\n%%EOF');
  await writeFile(join(dir, 'result.pdf'), content);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ files: [{ path: 'result.pdf', name: 'Отчёт.pdf' }] }));
  f.codex.turns.set('pdf', [completed('turn-pdf', job.clientId)]);
  await f.bridge.synchronize(); await f.bridge.deliver();
  assert.equal(f.telegram.files.length, 1); assert.deepEqual(f.telegram.files[0]!.bytes, content);
  assert.deepEqual(f.store.route(42, f.telegram.files[0]!.id), { threadId: 'pdf', turnId: 'turn-pdf' });
  assert.equal(f.store.jobs().length, 0);
});
test('старые завершения при первом запуске не рассылаются', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  f.codex.threads = [thread('old')];
  f.codex.turns.set('old', [{ ...completed('old-turn'), completedAt: 1 }]);
  await f.bridge.synchronize(); await f.bridge.deliver(); assert.equal(f.telegram.texts.length, 0);
});
test('уточнение и замечание не превращаются в произвольную задачу', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  f.store.ingest([{ update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/feedback Слишком длинный итог' } }]);
  await f.bridge.receive(); await f.bridge.submit();
  assert.equal(f.store.feedback().length, 1); assert.equal(f.codex.submissions.length, 0);
});
test('длинный текст с emoji делится без повреждения символов и превышения лимита', () => {
  const text = '🙂Текст'.repeat(2000); const parts = textParts(text);
  assert.equal(parts.join(''), text); assert.ok(parts.every((part) => part.length <= 3800 && part.isWellFormed()));
});
