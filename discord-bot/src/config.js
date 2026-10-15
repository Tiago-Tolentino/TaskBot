import { BotSetupError } from './services/errors.js';

export function readConfig(env = process.env) {
  const token = env.DISCORD_TOKEN?.trim();
  const channelId = env.CHANNEL_ID?.trim();
  const missing = [];

  if (!token) missing.push('DISCORD_TOKEN');
  if (!channelId) missing.push('CHANNEL_ID');
  if (missing.length) {
    throw new BotSetupError(`Preencha ${missing.join(' e ')} no arquivo .env antes de iniciar.`);
  }

  if (!/^[1-9]\d{16,19}$/.test(channelId) || BigInt(channelId) > 18446744073709551615n) {
    throw new BotSetupError('CHANNEL_ID inválido. Copie o ID numérico do canal no Discord.');
  }

  return { token, channelId };
}

export function readNotificationConfig(env = process.env) {
  if (env.TICKET_NOTIFICATIONS_ENABLED !== 'true') return null;
  const channelId = env.TICKET_NOTIFICATION_CHANNEL_ID?.trim();
  const assigneeIds = [...new Set((env.TICKET_NOTIFICATION_ASSIGNEE_IDS || '').split(',').map((id) => id.trim()).filter(Boolean))];
  const intervalSeconds = Number(env.TICKET_NOTIFICATION_INTERVAL_SECONDS || 30);
  if (!channelId || !/^[1-9]\d{16,19}$/.test(channelId)) {
    throw new BotSetupError('Configure TICKET_NOTIFICATION_CHANNEL_ID com o ID do canal de avisos.');
  }
  if (!assigneeIds.length || assigneeIds.some((id) => !/^\d+$/.test(id))) {
    throw new BotSetupError('Configure TICKET_NOTIFICATION_ASSIGNEE_IDS com os IDs confirmados dos responsáveis no ClickUp.');
  }
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 3600) {
    throw new BotSetupError('TICKET_NOTIFICATION_INTERVAL_SECONDS deve ser um inteiro entre 30 e 3600.');
  }
  if (!env.CLICKUP_API_TOKEN?.trim() || !/^\d+$/.test(env.CLICKUP_TICKETS_LIST_ID || '')) {
    throw new BotSetupError('Configure CLICKUP_API_TOKEN e CLICKUP_TICKETS_LIST_ID para ativar os avisos automáticos.');
  }
  let discordUserMap;
  try {
    discordUserMap = JSON.parse(env.TICKET_NOTIFICATION_DISCORD_USER_MAP || '{}');
    if (!discordUserMap || typeof discordUserMap !== 'object' || Array.isArray(discordUserMap)
      || Object.entries(discordUserMap).some(([clickupId, discordId]) => !/^[1-9]\d*$/.test(clickupId)
        || typeof discordId !== 'string' || !/^[1-9]\d{16,19}$/.test(discordId)
        || BigInt(discordId) > 18446744073709551615n)) throw new Error();
  } catch {
    throw new BotSetupError('TICKET_NOTIFICATION_DISCORD_USER_MAP deve ser um objeto JSON com IDs do ClickUp e IDs do Discord entre aspas.');
  }
  return { channelId, assigneeIds, intervalMs: intervalSeconds * 1000, listId: env.CLICKUP_TICKETS_LIST_ID, discordUserMap };
}
