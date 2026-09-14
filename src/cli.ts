import { parseArgs } from 'node:util';
import { access, mkdir, stat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { configDirectory, loadConfig } from './config/config.ts';
import type { Config } from './config/config.ts';
import { CodexRpc } from './codex/rpc.ts';
import { CodexAdapter } from './codex/adapter.ts';
import { TelegramClient } from './telegram/client.ts';
import { Store } from './storage/store.ts';
import { acquireLock } from './storage/lock.ts';
import { Bridge } from './bridge/bridge.ts';
import { setup } from './setup/wizard.ts';
import { setupNetwork } from './network/setup.ts';
import { loadNetworkConfig } from './network/config.ts';
import { startNetwork, doctorNetwork } from './network/runtime.ts';
import { HubStore } from './network/store.ts';
import { installService, uninstallService } from './setup/service.ts';

function codexConnection(config: Config): CodexAdapter {
  return new CodexAdapter(CodexRpc.overUnixSocket(config.codex.socketPath));
}
export async function doctor(directory: string): Promise<void> {
  const { config, token } = await loadConfig(directory);
  let failed = false;
  const check = async (name: string, run: () => Promise<string>): Promise<void> => {
    try { console.log(`✓ ${name}: ${await run()}`); }
    catch (error) { failed = true; console.log(`✗ ${name}: ${error instanceof Error ? error.message : 'ошибка'}`); }
  };
  await check('Node.js', async () => {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Нужна версия 24 или новее.');
    return process.versions.node;
  });
  await check('Файлы настроек', async () => {
    if (process.platform !== 'win32') {
      for (const name of ['config.json', 'secrets.json']) {
        if (name === 'secrets.json' && process.env.TELEGRAM_BOT_TOKEN) continue;
        const info = await stat(join(directory, name));
        if ((info.mode & 0o077) !== 0) throw new Error(`Ограничьте права ${name}: chmod 600.`);
      }
    }
    return 'личные настройки отделены от проекта';
  });
  const telegram = new TelegramClient(token);
  await check('Telegram', async () => {
    const me = await telegram.getMe();
    if (me.id !== config.telegram.botId) throw new Error('Токен принадлежит другому боту.');
    if ((await telegram.getWebhookInfo()).url) throw new Error('У бота установлен webhook; нужен отдельный бот для этой службы.');
    return `@${me.username}, владелец ${config.telegram.userId}`;
  });
  const codex = codexConnection(config);
  try {
    await check('Codex', async () => {
      await access(config.codex.socketPath).catch(() => { throw new Error('Общий сокет не найден. Требуется адрес сервера, который обслуживает нужные задачи приложения. Отдельный сервер не подтверждает эту связь.'); });
      const threads = await codex.listThreads();
      const selected = threads.filter((thread) => config.codex.threadIds.length === 0 || config.codex.threadIds.includes(thread.id));
      if (!selected.length) throw new Error('В указанном сервере не найдены выбранные задачи.');
      await codex.listTurns(selected[0]!);
      const loaded = selected.find((thread) => thread.status.type !== 'notLoaded' && thread.canAcceptDirectInput === true);
      if (!loaded) throw new Error('История доступна, но этот сервер не обслуживает открытую задачу приложения. Службу запускать нельзя: нужен поддерживаемый приложением общий сервер, а не отдельный демон или внутренняя настройка клиента.');
      await codex.listQueue(loaded.id);
      return `${selected.length} задач; чтение истории и очереди доступно. Совпадение с окном приложения проверяется отдельно.`;
    });
  } finally { codex.close(); }
  if (failed) throw new Error('Проверка обнаружила проблемы. Служба ещё не готова к работе.');
  console.log('Токен и содержимое задач в диагностику не включены. Сквозную проверку выполните по docs/acceptance.md.');
}
export async function start(directory: string): Promise<void> {
  const { config, token } = await loadConfig(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await acquireLock(directory);
  const codex = codexConnection(config);
  let store: Store | undefined;
  const stop = new AbortController();
  const stopHandler = () => stop.abort();
  process.once('SIGINT', stopHandler); process.once('SIGTERM', stopHandler);
  try {
    const telegram = new TelegramClient(token);
    if ((await telegram.getMe()).id !== config.telegram.botId) throw new Error('Токен принадлежит другому боту.');
    if ((await telegram.getWebhookInfo()).url) throw new Error('Бот используется другим получателем webhook.');
    store = new Store(join(directory, 'state.sqlite'));
    const bridge = new Bridge(config, directory, store, codex, telegram);
    let lastDiagnostic = '';
    let lastDiagnosticAt = 0;
    const log = (message: string) => {
      if (message !== lastDiagnostic || Date.now() - lastDiagnosticAt > 60000) {
        console.log(`${new Date().toISOString()} ${message}`); lastDiagnostic = message; lastDiagnosticAt = Date.now();
      }
    };
    bridge.onDiagnostic = log;
    const pause = async (ms: number) => { await delay(ms, undefined, { signal: stop.signal }).catch(() => {}); };
    const receiver = async () => {
      while (!stop.signal.aborted) {
        try {
          const updates = await telegram.getUpdates(Number(store!.getMeta('telegramOffset')), stop.signal);
          store!.ingest(updates.map((update) => bridge.accepts(update) ? update : { update_id: update.update_id }));
        } catch { if (!stop.signal.aborted) { log('Telegram недоступен. Повторю получение сообщений.'); await pause(5000); } }
      }
    };
    const worker = async () => {
      while (!stop.signal.aborted) {
        await bridge.receive();
        await bridge.submit();
        try { await bridge.synchronize(); }
        catch { log('Codex недоступен. Поручения и уведомления остаются в локальной базе.'); }
        await bridge.deliver();
        await pause(config.codex.pollIntervalMs);
      }
    };
    console.log('Служба запущена. Для остановки нажмите Ctrl+C.');
    const tasks = [receiver(), worker()];
    try { await Promise.all(tasks); }
    catch (error) { stop.abort(); await Promise.allSettled(tasks); throw error; }
    finally { stop.abort(); }
  } finally {
    stop.abort(); codex.close(); store?.close(); await release();
    process.removeListener('SIGINT', stopHandler); process.removeListener('SIGTERM', stopHandler);
  }
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs({ args, allowPositionals: true, options: {
    home: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' }, host: { type: 'string' }, help: { type: 'boolean', short: 'h' }, delivery: { type: 'string' }, 'confirm-duplicate-risk': { type: 'boolean' },
  } });
  const directory = parsed.values.home ? resolve(parsed.values.home) : configDirectory();
  const command = parsed.positionals[0] ?? 'help';
  if (parsed.values.help || command === 'help') {
    console.log('Codex Telegram\n\nsetup [--role hub|agent|local] — пошаговая настройка\ndoctor — проверка соединений без отправки сообщений\nstart — запуск службы\npair --name НАЗВАНИЕ — выдать код подключения на едином узле\nhosts — подключённые компьютеры\nrevoke --host ID — отозвать ключ компьютера\nstatus — очередь и неопределённые доставки\nfeedback — сохранённые замечания\nconfig — показать настройки без секретов\nservice install | uninstall — автоматический запуск на macOS\nretry --delivery ID --confirm-duplicate-risk — повторить доставку после проверки Telegram\n\n--home PATH или CODEX_TELEGRAM_HOME — отдельный каталог настроек.');
    return;
  }
  const version = await readFile(join(directory, 'config.json'), 'utf8').then((raw) => JSON.parse(raw).version as number, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (command === 'setup') {
    if (parsed.values.role === 'local' || (version === 1 && !parsed.values.role)) return setup(directory);
    return setupNetwork(directory, parsed.values.role);
  }
  if (version === 2) {
    if (command === 'start') return startNetwork(directory);
    if (command === 'doctor') return doctorNetwork(directory);
    if (command === 'config') { console.log(JSON.stringify((await loadNetworkConfig(directory)).config, null, 2)); return; }
    if (command === 'service' && parsed.positionals[1] === 'install') {
      await doctorNetwork(directory);
      const { config } = await loadNetworkConfig(directory);
      return installService(directory, config.role === 'hub' ? process.execPath : config.codex.executable);
    }
    if (['pair', 'hosts', 'revoke'].includes(command)) {
      const { config } = await loadNetworkConfig(directory);
      if (config.role !== 'hub') throw new Error('Эту команду нужно выполнять на едином узле.');
      const store = new HubStore(join(directory, 'state.sqlite'));
      try {
        store.bindIdentity(JSON.stringify(['hub', config.id, config.telegram.botId, config.telegram.userId, config.telegram.chatId]));
        if (command === 'hosts') console.log(JSON.stringify(store.hosts().map(({ tasks: _tasks, ...host }) => host), null, 2));
        else if (command === 'revoke') { store.revoke(parsed.values.host ?? ''); console.log('Ключ отозван. Новые поручения и результаты этого подключения не принимаются. Уже полученные компьютером поручения могут выполняться. Для их остановки остановите локальную службу.'); }
        else {
          const pairing = store.issuePairing(parsed.values.name ?? '');
          console.log(`На подключаемом компьютере выполните setup --role agent.\nАдрес узла: ${config.publicUrl}\nОдноразовый код (5 минут): ${pairing.code}\nИдентификатор: ${pairing.hostId}\nНе публикуйте код. Для каждого компьютера выдавайте новый.`);
        }
      } finally { store.close(); }
      return;
    }
  }
  if (command === 'doctor') return doctor(directory);
  if (command === 'start') return start(directory);
  if (command === 'config') { console.log(JSON.stringify((await loadConfig(directory)).config, null, 2)); return; }
  if (command === 'service') {
    if (parsed.positionals[1] === 'uninstall') return uninstallService(directory);
    if (parsed.positionals[1] !== 'install') throw new Error('Используйте service install или service uninstall.');
    await access(join(directory, 'secrets.json')).catch(() => { throw new Error('Для автоматического запуска сохраните токен через setup. Переменная текущего терминала не передаётся launchd.'); });
    await doctor(directory);
    return installService(directory, (await loadConfig(directory)).config.codex.executable);
  }
  if (['status', 'feedback', 'retry'].includes(command)) {
    await access(join(directory, 'state.sqlite')).catch(() => { throw new Error('База ещё не создана. Сначала настройте и запустите службу.'); });
    const release = command === 'retry' ? await acquireLock(directory) : undefined;
    const store = version === 2 && (await loadNetworkConfig(directory)).config.role === 'hub' ? new HubStore(join(directory, 'state.sqlite')) : new Store(join(directory, 'state.sqlite'));
    try {
      if (command === 'status') console.log(JSON.stringify(store.status(), null, 2));
      else if (command === 'feedback') console.log(JSON.stringify(store.feedback(), null, 2));
      else {
        const id = Number(parsed.values.delivery);
        if (!parsed.values['confirm-duplicate-risk'] || !Number.isSafeInteger(id) || id <= 0) throw new Error('Сначала проверьте Telegram. Повтор может создать дубликат; укажите --delivery ID --confirm-duplicate-risk при остановленной службе.');
        store.retryDelivery(id); console.log('Доставка возвращена в очередь. Запустите службу.');
      }
    } finally { store.close(); await release?.(); }
    return;
  }
  throw new Error(`Неизвестная команда ${command}. Используйте --help.`);
}
