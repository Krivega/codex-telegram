import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { RejectedOperationError, UncertainOperationError } from '../types.ts';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export class RpcError extends RejectedOperationError {
  code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private ready: Promise<void> | undefined;
  private executable: string;
  private args: string[];
  private timeoutMs: number;
  onAttention: (method: string) => void = () => {};

  constructor(executable: string, args: string[], timeoutMs = 15000) {
    this.executable = executable; this.args = args; this.timeoutMs = timeoutMs;
  }
  async connect(): Promise<void> {
    this.ready ??= this.initialize().catch((error) => { this.close(); throw error; });
    return this.ready;
  }
  private async initialize(): Promise<void> {
    const child = spawn(this.executable, this.args, { stdio: 'pipe', shell: false, windowsHide: true });
    this.child = child;
    child.on('error', () => { if (this.child === child) this.disconnect('Не удалось запустить подключение к Codex. Проверьте путь к программе.'); });
    child.on('exit', () => { if (this.child === child) this.disconnect('Соединение с Codex закрыто. Проверьте адрес общего сервера.'); });
    child.stdin.on('error', () => { if (this.child === child) this.disconnect('Не удалось передать запрос Codex.'); });
    // Диагностика дочернего процесса не попадает в журнал: там могут быть личные пути и данные.
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => { if (this.child === child) this.receive(line); });
    await this.request('initialize', {
      clientInfo: { name: 'codex_telegram', title: 'Codex Telegram', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized' });
  }
  private receive(line: string): void {
    let message: { id?: number | string; method?: string; result?: unknown; error?: { code: number; message: string } };
    try { message = JSON.parse(line); } catch { this.disconnect('Codex вернул неверный JSON.'); return; }
    if (message.method && message.id !== undefined) {
      // Вторая программа не принимает решения за владельца и не подтверждает запросы разрешений.
      this.onAttention(message.method);
      this.write({ id: message.id, error: { code: -32601, message: 'Use the owning Codex client for this request.' } });
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(message.id);
    if (message.error) pending.reject(new RpcError(message.error.code, message.error.message));
    else pending.resolve(message.result);
  }
  private write(value: unknown): void {
    if (!this.child || this.child.stdin.destroyed) throw new UncertainOperationError('Codex недоступен.');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new UncertainOperationError(`Истекло время ожидания ${method}. Результат операции неизвестен.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private disconnect(message: string): void {
    this.ready = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new UncertainOperationError(message));
    }
    this.pending.clear();
  }
  close(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
    this.disconnect('Соединение с Codex закрыто.');
  }
}
