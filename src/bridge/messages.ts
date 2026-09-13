import type { Turn } from '../types.ts';

export function finalText(turn: Turn): string {
  const messages = turn.items.filter((item) => item.type === 'agentMessage');
  const finals = messages.filter((item) => item.phase === 'final_answer');
  return (finals.length ? finals : messages).at(-1)?.text?.trim() || turn.error?.message || 'Текст итогового ответа отсутствует.';
}
export function textParts(text: string, size = 3800): string[] {
  const parts: string[] = [];
  let part = '';
  for (const character of text) {
    if (part.length + character.length > size) { parts.push(part); part = ''; }
    part += character;
  }
  if (part) parts.push(part);
  return parts.length ? parts : ['Нет текста.'];
}
