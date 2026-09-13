import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function acquireLock(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, 'service.lock');
  const owner = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(owner); } finally { await file.close(); }
      return async () => {
        if (await readFile(path, 'utf8').catch(() => '') === owner) await unlink(path);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = await readFile(path, 'utf8');
      const pid = Number(previous.split(':')[0]);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Файл service.lock повреждён. Проверьте работающие процессы перед удалением файла.');
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          if (await readFile(path, 'utf8') === previous) await unlink(path);
          continue;
        }
      }
      throw new Error('Служба или настройка уже работает. Остановите её перед запуском второй копии.');
    }
  }
  throw new Error('Не удалось получить блокировку службы.');
}
