import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Config } from '../config/config.ts';
import type { DeliveryBody, Job } from '../storage/store.ts';

export function jobDirectory(directory: string, jobId: string): string {
  if (!/^[\w-]+$/.test(jobId)) throw new Error('Неверный идентификатор поручения.');
  return join(directory, 'artifacts', jobId);
}
export async function preparePrompt(directory: string, job: Job): Promise<string> {
  const output = jobDirectory(directory, job.id);
  await mkdir(output, { recursive: true, mode: 0o700 });
  return `${job.text}\n\nСообщение владельца из Telegram. Если для этого поручения создаёшь файлы, сохрани предназначенные для отправки копии в ${JSON.stringify(output)}. После проверки файлов запиши туда manifest.json в формате {"files":[{"path":"result.pdf","name":"Результат.pdf"}]}. Пути в списке должны быть относительными, допускаются PDF, PNG, JPEG и WebP. Регистрируй только результаты этого поручения. Если доступ к каталогу запрещён или нужного инструмента нет, сообщи об этом; не меняй разрешения самостоятельно. Итоговый ответ: кратко опиши сделанное, проверки и оставшиеся ограничения.`;
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}
export function matchesSignature(bytes: Buffer, extension: string): boolean {
  if (extension === '.pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
  if (extension === '.png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === '.jpg' || extension === '.jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (extension === '.webp') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  return false;
}
export async function readArtifact(root: string, path: string, maxBytes: number): Promise<Buffer> {
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path);
  if (!inside(canonicalRoot, canonicalPath)) throw new Error('Файл находится вне каталога результатов поручения.');
  const handle = await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes || info.size === 0) throw new Error('Недопустимый размер или тип файла.');
    const bytes = Buffer.alloc(Number(info.size) + 1);
    let read = 0;
    while (read < bytes.length) {
      const part = await handle.read(bytes, read, bytes.length - read, null);
      if (!part.bytesRead) break;
      read += part.bytesRead;
    }
    if (read !== info.size) throw new Error('Файл изменился во время чтения.');
    const content = bytes.subarray(0, read);
    if (!matchesSignature(content, extname(path).toLowerCase())) throw new Error('Содержимое файла не соответствует разрешённому формату.');
    return content;
  } finally { await handle.close(); }
}
export async function validateArtifactRoot(directory: string, root: string): Promise<void> {
  if (!inside(await realpath(join(directory, 'artifacts')), await realpath(root))) throw new Error('Каталог поручения заменён ссылкой за пределы результатов.');
}
export async function collectArtifacts(directory: string, job: Job, limits: Config['artifacts']): Promise<DeliveryBody[]> {
  const root = jobDirectory(directory, job.id);
  const manifestPath = join(root, 'manifest.json');
  let info;
  try { info = await lstat(manifestPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  await validateArtifactRoot(directory, root);
  if (!info.isFile() || info.size > 16384) throw new Error('Слишком большой или неверный список файлов.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { files?: unknown };
  if (!Array.isArray(manifest.files) || manifest.files.length > limits.maxFiles) throw new Error('Неверное количество файлов.');
  const deliveries: DeliveryBody[] = [];
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || isAbsolute(entry.path)) throw new Error('В списке файлов нужен относительный путь.');
    const filePath = resolve(root, entry.path);
    if (!inside(root, filePath)) throw new Error('Путь выходит за каталог поручения.');
    const content = await readArtifact(root, filePath, limits.maxFileBytes);
    const name = entry.name ?? basename(filePath);
    if (typeof name !== 'string' || name.length > 150 || /[\/\\\x00-\x1f]/.test(name) || extname(name).toLowerCase() !== extname(filePath).toLowerCase()) throw new Error('Недопустимое имя вложения.');
    deliveries.push({ kind: 'file', root, path: filePath, name, sha256: createHash('sha256').update(content).digest('hex') });
  }
  return deliveries;
}
