import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
let initialized = false;
lines.on('line', (line) => {
  const input = JSON.parse(line);
  const respond = (value) => process.stdout.write(`${JSON.stringify({ id: input.id, ...value })}\n`);
  if (input.method === 'initialize') { initialized = true; respond({ result: { userAgent: 'test' } }); return; }
  if (input.method === 'initialized') return;
  if (!initialized) { respond({ error: { code: -32000, message: 'Not initialized' } }); return; }
  if (input.method === 'thread/list') { respond({ result: { data: [{ id: 'original', cwd: '/tmp', updatedAt: 10, status: { type: 'idle' }, canAcceptDirectInput: true }], nextCursor: null } }); return; }
  if (input.method === 'thread/read') { respond({ result: { thread: { id: input.params.threadId, cwd: '/tmp', updatedAt: 10, status: { type: 'idle' }, canAcceptDirectInput: true } } }); return; }
  if (input.method === 'thread/turns/list') { respond({ result: { data: [], nextCursor: null } }); return; }
  if (input.method === 'thread/queue/add') { respond({ result: { queuedSubmission: { id: 'queued', clientUserMessageId: input.params.clientUserMessageId } } }); return; }
  if (input.method === 'thread/queue/list') { respond({ result: { data: [{ id: 'queued', clientUserMessageId: 'client' }], nextCursor: null } }); return; }
  if (input.method === 'thread/queue/start') { respond({ result: {} }); return; }
  if (input.method === 'hang') return;
  if (input.method === 'exit') { process.exit(0); }
  respond({ error: { code: -32601, message: 'Unsupported method' } });
});
