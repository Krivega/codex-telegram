import { serverUrl } from './config.ts';
import { HttpError } from './protocol.ts';

export class HubClient {
  private url: string;
  private token: string;
  constructor(url: string, token: string) { this.url = serverUrl(url); this.token = token; }
  async request(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.send(path, JSON.stringify(body), { 'content-type': 'application/json' }, signal);
  }
  async file(metadata: unknown, bytes: Buffer, signal?: AbortSignal): Promise<unknown> {
    return this.send('/v1/files', new Uint8Array(bytes), { 'content-type': 'application/octet-stream', 'x-codex-event': Buffer.from(JSON.stringify(metadata)).toString('base64url') }, signal);
  }
  private async send(path: string, body: string | Uint8Array<ArrayBuffer>, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(40000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response | undefined;
    // После перезапуска сервера сохранённое HTTP-соединение может оборваться.
    // Все операции протокола допускают повтор с тем же кодом, ключом события или ревизией.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(`${this.url}${path}`, { method: 'POST', body, headers: { ...headers, authorization: `Bearer ${this.token}` }, redirect: 'error', signal: combined });
        break;
      } catch { if (combined.aborted) break; }
    }
    if (!response) throw new HttpError(503, 'Нет связи с единым узлом. Очередь сохранена. Проверьте адрес, сертификат и доступность сервера.');
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status, response.status === 401 ? 'Ключ не принят. Проверьте подключение и отзыв ключа на едином узле.' : `Единый узел отклонил запрос (${response.status}).`);
    }
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body!) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new HttpError(502, 'Ответ узла слишком большой.');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(502, 'Единый узел прислал неверный ответ.'); }
  }
}
