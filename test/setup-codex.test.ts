import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configureCodexExecutable, findCodexExecutable } from '../src/setup/codex.ts';

async function searchFixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-telegram-discovery-'));
  const options = { platform: 'darwin' as const, searchPath: '', homeDirectory: root, applicationDirectories: [join(root, 'Applications')] };
  async function executable(path: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); return path; }
  return { root, options, executable, cleanup: () => rm(root, { recursive: true, force: true }) };
}
test('пустой PATH: мастер находит Codex внутри приложения, включая путь с пробелами', async (t) => {
  const f = await searchFixture(); t.after(f.cleanup);
  f.options.applicationDirectories = [join(f.root, 'My Applications')];
  const bundled = await f.executable(join(f.options.applicationDirectories[0]!, 'ChatGPT.app', 'Contents', 'Resources', 'codex'));
  assert.equal(await findCodexExecutable(f.options), bundled);
});
test('поиск сохраняет приоритет PATH и пропускает каталоги и неисполняемые файлы', async (t) => {
  const f = await searchFixture(); t.after(f.cleanup);
  const bundled = await f.executable(join(f.root, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'));
  const invalid = join(f.root, 'invalid'); await mkdir(join(invalid, 'codex'), { recursive: true });
  const bin = join(f.root, 'bin'); const cli = await f.executable(join(bin, 'codex'));
  f.options.searchPath = `${invalid}:${bin}`;
  assert.equal(await findCodexExecutable(f.options), cli);
  if (process.platform !== 'win32') {
    await chmod(cli, 0o600);
    assert.equal(await findCodexExecutable(f.options), bundled);
  }
});
test('без PATH используется личная установка, отсутствие CLI явно возвращается вызывающему коду', async (t) => {
  const f = await searchFixture(); t.after(f.cleanup);
  assert.equal(await findCodexExecutable(f.options), undefined);
  const cli = await f.executable(join(f.root, '.local', 'bin', 'codex'));
  assert.equal(await findCodexExecutable(f.options), cli);
});
test('повторная настройка сохраняет выбранный пользователем путь и допускает его явную замену', async () => {
  const current = '/custom/Codex Folder/codex';
  assert.equal(await configureCodexExecutable(async () => '', current), current);
  assert.equal(await configureCodexExecutable(async () => '/other/codex', current), '/other/codex');
});
