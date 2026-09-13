import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexRpc } from '../src/codex/rpc.ts';
import { CodexAdapter } from '../src/codex/adapter.ts';
import { TelegramClient } from '../src/telegram/client.ts';
import { RejectedOperationError, UncertainOperationError } from '../src/types.ts';

const script = fileURLToPath(new URL('./rpc-fixture.mjs', import.meta.url));
test('адаптер проходит инициализацию, читает исходную задачу и использует фактическую схему очереди', async (t) => {
  const rpc = new CodexRpc(process.execPath, [script]); const adapter = new CodexAdapter(rpc); t.after(() => adapter.close());
  const threads = await adapter.listThreads(); assert.equal(threads[0]!.id, 'original');
  assert.deepEqual(await adapter.listTurns(threads[0]!), []);
  assert.deepEqual(await adapter.queueMessage('original', 'client', 'Привет'), { id: 'queued', clientUserMessageId: 'client' });
  assert.deepEqual(await adapter.listQueue('original'), [{ id: 'queued', clientUserMessageId: 'client' }]);
  await adapter.startQueued('original', 'queued');
});
test('неизвестный результат RPC сохраняет неопределённость, соединение можно восстановить', async (t) => {
  const rpc = new CodexRpc(process.execPath, [script], 100); t.after(() => rpc.close());
  await rpc.connect(); await assert.rejects(rpc.request('hang', {}), UncertainOperationError);
  await assert.rejects(rpc.request('exit', {}), UncertainOperationError);
  await rpc.connect(); assert.ok(await rpc.request('thread/list', {}));
});
test('Bot API отправляет обычный текст с привязкой ответа и двоичное вложение', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init: init! }); return Response.json({ ok: true, result: { message_id: 77 } });
  };
  const client = new TelegramClient('123:TEST', fetcher);
  assert.equal(await client.sendText(42, '<текст>', 9), 77);
  const body = JSON.parse(requests[0]!.init.body as string);
  assert.equal(body.text, '<текст>'); assert.equal(body.reply_parameters.message_id, 9); assert.equal(body.parse_mode, undefined);
  await client.sendDocument(42, Buffer.from('%PDF-1.4'), 'report.pdf', 9);
  const form = requests[1]!.init.body as FormData;
  assert.equal(form.get('chat_id'), '42'); assert.equal((form.get('document') as File).name, 'report.pdf');
});
test('ограничение частоты и потеря ответа Telegram различаются; токен не попадает в ошибку', async () => {
  const limited = new TelegramClient('123:SECRET', async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 3 } }));
  await assert.rejects(limited.sendText(42, 'go'), (error) => error instanceof RejectedOperationError && error.retryAfter === 3);
  const lost = new TelegramClient('123:SECRET', async () => { throw new Error('URL with SECRET'); });
  await assert.rejects(lost.sendText(42, 'go'), (error) => error instanceof UncertainOperationError && !error.message.includes('SECRET'));
});
