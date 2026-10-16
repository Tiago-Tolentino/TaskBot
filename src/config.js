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
  const intervalSeconds = Number(env.TICKET_NOTIFICATION_INTERVAL_SECONDS || 600);
  if (!channelId || !/^[1-9]\d{16,19}$/.test(channelId)) {
    throw new BotSetupError('Configure TICKET_NOTIFICATION_CHANNEL_ID com o ID do canal de avisos.');
  }
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 3600) {
    throw new BotSetupError('TICKET_NOTIFICATION_INTERVAL_SECONDS deve ser um inteiro entre 30 e 3600.');
  }
  if (!env.CLICKUP_API_TOKEN?.trim() || !/^\d+$/.test(env.CLICKUP_TICKETS_LIST_ID || '')) {
    throw new BotSetupError('Configure CLICKUP_API_TOKEN e CLICKUP_TICKETS_LIST_ID para ativar os avisos automáticos.');
  }
  const rawAssignmentIds = env.TICKET_ASSIGNMENT_ASSIGNEE_IDS?.trim();
  const assignmentAssigneeIds = [...new Set(rawAssignmentIds ? rawAssignmentIds.split(',').map((id) => id.trim()) : [])];
  if (assignmentAssigneeIds.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new BotSetupError('TICKET_ASSIGNMENT_ASSIGNEE_IDS deve conter IDs válidos do ClickUp separados por vírgula.');
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
  return { channelId, intervalMs: intervalSeconds * 1000, listId: env.CLICKUP_TICKETS_LIST_ID, discordUserMap, assignmentAssigneeIds,
    assignmentDmEnabled: env.TICKET_ASSIGNMENT_DM_ENABLED === 'true' };
}


export function readWebhookConfig(env = process.env) {
  if (env.CLICKUP_WEBHOOK_ENABLED !== 'true') return null;
  if (env.TICKET_NOTIFICATIONS_ENABLED !== 'true') throw new BotSetupError('Ative TICKET_NOTIFICATIONS_ENABLED para usar o webhook.');
  if (!/^\d+$/.test(env.CLICKUP_WORKSPACE_ID || '')) throw new BotSetupError('Configure CLICKUP_WORKSPACE_ID para registrar o webhook.');
  const port = Number(env.CLICKUP_WEBHOOK_PORT || 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new BotSetupError('CLICKUP_WEBHOOK_PORT deve ser um inteiro entre 1024 e 65535.');
  return { port, workspaceId: env.CLICKUP_WORKSPACE_ID, binary: env.CLOUDFLARED_PATH?.trim() || undefined };
}
