import type { TelegramPort, TelegramUpdate } from '../types.ts';
import { RejectedOperationError, UncertainOperationError } from '../types.ts';

export class TelegramClient implements TelegramPort {
  private baseUrl: string;
  private fetcher: typeof fetch;
  constructor(token: string, fetcher: typeof fetch = fetch) {
    this.baseUrl = `https://api.telegram.org/bot${token}/`; this.fetcher = fetcher;
  }
  async call<T>(method: string, params: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<T> {
    const form = params instanceof FormData;
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${method}`, {
        method: 'POST', headers: form ? undefined : { 'content-type': 'application/json' },
        body: form ? params : JSON.stringify(params),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000),
      });
    } catch { throw new UncertainOperationError(`Нет подтверждения Telegram для ${method}.`); }
    let payload: { ok: boolean; result: T; error_code?: number; parameters?: { retry_after?: number } };
    try { payload = await response.json() as typeof payload; }
    catch { throw new UncertainOperationError(`Telegram вернул нечитаемый ответ для ${method}.`); }
    if (payload.ok !== true) {
      if ((payload.error_code ?? response.status) >= 500) throw new UncertainOperationError(`Telegram временно недоступен (${method}).`);
      throw new RejectedOperationError(`Telegram отклонил ${method}, код ${payload.error_code ?? response.status}.`, payload.parameters?.retry_after);
    }
    return payload.result;
  }
  getMe(): Promise<{ id: number; username: string }> { return this.call('getMe', {}); }
  getWebhookInfo(): Promise<{ url: string }> { return this.call('getWebhookInfo', {}); }
  getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, signal);
  }
  async sendText(chatId: number, text: string, replyTo?: number): Promise<number> {
    const result = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId, text,
      link_preview_options: { is_disabled: true },
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
    return result.message_id;
  }
  async sendDocument(chatId: number, file: Buffer, name: string, replyTo?: number): Promise<number> {
    const data = new FormData();
    data.set('chat_id', String(chatId));
    data.set('document', new Blob([new Uint8Array(file)]), name);
    if (replyTo) data.set('reply_parameters', JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
    return (await this.call<{ message_id: number }>('sendDocument', data)).message_id;
  }
}
