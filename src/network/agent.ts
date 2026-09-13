import type { AgentConfig } from './config.ts';
import { AgentStore, digest } from './store.ts';
import { HubClient } from './client.ts';
import { textParts } from '../bridge/messages.ts';
import type { CodexWorker } from '../bridge/worker.ts';
import type { Job } from '../storage/store.ts';
import { readArtifact, validateArtifactRoot } from '../artifacts/artifacts.ts';
import { HttpError, record, string, positive, idPattern } from './protocol.ts';

export class AgentLink {
  private config: AgentConfig;
  private directory: string;
  private store: AgentStore;
  private client: HubClient;
  onDiagnostic: (message: string) => void = () => {};
  constructor(config: AgentConfig, directory: string, store: AgentStore, client: HubClient) {
    this.config = config; this.directory = directory; this.store = store; this.client = client;
    store.bindIdentity(JSON.stringify(['agent', config.hubId, config.hostId, config.chatId]));
    // Узел подтверждает события по устойчивому ключу: повтор после потери ответа безопасен.
    store.recoverRemoteDeliveries();
  }
  async synchronize(worker: CodexWorker, codexOnline: boolean, signal?: AbortSignal): Promise<void> {
    const reports = this.store.reports();
    const response = record(await this.client.request('/v1/sync', { tasks: worker.inventory.slice(0, 1000), codexOnline, reports }, signal));
    if (response.hostId !== this.config.hostId || response.hubId !== this.config.hubId || !Array.isArray(response.jobs) || response.jobs.length > 100) throw new HttpError(502, 'Ответ адресован другому компьютеру или содержит неверную очередь.');
    const jobs = response.jobs.map((value) => this.parseJob(value));
    this.store.transaction(() => {
      jobs.forEach((job) => this.store.accept(job));
      this.store.acknowledgeReports(reports);
    });
  }
  private parseJob(value: unknown): Job {
    const job = record(value);
    if (job.hostId !== this.config.hostId || job.chatId !== this.config.chatId || job.state !== 'pending') throw new HttpError(502, 'Поручение адресовано другому компьютеру или владельцу.');
    return { id: string(job.id, 100, idPattern), hostId: this.config.hostId, chatId: this.config.chatId, messageId: positive(job.messageId), threadId: string(job.threadId, 100, idPattern), clientId: string(job.clientId, 100, idPattern), text: string(job.text, 4096), state: 'pending' };
  }
  async publish(signal?: AbortSignal): Promise<void> {
    for (const delivery of this.store.deliveries().slice(0, 20)) {
      const route = delivery.route;
      if (!route) { this.store.setDeliveryState(delivery.id, 'failed', 'Не указана исходная задача.'); continue; }
      if (this.config.codex.threadIds.length && !this.config.codex.threadIds.includes(route.threadId)) {
        this.store.setDeliveryState(delivery.id, 'failed', 'Доступ к задаче отключён в настройках.'); continue;
      }
      let bytes: Buffer | undefined;
      if (delivery.body.kind === 'file') {
        try {
          await validateArtifactRoot(this.directory, delivery.body.root);
          bytes = await readArtifact(delivery.body.root, delivery.body.path, this.config.artifacts.maxFileBytes);
          if (digest(bytes) !== delivery.body.sha256) throw new Error('Изменился файл.');
        } catch {
          this.store.setDeliveryState(delivery.id, 'failed', 'Вложение изменилось или недоступно.');
          this.store.enqueue(`file-failed:${delivery.key}`, delivery.chatId, { kind: 'text', text: 'Не удалось отправить вложение: файл изменился или недоступен.' }, route, delivery.replyTo);
          continue;
        }
      }
      const body = delivery.body.kind === 'text' ? { ...delivery.body } : { kind: 'file', name: delivery.body.name, sha256: delivery.body.sha256 };
      if ('fullText' in body && body.fullText && Buffer.byteLength(JSON.stringify(body.fullText)) > 1024 * 1024) {
        body.fullText = textParts(body.fullText, 160000)[0]! + '\n\nИтог превышает 1 МиБ. Откройте исходную задачу Codex для чтения целиком.';
      }
      const event = { key: delivery.key, threadId: route.threadId, turnId: route.turnId, replyTo: delivery.replyTo, body };
      this.store.setDeliveryState(delivery.id, 'sending');
      try {
        const response = record(bytes ? await this.client.file(event, bytes, signal) : await this.client.request('/v1/events', event, signal));
        if (response.accepted !== true) throw new HttpError(502, 'Не получено подтверждение события.');
        this.store.setDeliveryState(delivery.id, 'sent');
      } catch (error) {
        const rejected = error instanceof HttpError && [400, 403, 409, 413].includes(error.status);
        this.store.setDeliveryState(delivery.id, rejected ? 'failed' : 'pending', rejected ? 'Узел отклонил событие. Проверьте status на компьютере.' : undefined);
        this.onDiagnostic(error instanceof HttpError ? error.message : 'Передача прервалась. Повторю событие с тем же идентификатором.');
        break;
      }
    }
  }
}
