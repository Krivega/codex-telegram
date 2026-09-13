import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults, loadConfig, saveConfig, validateConfig } from '../src/config/config.ts';
import { servicePlist } from '../src/setup/service.ts';

test('секрет хранится отдельно с ограниченными правами и не попадает в настройки', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-telegram-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = defaults(); config.telegram = { userId: 42, chatId: 42, botId: 123, initialOffset: 0 };
  const token = '123:EXAMPLE_NON_SECRET_TOKEN_0123456789';
  await saveConfig(directory, config, token);
  assert.equal((await loadConfig(directory)).token, token);
  assert.ok(!(await readFile(join(directory, 'config.json'), 'utf8')).includes(token));
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'secrets.json'))).mode & 0o777, 0o600);
});
test('неверные настройки не принимаются', () => {
  assert.throws(() => validateConfig(defaults()), /telegram.userId/);
  const config = defaults(); config.telegram = { userId: 42, chatId: 42, botId: 123, initialOffset: 0 };
  assert.throws(() => validateConfig({ ...config, codex: { ...config.codex, socketPath: 'relative.sock' } }), /абсолютным/);
  assert.throws(() => validateConfig({ ...config, codex: { ...config.codex, pollIntervalMs: 0 } }), /pollIntervalMs/);
});
test('системные пути корректно экранируются в настройках автоматического запуска', () => {
  const plist = servicePlist('/tmp/Codex & Files', '/Applications/Codex.app/Contents/Resources/codex');
  assert.ok(plist.includes('/tmp/Codex &amp; Files'));
  assert.ok(plist.includes('bin/codex-telegram.mjs'));
  assert.ok(!plist.includes('telegramBotToken'));
});
test('секрет, случайно добавленный в конфигурацию, отклоняется без вывода значения', () => {
  const config = defaults(); config.telegram = { userId: 42, chatId: 42, botId: 123, initialOffset: 0 };
  assert.throws(() => validateConfig({ ...config, telegramBotToken: 'PRIVATE_VALUE' }),
    (error) => error instanceof Error && error.message.includes('секреты') && !error.message.includes('PRIVATE_VALUE'));
});
