import { basename } from 'node:path';

// Элементы интерфейса Codex не действуют в обычном сообщении Telegram.
export function desktopText(text: string): string {
  return text
    .replace(/^\s*-\s*:codex-followup\[[^\n]*$/gm, '')
    .replace(/:codex-file-citation\{path="([^"\n]+)" purpose="(?:source|output)"\}/g, (_match, path: string) => basename(path))
    .replace(/\[([^\]\n]+)\]\((?:<)?\/[^\n)]*(?:>)?\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n').trim();
}
