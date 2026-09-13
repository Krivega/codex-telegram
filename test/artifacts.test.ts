import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectArtifacts, jobDirectory, preparePrompt } from '../src/artifacts/artifacts.ts';
import type { Job } from '../src/storage/store.ts';

const job: Job = { id: 'job', threadId: 'thread', chatId: 42, messageId: 1, clientId: 'client', text: 'Сделай PDF', state: 'pending' };
const limits = { maxFileBytes: 1024, maxFiles: 2 };
async function prepare() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-telegram-files-'));
  await preparePrompt(directory, job);
  return { directory, root: jobDirectory(directory, job.id), cleanup: () => rm(directory, { recursive: true, force: true }) };
}
test('произвольный путь и символическая ссылка не отправляются как результат', async (t) => {
  const f = await prepare(); t.after(f.cleanup);
  await writeFile(join(f.directory, 'private.pdf'), '%PDF-secret');
  const manifest = (path: string) => writeFile(join(f.root, 'manifest.json'), JSON.stringify({ files: [{ path }] }));
  await manifest('../../private.pdf'); await assert.rejects(collectArtifacts(f.directory, job, limits), /за каталог/);
  await symlink(join(f.directory, 'private.pdf'), join(f.root, 'link.pdf'));
  await manifest('link.pdf'); await assert.rejects(collectArtifacts(f.directory, job, limits), /вне каталога/);
});
test('подмена формата, большой файл и ссылка вместо списка файлов отклоняются', async (t) => {
  const f = await prepare(); t.after(f.cleanup);
  await writeFile(join(f.root, 'result.pdf'), 'not a PDF');
  await writeFile(join(f.root, 'manifest.json'), JSON.stringify({ files: [{ path: 'result.pdf' }] }));
  await assert.rejects(collectArtifacts(f.directory, job, limits), /формату/);
  await writeFile(join(f.root, 'result.pdf'), `%PDF-${'x'.repeat(2000)}`);
  await assert.rejects(collectArtifacts(f.directory, job, limits), /размер/);
  await rm(join(f.root, 'manifest.json'));
  await writeFile(join(f.directory, 'manifest.json'), '{"files":[]}');
  await symlink(join(f.directory, 'manifest.json'), join(f.root, 'manifest.json'));
  await assert.rejects(collectArtifacts(f.directory, job, limits), /неверный список/);
});
test('замена каталога поручения внешней ссылкой отклоняется', async (t) => {
  const f = await prepare(); t.after(f.cleanup);
  const external = join(f.directory, 'external'); await mkdir(external);
  await writeFile(join(external, 'manifest.json'), '{"files":[]}');
  await rm(f.root, { recursive: true }); await symlink(external, f.root);
  await assert.rejects(collectArtifacts(f.directory, job, limits), /за пределы/);
});
