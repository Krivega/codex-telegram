import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
export function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
function serviceInfo(directory: string): { label: string; path: string } {
  const label = `local.codex-telegram.${createHash('sha256').update(directory).digest('hex').slice(0, 12)}`;
  return { label, path: join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`) };
}
export function servicePlist(directory: string, executable: string): string {
  const { label } = serviceInfo(directory);
  const entry = fileURLToPath(new URL('../../bin/codex-telegram.mjs', import.meta.url));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(entry)}</string><string>start</string><string>--home</string><string>${xml(directory)}</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml([dirname(executable), dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'))}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(join(directory, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(directory, 'service-error.log'))}</string>
</dict></plist>\n`;
}
export async function installService(directory: string, executable: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Автоматическая установка службы пока проверяется только на macOS. Используйте команду start.');
  if (!executable.startsWith('/')) throw new Error('Для автоматического запуска укажите в настройках абсолютный путь codex.executable. Его показывает command -v codex.');
  const { path, label } = serviceInfo(directory);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, servicePlist(directory, executable), { mode: 0o600 });
  for (const name of ['service.log', 'service-error.log']) await writeFile(join(directory, name), '', { flag: 'a', mode: 0o600 });
  await execute('launchctl', ['bootout', `gui/${process.getuid!()}/${label}`]).catch(() => {});
  await execute('launchctl', ['bootstrap', `gui/${process.getuid!()}`, path]);
  console.log('Автоматический запуск установлен для текущего пользователя.');
}
export async function uninstallService(directory: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Эта команда предназначена для macOS.');
  const { path, label } = serviceInfo(directory);
  await execute('launchctl', ['bootout', `gui/${process.getuid!()}/${label}`]).catch(() => {});
  await unlink(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  console.log('Автоматический запуск удалён. Настройки и история доставки сохранены.');
}
