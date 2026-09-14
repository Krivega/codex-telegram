import { codexConnection } from '../codex/connection.ts';
import { access, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadNetworkConfig } from './config.ts';
import type { AgentConfig, HubConfig } from './config.ts';
import { AgentStore, HubStore } from './store.ts';
import { HubServer } from './server.ts';
import { HubClient } from './client.ts';
import { Coordinator } from './coordinator.ts';
import { AgentLink } from './agent.ts';
import { CodexWorker } from '../bridge/worker.ts';
import { TelegramClient } from '../telegram/client.ts';
import { checkCodexReadiness, ensureCodexStartup } from '../codex/readiness.ts';
import { acquireLock } from '../storage/lock.ts';

function logger(): (message: string) => void {
  const last = new Map<string, number>();
  return (message) => {
    if (Date.now() - (last.get(message) ?? 0) < 60000) return;
    if (last.size > 100) last.clear();
    last.set(message, Date.now()); console.log(`${new Date().toISOString()} ${message}`);
  };
}
async function repeat(signal: AbortSignal, interval: number, work: () => Promise<void>, onError: () => void): Promise<void> {
  while (!signal.aborted) {
    try { await work(); } catch { if (!signal.aborted) onError(); }
    await delay(interval, undefined, { signal }).catch(() => {});
  }
}
async function runHub(config: HubConfig, directory: string, token: string, stop: AbortController): Promise<void> {
  const telegram = new TelegramClient(token);
  if ((await telegram.getMe()).id !== config.telegram.botId) throw new Error('Токен принадлежит другому боту.');
  if ((await telegram.getWebhookInfo()).url) throw new Error('Бот используется другим получателем webhook.');
  const store = new HubStore(join(directory, 'state.sqlite'));
  const server = new HubServer(config, directory, store);
  try {
    const hub = new Coordinator(config, directory, store, telegram);
    const log = logger(); hub.sender.onDiagnostic = log;
    await server.listen();
    console.log(`Единый узел запущен: ${config.publicUrl}. Для подключения компьютера выполните pair --name "Название".`);
    await Promise.all([
      repeat(stop.signal, 5000, async () => {
        const updates = await telegram.getUpdates(Number(store.getMeta('telegramOffset')), stop.signal);
        store.ingest(updates.map((update) => hub.accepts(update) ? update : { update_id: update.update_id }));
      }, () => log('Telegram недоступен. Повторю получение сообщений.')),
      repeat(stop.signal, 1000, async () => { hub.receive(); await hub.sender.deliver(); }, () => log('Ошибка обработки очереди. Состояние сохранено; проверьте status.')),
    ]);
  } finally { await server.close(); store.close(); }
}
async function runAgent(config: AgentConfig, directory: string, token: string, stop: AbortController): Promise<void> {
  const codex = codexConnection(config, directory);
  let store: AgentStore | undefined;
  try {
    await ensureCodexStartup(directory, config, codex);
    store = new AgentStore(join(directory, 'state.sqlite'));
    const link = new AgentLink(config, directory, store, new HubClient(config.serverUrl, token));
    link.permitsThread = (id) => codex.permitsThread?.(id) ?? true;
    const worker = new CodexWorker(config, directory, store, codex);
    const log = logger(); worker.onDiagnostic = log; link.onDiagnostic = log;
    let codexOnline = false;
    console.log(`Компьютер ${config.hostId} подключается к ${config.serverUrl}. Токен Telegram здесь не нужен.`);
    await Promise.all([
      repeat(stop.signal, config.codex.pollIntervalMs, async () => {
        await worker.submit();
        try { await worker.synchronize(); codexOnline = true; }
        catch { codexOnline = false; log('Локальный Codex недоступен. Поручения сохранены на этом компьютере.'); }
      }, () => { codexOnline = false; log('Ошибка локальной обработки. Проверьте status и doctor.'); }),
      repeat(stop.signal, 2000, async () => {
        await link.synchronize(worker, codexOnline, stop.signal);
        await link.publish(stop.signal);
      }, () => log('Нет подтверждения от единого узла. Проверьте соединение и ключ командой doctor.')),
    ]);
  } finally { codex.close(); store?.close(); }
}
export async function startNetwork(directory: string): Promise<void> {
  const { config, secret } = await loadNetworkConfig(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await acquireLock(directory);
  const stop = new AbortController(); const abort = () => stop.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    if (config.role === 'hub') await runHub(config, directory, secret, stop);
    else await runAgent(config, directory, secret, stop);
  } finally { stop.abort(); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); await release(); }
}
export async function doctorNetwork(directory: string): Promise<void> {
  const { config, secret } = await loadNetworkConfig(directory);
  let failed = false;
  const check = async (name: string, work: () => Promise<string>) => {
    try { console.log(`✓ ${name}: ${await work()}`); }
    catch (error) { failed = true; console.log(`✗ ${name}: ${error instanceof Error ? error.message : 'ошибка'}`); }
  };
  await check('Настройки', async () => {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Нужен Node.js 24 или новее.');
    for (const name of ['config.json', 'secrets.json']) {
      if (process.platform !== 'win32' && ((await stat(join(directory, name))).mode & 0o077) !== 0) throw new Error(`Ограничьте права ${name}: chmod 600.`);
    }
    return config.role === 'hub' ? 'единый узел' : `компьютер ${config.hostId}`;
  });
  if (config.role === 'hub') {
    const telegram = new TelegramClient(secret);
    await check('Telegram', async () => {
      const me = await telegram.getMe();
      if (me.id !== config.telegram.botId || (await telegram.getWebhookInfo()).url) throw new Error('Другой бот или включён webhook.');
      return `@${me.username}`;
    });
    await check('Сетевой адрес', async () => {
      if (config.listen.tls) { await access(config.listen.tls.certPath); await access(config.listen.tls.keyPath); }
      return `${config.publicUrl}; доступ с другого компьютера проверяется командой doctor на нём`;
    });
  } else {
    await check('Единый узел', async () => {
      const result = await new HubClient(config.serverUrl, secret).request('/v1/check', {}) as { hostId?: string; hubId?: string; name?: string };
      if (result.hostId !== config.hostId || result.hubId !== config.hubId) throw new Error('Ключ принадлежит другому компьютеру.');
      return result.name ?? config.hostId;
    });
    const codex = codexConnection(config, directory);
    try {
      await check('Codex', async () => {
        if (config.codex.transport !== 'desktop') await access(config.codex.socketPath).catch(() => { throw new Error('Не найден сокет сервера, обслуживающего задачи приложения Codex.'); });
        const count = await checkCodexReadiness(codex, config.codex.threadIds, { allowEmpty: config.codex.transport === 'desktop' && !config.codex.threadIds.length });
        return config.codex.transport === 'desktop' ? `${count} журналов и локальная очередь доступны; отправку через диспетчер проверьте вручную` : `${count} открытых задач; история и очередь каждой доступны; совпадение с окном приложения проверяется отдельно`;
      });
    } finally { codex.close(); }
  }
  if (failed) throw new Error('Служба ещё не готова к работе. Исправьте указанные ошибки.');
}
