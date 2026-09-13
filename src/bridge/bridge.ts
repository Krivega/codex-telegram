import type { Config } from '../config/config.ts';
import type { CodexPort, TelegramPort, TelegramUpdate } from '../types.ts';
import { Store } from '../storage/store.ts';
import type { Route } from '../storage/store.ts';
import { CodexWorker } from './worker.ts';
import { DeliverySender } from './delivery.ts';
import { finalText, textParts } from './messages.ts';
export { finalText, textParts } from './messages.ts';

const help = 'Ответьте на уведомление о задаче обычным текстом. Можно попросить снимок страницы или PDF.\n\n/tasks — список задач\n/full — полный ответ (ответом на уведомление)\n/status — состояние доставки\n/feedback текст — замечание о работе службы';
export class Bridge extends CodexWorker {
  private localConfig: Config;
  private sender: DeliverySender;
  constructor(config: Config, directory: string, store: Store, codex: CodexPort, telegram: TelegramPort) {
    store.bindIdentity(JSON.stringify([config.hostId, config.telegram.botId, config.telegram.userId, config.telegram.chatId]));
    store.recover();
    super({ ...config, chatId: config.telegram.chatId }, directory, store, codex);
    this.localConfig = config;
    this.sender = new DeliverySender(config, directory, store, telegram, (route) => this.permits(route.threadId));
    if (!store.getMeta('telegramOffset')) store.setMeta('telegramOffset', String(config.telegram.initialOffset));
  }
  accepts(update: TelegramUpdate): boolean {
    const message = update.message;
    return Boolean(message && message.from?.id === this.localConfig.telegram.userId && !message.from.is_bot
      && message.chat.id === this.localConfig.telegram.chatId && message.chat.type === 'private');
  }
  private reply(update: TelegramUpdate, text: string, route?: Route): void {
    if (!update.message) return;
    textParts(text).forEach((part, index) => this.store.enqueue(`reply:${update.update_id}:${index}`, update.message!.chat.id,
      { kind: 'text', text: part }, route, update.message!.message_id));
  }
  async receive(): Promise<void> {
    for (const update of this.store.incoming()) {
      if (!this.accepts(update) || !update.message) { this.store.finishIncoming(update.update_id); continue; }
      const message = update.message;
      const route = message.reply_to_message ? this.store.route(message.chat.id, message.reply_to_message.message_id) : undefined;
      const text = message.text?.trim();
      if (!text) {
        this.store.transaction(() => { this.reply(update, 'Пока принимаются текстовые поручения.'); this.store.finishIncoming(update.update_id); });
        continue;
      }
      if (text === '/tasks') {
        try {
          const threads = (await this.codex.listThreads()).filter((thread) => this.permits(thread.id)).slice(0, 20);
          this.store.transaction(() => {
            threads.forEach((thread) => this.store.enqueue(`tasks:${update.update_id}:${thread.id}`, message.chat.id,
              { kind: 'text', text: `${thread.name ?? thread.preview?.slice(0, 150) ?? thread.id}\nОтветьте на это сообщение, чтобы продолжить задачу.` }, { threadId: thread.id }));
            if (!threads.length) this.reply(update, 'Доступные задачи не найдены.');
            this.store.finishIncoming(update.update_id);
          });
        } catch { this.store.transaction(() => { this.reply(update, 'Codex недоступен. Проверьте подключение командой doctor.'); this.store.finishIncoming(update.update_id); }); }
        continue;
      }
      if (text === '/full' && route && this.permits(route.threadId)) {
        try {
          const turns = await this.codex.listTurns(await this.codex.readThread(route.threadId));
          const turn = turns.find((turn) => turn.id === route.turnId);
          this.store.transaction(() => { this.reply(update, turn ? finalText(turn) : 'Ответьте на уведомление с итогом конкретного выполнения.', route); this.store.finishIncoming(update.update_id); });
        } catch { this.store.transaction(() => { this.reply(update, 'Не удалось прочитать итог в Codex.', route); this.store.finishIncoming(update.update_id); }); }
        continue;
      }
      this.store.transaction(() => {
        if (text === '/start' || text.startsWith('/start ') || text === '/help') this.reply(update, help);
        else if (text === '/status') this.reply(update, `Служба работает.\n${JSON.stringify(this.store.status(), null, 2)}`);
        else if (text.startsWith('/feedback ')) {
          this.store.saveFeedback(update.update_id, text.slice(10), route);
          this.reply(update, 'Замечание сохранено локально. Его можно посмотреть командой feedback.', route);
        } else if (text.startsWith('/')) this.reply(update, help);
        else if (!route || !this.permits(route.threadId)) this.reply(update, 'Ответьте на уведомление нужной задачи. Список доступен через /tasks.');
        else {
          const id = `tg-${this.localConfig.telegram.botId}-${update.update_id}`;
          this.store.saveJob({ id, threadId: route.threadId, chatId: message.chat.id, messageId: message.message_id, text, clientId: id, state: 'pending' });
          this.store.saveRoute(message.chat.id, message.message_id, route);
          this.reply(update, 'Поручение сохранено. Передам его в исходную задачу Codex.', route);
        }
        this.store.finishIncoming(update.update_id);
      });
    }
  }
  async deliver(): Promise<void> {
    this.sender.onDiagnostic = this.onDiagnostic;
    await this.sender.deliver();
  }
}
