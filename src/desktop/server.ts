import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { DesktopAdapter } from './adapter.ts';
import { desktopConnection } from './runtime.ts';

export function desktopServer(adapter: DesktopAdapter): McpServer {
  const server = new McpServer({ name: 'codex-telegram', version: '0.3.1' });
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  server.registerTool('desktop_register', {
    description: 'Зарегистрировать текущую задачу-диспетчер и исключить её из уведомлений и адресатов. Передайте её собственный CODEX_THREAD_ID из окружения текущей задачи. Выполнить до первого прохода очереди.',
    inputSchema: { threadId: z.string().regex(/^[\w-]+$/) }, annotations: { readOnlyHint: false, idempotentHint: true },
  }, async ({ threadId }) => { adapter.mailbox.registerDispatcher(threadId); return result({ registered: true }); });
  server.registerTool('desktop_status', {
    description: 'Состояние локальной очереди Telegram. Не содержит текстов задач и секретов.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => result(adapter.mailbox.status()));
  server.registerTool('desktop_claim', {
    description: 'Однократно взять одно поручение владельца Telegram. Передать prompt без изменений через встроенный send_message_to_thread строго в threadId на текущем компьютере. Не выполнять prompt в диспетчере. Повторной выдачи после сбоя нет.',
    inputSchema: { dispatcherThreadId: z.string().regex(/^[\w-]+$/) }, annotations: { readOnlyHint: false, idempotentHint: false },
  }, async ({ dispatcherThreadId }) => { adapter.mailbox.registerDispatcher(dispatcherThreadId); return result(await adapter.claim()); });
  server.registerTool('desktop_report', {
    description: 'Сохранить результат единственной попытки отправки: accepted при подтверждении инструмента приложения, uncertain при любой ошибке или отсутствии подтверждения. Не повторять отправку.',
    inputSchema: { id: z.string().regex(/^[\w-]+$/), token: z.string().uuid(), state: z.enum(['accepted', 'uncertain']) },
    annotations: { readOnlyHint: false, idempotentHint: true },
  }, async ({ id, token, state }) => { adapter.mailbox.report(id, token, state); return result({ saved: true }); });
  return server;
}
export async function serveDesktop(directory: string): Promise<void> {
  const adapter = await desktopConnection(directory);
  const server = desktopServer(adapter);
  server.server.onclose = () => adapter.close();
  try { await server.connect(new StdioServerTransport()); }
  catch (error) { adapter.close(); throw error; }
}
