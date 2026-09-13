import type { TelegramPort, TelegramUpdate } from '../types.ts';
import type { Route } from '../storage/store.ts';
import { DeliverySender } from '../bridge/delivery.ts';
import { textParts } from '../bridge/messages.ts';
import type { HubConfig } from './config.ts';
import { HubStore } from './store.ts';
import type { Host } from './store.ts';

const help = 'Ответьте на сообщение нужной задачи: поручение попадёт на исходный компьютер. Можно попросить снимок страницы или PDF.\n\n/hosts — компьютеры\n/tasks — задачи всех компьютеров\n/full — полный итог, ответом на уведомление\n/status — состояние очередей\n/feedback текст — сохранить замечание';
export class Coordinator {
  private config: HubConfig;
  private store: HubStore;
  sender: DeliverySender;
  constructor(config: HubConfig, directory: string, store: HubStore, telegram: TelegramPort) {
    this.config = config; this.store = store;
    store.bindIdentity(JSON.stringify(['hub', config.id, config.telegram.botId, config.telegram.userId, config.telegram.chatId]));
    store.recover();
    if (!store.getMeta('telegramOffset')) store.setMeta('telegramOffset', String(config.telegram.initialOffset));
    this.sender = new DeliverySender(config, directory, store, telegram, (route) => Boolean(route.hostId && store.host(route.hostId) && !store.host(route.hostId)!.revoked));
  }
  accepts(update: TelegramUpdate): boolean {
    const message = update.message;
    return Boolean(message && message.from?.id === this.config.telegram.userId && !message.from.is_bot && message.chat.id === this.config.telegram.chatId && message.chat.type === 'private');
  }
  availability(host: Host): string {
    if (host.revoked) return 'ключ отозван';
    if (Date.now() - host.lastSeen > this.config.offlineAfterMs) return 'нет связи';
    return host.codexOnline ? 'на связи' : 'служба на связи, Codex недоступен';
  }
  private reply(update: TelegramUpdate, text: string, route?: Route): void {
    textParts(text).forEach((part, index) => this.store.enqueue(`reply:${update.update_id}:${index}`, this.config.telegram.chatId, { kind: 'text', text: part }, route, update.message!.message_id));
  }
  receive(): void {
    for (const update of this.store.incoming()) {
      if (!this.accepts(update) || !update.message) { this.store.finishIncoming(update.update_id); continue; }
      const message = update.message;
      const route = message.reply_to_message ? this.store.route(message.chat.id, message.reply_to_message.message_id) : undefined;
      const host = route?.hostId ? this.store.host(route.hostId) : undefined;
      const text = message.text?.trim() ?? '';
      this.store.transaction(() => {
        if (text === '/tasks') this.tasks(update);
        else if (text === '/hosts') this.reply(update, this.store.hosts().map((host) => `${host.name} · ${this.availability(host)}`).join('\n') || 'Компьютеры ещё не подключены.');
        else if (text === '/status') this.reply(update, JSON.stringify(this.store.status(), null, 2));
        else if (text === '/full' && route && host && !host.revoked) {
          const full = this.store.getMeta(`full:${host.id}:${route.threadId}:${route.turnId}`);
          this.reply(update, full ?? 'Ответьте на уведомление с итогом выполнения.', route);
        } else if (text.startsWith('/feedback ')) {
          this.store.saveFeedback(update.update_id, text.slice(10), route);
          this.reply(update, 'Замечание сохранено на едином узле. Его можно прочитать командой feedback.');
        } else if (text.startsWith('/')) this.reply(update, help);
        else if (!text) this.reply(update, 'Пока принимаются текстовые поручения.');
        else if (!route || !host) this.reply(update, 'Ответьте на сообщение нужной задачи. Список доступен через /tasks.');
        else if (host.revoked) this.reply(update, `Подключение «${host.name}» отозвано. Поручение не принято.`);
        else {
          const id = `tg-${this.config.telegram.botId}-${update.update_id}`;
          this.store.saveJob({ id, hostId: host.id, threadId: route.threadId, chatId: message.chat.id, messageId: message.message_id, text, clientId: id, state: 'pending' });
          this.store.saveRoute(message.chat.id, message.message_id, route);
          this.reply(update, `${host.name} · ${this.availability(host)}.\nПоручение сохранено для исходной задачи. Если компьютер или Codex недоступен, оно дождётся восстановления связи.`, route);
        }
        this.store.finishIncoming(update.update_id);
      });
    }
  }
  private tasks(update: TelegramUpdate): void {
    let count = 0;
    for (const host of this.store.hosts().filter((host) => !host.revoked)) {
      for (const task of host.tasks.slice(0, 20)) {
        this.store.enqueue(`tasks:${update.update_id}:${host.id}:${task.id}`, this.config.telegram.chatId, { kind: 'text', text: `${host.name} · ${this.availability(host)}\n${task.name}\nОтветьте на это сообщение, чтобы продолжить задачу.` }, { hostId: host.id, threadId: task.id });
        count++;
      }
    }
    if (!count) this.reply(update, 'Задачи пока не получены. Проверьте /hosts и команду doctor на компьютерах.');
  }
}
