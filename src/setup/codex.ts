import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

type SearchOptions = {
  platform: NodeJS.Platform;
  searchPath: string;
  homeDirectory: string;
  applicationDirectories: string[];
};
export async function findCodexExecutable(options: SearchOptions = {
  platform: process.platform,
  searchPath: process.env.PATH ?? '',
  homeDirectory: homedir(),
  applicationDirectories: ['/Applications', join(homedir(), 'Applications')],
}): Promise<string | undefined> {
  const name = options.platform === 'win32' ? 'codex.exe' : 'codex';
  const separator = options.platform === 'win32' ? ';' : ':';
  const candidates = options.searchPath.split(separator).filter(isAbsolute).map((directory) => join(directory, name));
  candidates.push(join(options.homeDirectory, '.local', 'bin', name));
  if (options.platform === 'darwin') {
    for (const application of ['ChatGPT.app', 'Codex.app']) {
      candidates.push(...options.applicationDirectories.map((directory) => join(directory, application, 'Contents', 'Resources', 'codex')));
    }
  }
  for (const path of new Set(candidates)) {
    try {
      if (!(await stat(path)).isFile()) continue;
      await access(path, constants.X_OK);
      return path;
    } catch { /* Программа может отсутствовать или быть недоступна для запуска. */ }
  }
  return undefined;
}
export async function configureCodexExecutable(ask: (prompt: string) => Promise<string>, current: string): Promise<string> {
  const selected = current === 'codex' ? await findCodexExecutable() : current;
  const entered = (await ask(selected ? `Программа Codex [${selected}]: ` : 'Codex не найден автоматически. Укажите абсолютный путь к программе: ')).trim();
  if (entered) return entered;
  if (selected) return selected;
  throw new Error('Codex CLI не найден. Установите его по официальной инструкции https://learn.chatgpt.com/docs/codex/cli и повторите setup, либо укажите путь к уже установленной программе.');
}
