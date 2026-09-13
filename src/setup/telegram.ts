import { randomBytes } from 'node:crypto';
import type { Config } from '../config/config.ts';
import { TelegramClient } from '../telegram/client.ts';

type Binding = { telegram: Config['telegram']; token: string };
export async function configureTelegram(hidden: (prompt: string) => Promise<string>, existing?: Binding): Promise<Binding> {
  console.log('Создайте отдельного бота через @BotFather. Токен вводится скрыто.');
  const token = await hidden(existing ? 'Токен бота [Enter — сохранить]: ' : 'Токен бота: ') || existing?.token || process.env.TELEGRAM_BOT_TOKEN || '';
  if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error('Неверный формат токена.');
  const client = new TelegramClient(token); const me = await client.getMe();
  if ((await client.getWebhookInfo()).url) throw new Error('У бота уже включён webhook. Используйте отдельного бота или отключите прежнюю интеграцию.');
  if (existing && me.id !== existing.telegram.botId) throw new Error('Для другого бота нужен отдельный каталог настроек.');
  console.log(`Бот проверен: @${me.username}`);
  if (existing) return { telegram: existing.telegram, token };
  const code = randomBytes(16).toString('hex');
  console.log(`Откройте https://t.me/${me.username}?start=${code} и нажмите «Запустить». Ожидаю привязку владельца до двух минут.`);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 120000);
  let offset = 0;
  try {
    while (!controller.signal.aborted) {
      for (const update of await client.getUpdates(offset, controller.signal)) {
        offset = Math.max(offset, update.update_id + 1);
        const message = update.message;
        if (message?.text === `/start ${code}` && message.chat.type === 'private' && message.from && !message.from.is_bot && message.from.id === message.chat.id) {
          return { token, telegram: { userId: message.from.id, chatId: message.chat.id, botId: me.id, initialOffset: offset } };
        }
      }
    }
    throw new Error('Владелец не подтвердил привязку. Повторите setup.');
  } finally { clearTimeout(timer); }
}
