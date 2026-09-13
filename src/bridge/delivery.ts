import { createHash } from 'node:crypto';
import type { Config } from '../config/config.ts';
import type { TelegramPort } from '../types.ts';
import { RejectedOperationError } from '../types.ts';
import { Store } from '../storage/store.ts';
import type { Route } from '../storage/store.ts';
import { readArtifact, validateArtifactRoot } from '../artifacts/artifacts.ts';

export class DeliverySender {
  private config: Pick<Config, 'artifacts'>;
  private directory: string;
  private store: Store;
  private telegram: TelegramPort;
  private permits: (route: Route) => boolean;
  onDiagnostic: (message: string) => void = () => {};
  constructor(config: Pick<Config, 'artifacts'>, directory: string, store: Store, telegram: TelegramPort, permits: (route: Route) => boolean = () => true) {
    this.config = config; this.directory = directory; this.store = store; this.telegram = telegram; this.permits = permits;
  }
  async deliver(): Promise<void> {
    for (const delivery of this.store.deliveries()) {
      if (delivery.route && !this.permits(delivery.route)) {
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
  }}
