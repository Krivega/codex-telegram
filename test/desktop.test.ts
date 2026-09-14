import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaults, validateConfig, writePrivateJson } from '../src/config/config.ts';
import { DesktopAdapter } from '../src/desktop/adapter.ts';
import { desktopServer } from '../src/desktop/server.ts';
import { prepareDesktopPlugin } from '../src/desktop/runtime.ts';
import { Store } from '../src/storage/store.ts';
import { Bridge } from '../src/bridge/bridge.ts';
import { TestTelegram } from './helpers.ts';

function row(type: string, payload: object): string { return JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n'; }
function started(id: string): string { return row('event_msg', { type: 'task_started', turn_id: id, started_at: Date.now() / 1000 }); }
function completed(id: string, text = 'Готово'): string { return row('event_msg', { type: 'task_complete', turn_id: id, completed_at: Date.now() / 1000, last_agent_message: text }); }
function received(id: string, clientId: string): string {
  return row('event_msg', { type: 'item_completed', turn_id: id, thread_id: 'a', item: {
    type: 'FunctionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread', output: `<codex_delegation><input>[codex-telegram:${clientId}]\nПоручение</input></codex_delegation>`,
  } });
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-test-'));
  const config = defaults(); config.telegram = { userId: 42, chatId: 42, botId: 123, initialOffset: 0 };
  config.codex = { ...config.codex, transport: 'desktop', sessionsPath: join(directory, 'sessions'), threadIds: ['a', 'b'] };
  await mkdir(config.codex.sessionsPath!);
  const path = (id: string) => join(config.codex.sessionsPath!, `rollout-${id}.jsonl`);
  for (const id of ['a', 'b']) await writeFile(path(id), row('session_meta', { id, cwd: directory }) + started('old') + completed('old'));
  await writePrivateJson(join(directory, 'config.json'), config);
  const adapter = new DesktopAdapter(directory, config);
  return { directory, config, path, adapter, cleanup: async () => { adapter.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('Desktop разрешает только выбранные задачи и читает дописываемые строки без повторного итога', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await assert.rejects(f.adapter.readThread('foreign'));
  await f.adapter.readThread('a');
  const ending = completed('new', 'Новый ответ');
  await appendFile(f.path('a'), started('new') + ending.slice(0, -5));
  assert.equal((await f.adapter.readThread('a')).status.type, 'active');
  await appendFile(f.path('a'), ending.slice(-5));
  const thread = await f.adapter.readThread('a');
  assert.equal(thread.status.type, 'idle');
  assert.equal(thread.turns!.at(-1)!.items.length, 1);
  assert.deepEqual((await f.adapter.readThread('a')).turns, thread.turns);
  await writeFile(f.path('b'), row('session_meta', { id: 'foreign', cwd: f.directory }) + started('x'));
  await assert.rejects(f.adapter.readThread('b'));
});

test('выданное поручение переживает перезапуск без повторной выдачи; другая задача продолжает работать', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await f.adapter.queueMessage('a', 'client-a', 'Создай файл');
  await f.adapter.queueMessage('a', 'client-a', 'Создай файл');
  await assert.rejects(f.adapter.queueMessage('a', 'client-a', 'Другой текст'));
  await f.adapter.queueMessage('a', 'second-a', 'После первого');
  await f.adapter.startQueued('a', 'client-a'); await f.adapter.startQueued('a', 'second-a');
  const claim = (await f.adapter.claim())!; assert.equal(claim.id, 'client-a');
  const restart = new DesktopAdapter(f.directory, f.config); t.after(() => restart.close());
  assert.equal(await restart.claim(), null);
  await restart.queueMessage('b', 'client-b', 'Для второй задачи'); await restart.startQueued('b', 'client-b');
  assert.equal((await restart.claim())!.threadId, 'b');
  assert.throws(() => restart.mailbox.report(claim.id, 'wrong-token', 'accepted'));
  restart.mailbox.report(claim.id, claim.token, 'uncertain');
  assert.equal(await restart.claim(), null);
  await appendFile(f.path('a'), started('accepted-turn') + received('accepted-turn', claim.id) + completed('accepted-turn'));
  assert.equal((await restart.claim())!.id, 'second-a');
});

test('два диспетчера не получают одно поручение; два компьютера имеют независимые очереди при одинаковом ID задачи', async (t) => {
  const first = await fixture(); const second = await fixture(); t.after(first.cleanup); t.after(second.cleanup);
  const another = new DesktopAdapter(first.directory, first.config); t.after(() => another.close());
  for (const f of [first, second]) { await f.adapter.queueMessage('a', 'same', 'Текст'); await f.adapter.startQueued('a', 'same'); }
  const claims = await Promise.all([first.adapter.claim(), another.claim()]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal((await second.adapter.claim())!.id, 'same');
});

test('MCP выдаёт исходный адрес и текст, а восстановленное завершение отправляет PDF в прежнюю привязку', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const store = new Store(join(f.directory, 'state.sqlite')); t.after(() => store.close());
  const telegram = new TestTelegram(); const bridge = new Bridge(f.config, f.directory, store, f.adapter, telegram);
  store.saveRoute(42, 99, { threadId: 'a' });
  store.ingest([{ update_id: 1, message: { message_id: 1000, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: 'Сделай PDF', reply_to_message: { message_id: 99 } } }]);
  await bridge.receive(); await bridge.submit(); await bridge.synchronize();
  const server = desktopServer(f.adapter); const client = new Client({ name: 'test', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  assert.equal((await client.listTools()).tools.length, 4);
  await client.callTool({ name: 'desktop_register', arguments: { threadId: 'dispatcher' } });
  assert.equal(f.adapter.permitsThread('dispatcher'), false);
  const response = await client.callTool({ name: 'desktop_claim', arguments: { dispatcherThreadId: 'dispatcher' } });
  const claim = JSON.parse((response.content as { text: string }[])[0]!.text);
  assert.equal(claim.threadId, 'a'); assert.match(claim.prompt, /^\[codex-telegram:tg-123-1\]\nСделай PDF/);
  await client.callTool({ name: 'desktop_report', arguments: { id: claim.id, token: claim.token, state: 'accepted' } });
  const output = join(f.directory, 'artifacts', 'tg-123-1');
  const pdf = Buffer.from('%PDF-1.4\nfixture\n%%EOF');
  await writeFile(join(output, 'result.pdf'), pdf);
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ files: [{ path: 'result.pdf', name: 'Проверка.pdf' }] }));
  await appendFile(f.path('a'), started('pdf-turn') + received('pdf-turn', claim.id) + completed('pdf-turn', 'PDF готов'));
  await bridge.synchronize(); await bridge.deliver(); await bridge.synchronize(); await bridge.deliver();
  assert.equal(telegram.files.length, 1); assert.deepEqual(telegram.files[0]!.bytes, pdf);
  assert.deepEqual(store.route(42, telegram.files[0]!.id), { threadId: 'a', turnId: 'pdf-turn' });
  assert.equal(store.jobs().length, 0);
  assert.equal(await f.adapter.claim(), null);
});

test('настройка Desktop допускает автоматический выбор; подготовленный плагин запускается с тем же каталогом без токена', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  assert.deepEqual(validateConfig({ ...f.config, codex: { ...f.config.codex, threadIds: [] } }).codex.threadIds, []);
  const path = await prepareDesktopPlugin(f.directory);
  const mcp = JSON.parse(await readFile(join(path, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.codex_telegram.command, process.execPath);
  assert.deepEqual(mcp.mcpServers.codex_telegram.args.slice(-2), ['--home', f.directory]);
  assert.equal(mcp.mcpServers.codex_telegram.env, undefined);
});

test('повреждённый журнал не раскрывает содержимое в ошибке, а смена бота не использует прежнюю очередь', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await appendFile(f.path('a'), '{"private-data":invalid}\n');
  await assert.rejects(f.adapter.readThread('a'), (error: Error) => !error.message.includes('private-data'));
  assert.throws(() => new DesktopAdapter(f.directory, { ...f.config, telegram: { ...f.config.telegram, botId: 999 } }));
});

test('подготовленный MCP запускается отдельным процессом через stdio', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const plugin = await prepareDesktopPlugin(f.directory);
  const connection = JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8')).mcpServers.codex_telegram;
  const client = new Client({ name: 'stdio-test', version: '1' });
  await client.connect(new StdioClientTransport({ ...connection, stderr: 'pipe' }));
  t.after(() => client.close());
  const result = await client.callTool({ name: 'desktop_status', arguments: {} });
  assert.equal((result.content as { text: string }[])[0]!.text, '[]');
});

test('занятая задача не получает поручения; посторонний вывод инструмента не подтверждает приём', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await f.adapter.queueMessage('a', 'client', 'Текст'); await f.adapter.startQueued('a', 'client');
  await appendFile(f.path('a'), started('busy'));
  assert.equal(await f.adapter.claim(), null);
  const spoof = received('busy', 'client').replace('send_message_to_thread', 'other_tool');
  await appendFile(f.path('a'), spoof);
  const turns = await f.adapter.listTurns(await f.adapter.readThread('a'));
  assert.ok(turns.every(turn => turn.items.every(item => !item.clientId)));
  await appendFile(f.path('a'), completed('busy'));
  assert.equal((await f.adapter.claim())!.id, 'client');
});

test('итог Desktop удаляет управляющие элементы приложения и сохраняет обычные ссылки', async () => {
  const { desktopText } = await import('../src/desktop/text.ts');
  assert.equal(desktopText('Готов :codex-file-citation{path="/tmp/result.pdf" purpose="output"}.\n[manifest](/tmp/manifest.json) и [сайт](https://example.com).\n\n- :codex-followup[Ещё]{prompt="Создай ещё"}'), 'Готов result.pdf.\nmanifest и [сайт](https://example.com).');
});
