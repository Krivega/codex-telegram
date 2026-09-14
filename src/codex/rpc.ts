import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import { RejectedOperationError, UncertainOperationError } from '../types.ts';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type StdioTransport = { kind: 'stdio'; executable: string; args: string[] };
type UnixWebSocketTransport = { kind: 'unix-websocket'; socketPath: string };
type RpcTransport = StdioTransport | UnixWebSocketTransport;
export class RpcError extends RejectedOperationError {
  code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams | undefined;
  private socket: WebSocket | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private ready: Promise<void> | undefined;
  private transport: RpcTransport;
  private timeoutMs: number;
  onAttention: (method: string) => void = () => {};

  private constructor(transport: RpcTransport, timeoutMs: number) {
    this.transport = transport; this.timeoutMs = timeoutMs;
  }
  static overStdio(executable: string, args: string[], timeoutMs = 15000): CodexRpc {
    return new CodexRpc({ kind: 'stdio', executable, args }, timeoutMs);
  }
  static overUnixSocket(socketPath: string, timeoutMs = 15000): CodexRpc {
    return new CodexRpc({ kind: 'unix-websocket', socketPath }, timeoutMs);
  }
  async connect(): Promise<void> {
    this.ready ??= this.initialize().catch((error) => { this.close(); throw error; });
    return this.ready;
  }
  private async initialize(): Promise<void> {
    if (this.transport.kind === 'stdio') this.openStdio(this.transport);
    else await this.openUnixSocket(this.transport.socketPath);
    await this.request('initialize', {
      clientInfo: { name: 'codex_telegram', title: 'Codex Telegram', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized', params: {} });
  }
  private openStdio(transport: StdioTransport): void {
    const child = spawn(transport.executable, transport.args, { stdio: 'pipe', shell: false, windowsHide: true });
    this.child = child;
    child.on('error', () => { if (this.child === child) this.loseChild(child, 'Не удалось запустить подключение к Codex. Проверьте путь к программе.'); });
    child.on('exit', () => { if (this.child === child) this.loseChild(child, 'Соединение с Codex закрыто. Проверьте адрес общего сервера.'); });
    child.stdin.on('error', () => { if (this.child === child) this.loseChild(child, 'Не удалось передать запрос Codex.'); });
    // Диагностика дочернего процесса не попадает в журнал: там могут быть личные пути и данные.
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => { if (this.child === child) this.receive(line); });
  }
  private openUnixSocket(socketPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket('ws://localhost/rpc', {
        createConnection: () => createConnection({ path: socketPath }),
        handshakeTimeout: this.timeoutMs,
        perMessageDeflate: false,
      });
      this.socket = socket;
      socket.on('message', (data, isBinary) => {
        if (this.socket !== socket) return;
        if (isBinary) { this.loseSocket(socket, 'Codex вернул двоичное сообщение вместо JSON.'); return; }
        this.receive(this.text(data));
      });
      socket.on('error', () => {
        if (this.socket === socket) this.loseSocket(socket, 'Не удалось подключиться к общему серверу Codex.');
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.disconnect('Соединение с Codex закрыто. Проверьте адрес общего сервера.');
      });
      const cleanup = () => {
        socket.off('open', opened);
        socket.off('error', failed);
        socket.off('close', failed);
      };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => {
        cleanup();
        reject(new UncertainOperationError('Не удалось открыть соединение с общим сервером Codex.'));
      };
      socket.once('open', opened);
      socket.once('error', failed);
      socket.once('close', failed);
    });
  }
  private text(data: RawData): string {
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8');
    return data.toString('utf8');
  }
  private receive(line: string): void {
    let message: { id?: number | string; method?: string; result?: unknown; error?: { code: number; message: string } };
    try { message = JSON.parse(line); } catch { this.stopTransport('Codex вернул неверный JSON.'); return; }
    if (message.method && message.id !== undefined) {
      // Вторая программа не принимает решения за владельца и не подтверждает запросы разрешений.
      this.onAttention(message.method);
      try { this.write({ id: message.id, error: { code: -32601, message: 'Use the owning Codex client for this request.' } }); }
      catch { this.stopTransport('Не удалось передать ответ серверу Codex.'); }
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
    const serialized = JSON.stringify(value);
    if (this.child && !this.child.stdin.destroyed) {
      this.child.stdin.write(`${serialized}\n`);
      return;
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new UncertainOperationError('Codex недоступен.');
    socket.send(serialized, (error) => {
      if (error && this.socket === socket) this.loseSocket(socket, 'Не удалось передать запрос Codex.');
    });
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
  private loseChild(child: ChildProcessWithoutNullStreams, message: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    child.kill();
    this.disconnect(message);
  }
  private loseSocket(socket: WebSocket, message: string): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    socket.terminate();
    this.disconnect(message);
  }
  private stopTransport(message: string): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();
    this.disconnect(message);
  }
  close(): void {
    this.stopTransport('Соединение с Codex закрыто.');
  }
}
