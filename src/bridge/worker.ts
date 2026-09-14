import type { Config } from '../config/config.ts';
import type { CodexPort, Thread, Turn } from '../types.ts';
import { CodexUnavailableError, RejectedOperationError } from '../types.ts';
import { Store } from '../storage/store.ts';
import type { Job } from '../storage/store.ts';
import { collectArtifacts, preparePrompt } from '../artifacts/artifacts.ts';
import { finalText, textParts } from './messages.ts';

export type WorkerSettings = Pick<Config, 'codex' | 'notifications' | 'artifacts'> & { chatId: number };
export type TaskSummary = { id: string; name: string; status: string };
export class CodexWorker {
  protected config: WorkerSettings;
  protected directory: string;
  protected store: Store;
  protected codex: CodexPort;
  private observed = new Map<string, string>();
  inventory: TaskSummary[] = [];
  onDiagnostic: (message: string) => void = () => {};
  constructor(config: WorkerSettings, directory: string, store: Store, codex: CodexPort) {
    this.config = config; this.directory = directory; this.store = store; this.codex = codex;
    if (codex.onDiagnostic) codex.onDiagnostic = (message) => this.onDiagnostic(message);
    store.recoverJobs();
    if (!store.getMeta('enabledAt')) store.setMeta('enabledAt', String(Date.now() / 1000));
  }
  protected permits(threadId: string): boolean {
    return (this.config.codex.threadIds.length === 0 || this.config.codex.threadIds.includes(threadId)) && (this.codex.permitsThread?.(threadId) ?? true);
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
    this.inventory = threads.map(({ id, name, preview, status }) => ({ id, name: (name ?? preview ?? id).slice(0, 180), status: status.type }));
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
          this.store.enqueue(`attention:${thread.id}:${activeTurn?.id ?? thread.updatedAt}:${flags.join(',')}`, this.config.chatId,
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
      this.store.enqueue(key, this.config.chatId, { kind: 'text', fullText: full, text: `${label}: ${(thread.name ?? thread.preview ?? thread.id).slice(0, 180)}\n\n${summary}` }, route, job?.messageId);
      files.forEach((body, index) => this.store.enqueue(`${key}:file:${index}`, this.config.chatId, body, route, job?.messageId));
      if (artifactError) this.store.enqueue(`${key}:file-error`, this.config.chatId,
        { kind: 'text', text: 'Список вложений не прошёл проверку. Попросите Codex проверить manifest.json, формат и размер файлов в каталоге поручения.' }, route, job?.messageId);
      if (job) this.store.saveJob({ ...job, state: 'done' });
      this.store.markTurn(thread.id, turn.id);
    });
  }
}
