import { createHash } from 'node:crypto';
import type { Config } from '../config/config.ts';
import type { CodexPort, TelegramPort, TelegramUpdate, Thread, Turn } from '../types.ts';
import { CodexUnavailableError, RejectedOperationError } from '../types.ts';
import { Store } from '../storage/store.ts';
import type { Job, Route } from '../storage/store.ts';
import { collectArtifacts, preparePrompt, readArtifact, validateArtifactRoot } from '../artifacts/artifacts.ts';

const help = 'Ответьте на уведомление о задаче обычным текстом. Можно попросить снимок страницы или PDF.\n\n/tasks — список задач\n/full — полный ответ (ответом на уведомление)\n/status — состояние доставки\n/feedback текст — замечание о работе службы';
export function finalText(turn: Turn): string {
  const messages = turn.items.filter((item) => item.type === 'agentMessage');
  const finals = messages.filter((item) => item.phase === 'final_answer');
  return (finals.length ? finals : messages).at(-1)?.text?.trim() || turn.error?.message || 'Текст итогового ответа отсутствует.';
}
export function textParts(text: string, size = 3800): string[] {
  const parts: string[] = [];
  let part = '';
  for (const character of text) {
    if (part.length + character.length > size) { parts.push(part); part = ''; }
    part += character;
  }
  if (part) parts.push(part);
  return parts.length ? parts : ['Нет текста.'];
}
export class Bridge {
  private config: Config;
  private directory: string;
  private store: Store;
  private codex: CodexPort;
  private telegram: TelegramPort;
  private observed = new Map<string, string>();
  onDiagnostic: (message: string) => void = () => {};

  constructor(config: Config, directory: string, store: Store, codex: CodexPort, telegram: TelegramPort) {
    this.config = config; this.directory = directory; this.store = store; this.codex = codex; this.telegram = telegram;
    store.bindIdentity(JSON.stringify([config.hostId, config.telegram.botId, config.telegram.userId, config.telegram.chatId]));
    store.recover();
    if (!store.getMeta('enabledAt')) store.setMeta('enabledAt', String(Math.floor(Date.now() / 1000)));
    if (!store.getMeta('telegramOffset')) store.setMeta('telegramOffset', String(config.telegram.initialOffset));
  }
  accepts(update: TelegramUpdate): boolean {
    const message = update.message;
    return Boolean(message && message.from?.id === this.config.telegram.userId && !message.from.is_bot
      && message.chat.id === this.config.telegram.chatId && message.chat.type === 'private');
  }
  private permits(threadId: string): boolean {
    return this.config.codex.threadIds.length === 0 || this.config.codex.threadIds.includes(threadId);
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
          const id = `tg-${this.config.telegram.botId}-${update.update_id}`;
          this.store.saveJob({ id, threadId: route.threadId, chatId: message.chat.id, messageId: message.message_id, text, clientId: id, state: 'pending' });
          this.store.saveRoute(message.chat.id, message.message_id, route);
          this.reply(update, 'Поручение сохранено. Передам его в исходную задачу Codex.', route);
        }
        this.store.finishIncoming(update.update_id);
      });
    }
  }
  async submit(): Promise<void> {
    for (const job of this.store.jobs().filter((job) => job.state === 'pending')) {
      if (!this.permits(job.threadId)) { this.failJob(job, 'Доступ к этой задаче отключён в настройках.'); continue; }
      let prompt: string;
      try { prompt = await preparePrompt(this.directory, job); }
      catch { this.failJob(job, 'Не удалось подготовить каталог результатов.'); continue; }
      // До сетевого действия фиксируется состояние: после сбоя повтор возможен только после сверки.
      this.store.saveJob({ ...job, state: 'submitting' });
      try {
        const queued = await this.codex.queueMessage(job.threadId, job.clientId, prompt);
        this.store.saveJob({ ...job, queuedId: queued.id, state: 'queued' });
      } catch (error) {
        if (error instanceof CodexUnavailableError) {
          this.store.saveJob({ ...job, state: 'pending' });
          this.onDiagnostic('Codex недоступен. Поручение сохранено до восстановления соединения.');
          break;
        } else if (error instanceof RejectedOperationError) this.failJob(job, error.message);
        else {
          this.store.saveJob({ ...job, state: 'uncertain' });
          this.store.enqueue(`job-uncertain:${job.id}`, job.chatId,
            { kind: 'text', text: `Не удалось подтвердить приём поручения ${job.id}. Проверю очередь и историю Codex. Автоматически повторять поручение не буду.` }, { threadId: job.threadId }, job.messageId);
        }
      }
    }
  }
  private failJob(job: Job, reason: string): void {
    this.store.transaction(() => {
      this.store.saveJob({ ...job, state: 'failed' });
      this.store.enqueue(`job-failed:${job.id}`, job.chatId, { kind: 'text', text: `Поручение не принято: ${reason}` }, { threadId: job.threadId }, job.messageId);
    });
  }
  async synchronize(): Promise<void> {
    const enabledAt = Number(this.store.getMeta('enabledAt'));
    const threads = (await this.codex.listThreads()).filter((thread) => this.permits(thread.id));
    for (const thread of threads) {
      const jobs = this.store.jobs().filter((job) => job.threadId === thread.id);
      if (thread.updatedAt < enabledAt && !jobs.length && thread.status.type !== 'active') continue;
      const revision = JSON.stringify([thread.updatedAt, thread.status]);
      if (this.observed.get(thread.id) === revision && !jobs.length && thread.status.type !== 'active') continue;
      try {
        const turns = await this.codex.listTurns(thread);
        const flags = thread.status.activeFlags ?? [];
        if (flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')) {
          const activeTurn = turns.find((turn) => turn.status === 'inProgress');
          this.store.enqueue(`attention:${thread.id}:${activeTurn?.id ?? thread.updatedAt}:${flags.join(',')}`, this.config.telegram.chatId,
            { kind: 'text', text: `Задача «${thread.name ?? thread.id}» ожидает разрешения или уточнения. Откройте её в Codex, чтобы ответить на системный запрос.` }, { threadId: thread.id });
        }
        for (const job of jobs.filter((job) => ['queued', 'submitted', 'uncertain'].includes(job.state))) {
          const turn = turns.find((turn) => turn.items.some((item) => item.type === 'userMessage' && item.clientId === job.clientId));
          if (turn) {
            if (job.state !== 'submitted') this.store.saveJob({ ...job, state: 'submitted' });
          } else await this.reconcileQueue(thread, job);
        }
        for (const turn of [...turns].reverse()) {
          if (turn.status === 'inProgress') { this.store.setMeta(`active:${thread.id}:${turn.id}`, '1'); continue; }
          if (!['completed', 'failed', 'interrupted'].includes(turn.status) || this.store.seenTurn(thread.id, turn.id)) continue;
          const job = this.store.jobs().find((job) => job.threadId === thread.id && turn.items.some((item) => item.type === 'userMessage' && item.clientId === job.clientId));
          const afterStart = turn.completedAt != null ? turn.completedAt >= enabledAt : Boolean(this.store.getMeta(`active:${thread.id}:${turn.id}`));
          if (afterStart || job) await this.completeTurn(thread, turn, job);
          else this.store.markTurn(thread.id, turn.id);
        }
        this.observed.set(thread.id, revision);
      } catch { this.onDiagnostic(`Не удалось прочитать задачу ${thread.id}. Повторю проверку.`); }
    }
  }
  private async reconcileQueue(thread: Thread, job: Job): Promise<void> {
    if (thread.status.type === 'notLoaded') return;
    const queue = await this.codex.listQueue(thread.id);
    const entry = queue.find((entry) => entry.clientUserMessageId === job.clientId);
    if (!entry) return;
    this.store.saveJob({ ...job, state: 'queued', queuedId: entry.id });
    if (thread.status.type === 'idle' && queue[0]?.id === entry.id) {
      if ((await this.codex.readThread(thread.id)).status.type !== 'idle') return;
      await this.codex.startQueued(thread.id, entry.id);
      this.store.saveJob({ ...job, state: 'submitted', queuedId: entry.id });
    }
  }
  private async completeTurn(thread: Thread, turn: Turn, job?: Job): Promise<void> {
    const route = { threadId: thread.id, turnId: turn.id };
    const key = `turn:${thread.id}:${turn.id}`;
    const label = { completed: 'Ответ готов', failed: 'Ошибка выполнения', interrupted: 'Выполнение остановлено' }[turn.status];
    const full = finalText(turn);
    const summary = textParts(full, this.config.notifications.maxTextLength)[0]! + (full.length > this.config.notifications.maxTextLength ? '\n\nТекст сокращён. Ответьте /full, чтобы получить полный ответ.' : '');
    let files: Awaited<ReturnType<typeof collectArtifacts>> = [];
    let artifactError = false;
    if (job && turn.status === 'completed') {
      try { files = await collectArtifacts(this.directory, job, this.config.artifacts); }
      catch { artifactError = true; }
    }
    this.store.transaction(() => {
      this.store.enqueue(key, this.config.telegram.chatId, { kind: 'text', text: `${label}: ${(thread.name ?? thread.preview ?? thread.id).slice(0, 180)}\n\n${summary}` }, route, job?.messageId);
      files.forEach((body, index) => this.store.enqueue(`${key}:file:${index}`, this.config.telegram.chatId, body, route, job?.messageId));
      if (artifactError) this.store.enqueue(`${key}:file-error`, this.config.telegram.chatId,
        { kind: 'text', text: 'Список вложений не прошёл проверку. Попросите Codex проверить manifest.json, формат и размер файлов в каталоге поручения.' }, route, job?.messageId);
      if (job) this.store.saveJob({ ...job, state: 'done' });
      this.store.markTurn(thread.id, turn.id);
    });
  }
  async deliver(): Promise<void> {
    for (const delivery of this.store.deliveries()) {
      if (delivery.route && !this.permits(delivery.route.threadId)) {
        this.store.setDeliveryState(delivery.id, 'failed', 'Доступ к задаче отключён в настройках.');
        continue;
      }
      let bytes: Buffer | undefined;
      if (delivery.body.kind === 'file') {
        try {
          await validateArtifactRoot(this.directory, delivery.body.root);
          bytes = await readArtifact(delivery.body.root, delivery.body.path, this.config.artifacts.maxFileBytes);
          if (createHash('sha256').update(bytes).digest('hex') !== delivery.body.sha256) throw new Error('Файл изменился после регистрации.');
        } catch {
          this.store.setDeliveryState(delivery.id, 'failed', 'Вложение изменилось или недоступно.');
          this.store.enqueue(`file-failed:${delivery.id}`, delivery.chatId, { kind: 'text', text: 'Не удалось отправить вложение: файл изменился или недоступен.' }, delivery.route, delivery.replyTo);
          continue;
        }
      }
      this.store.setDeliveryState(delivery.id, 'sending');
      try {
        const messageId = delivery.body.kind === 'text'
          ? await this.telegram.sendText(delivery.chatId, delivery.body.text, delivery.replyTo)
          : await this.telegram.sendDocument(delivery.chatId, bytes!, delivery.body.name, delivery.replyTo);
        this.store.acknowledgeDelivery(delivery, messageId);
      } catch (error) {
        if (error instanceof RejectedOperationError && error.retryAfter !== undefined) {
          this.store.setDeliveryState(delivery.id, 'pending', 'Ограничение частоты Telegram.', Date.now() + Math.max(1, error.retryAfter) * 1000);
          break;
        }
        this.store.setDeliveryState(delivery.id, error instanceof RejectedOperationError ? 'failed' : 'uncertain', 'Нет подтверждения доставки. Проверьте Telegram перед повтором.');
        this.onDiagnostic(`Доставка ${delivery.id} требует проверки: node bin/codex-telegram.mjs status`);
        break;
      }
    }
  }
}
