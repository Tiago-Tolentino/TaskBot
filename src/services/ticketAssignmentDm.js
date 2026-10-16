import { createHash } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { buildTicketNotification, sendTicketNotification } from './ticketMessages.js';

export function buildAssignmentDm(ticket, scope, discordId, assignmentId) {
  const payload = buildTicketNotification(ticket, scope);
  return {
    ...payload,
    content: '📬 Você foi adicionado como responsável neste ticket do ClickUp.',
    embeds: [payload.embeds[0].setFooter({ text: 'Ticket atribuído • Suporte B2C' })],
    // A atribuição continua no servidor; no privado, oferecer acesso ao ticket.
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setStyle(ButtonStyle.Link).setLabel('Abrir ticket no ClickUp').setURL(ticket.url))],
    allowedMentions: { parse: [] },
    nonce: createHash('sha256').update(`assignment-dm:${scope}:${ticket.id}:${discordId}:${assignmentId}`).digest('hex').slice(0, 24),
  };
}

export async function notifyTicketAssignee({ client, ticket, assigneeId, config, assignmentId, signal }, { deliver = sendTicketNotification } = {}) {
  if (!config.assignmentDmEnabled) return { status: 'disabled' };
  const discordId = config.discordUserMap?.[assigneeId];
  if (!discordId) return { status: 'unmapped' };
  if (!ticket.assignees.some((user) => user.id === assigneeId)) return { status: 'not-assigned' };
  try {
    const user = await client.users.fetch(discordId);
    const channel = await user.createDM();
    const message = await deliver(channel, ticket, `${config.listId}:${config.channelId}`, {}, {
      signal, buildPayload: (value, scope) => buildAssignmentDm(value, scope, discordId, assignmentId),
    });
    console.log(`[INFO] Aviso privado de atribuição enviado. ID da mensagem: ${message.id}`);
    return { status: 'sent', messageId: message.id };
  } catch (error) {
    // Não registrar o objeto de erro externo, que pode conter dados do ticket.
    console.error('[ERRO] Não foi possível entregar o aviso privado de atribuição; a atribuição no ClickUp foi preservada.');
    return { status: error?.code === 50007 ? 'blocked' : 'failed' };
  }
}

// Apenas responsáveis com vínculo explícito recebem o complemento ao aviso público.
export async function notifyNewTicketAssignees({ client, ticket, config, signal }, { notify = notifyTicketAssignee } = {}) {
  if (!config.assignmentDmEnabled) return;
  const assigneeIds = [...new Set(ticket.assignees.map((user) => user.id))];
  for (const assigneeId of assigneeIds) {
    if (signal?.aborted) return;
    if (!config.discordUserMap?.[assigneeId]) continue;
    await notify({ client, ticket, assigneeId, config, signal, assignmentId: `created:${ticket.id}` });
  }
}

export function assignmentDmFeedback(result) {
  switch (result?.status) {
    case 'sent': return '\n📩 Mensagem privada enviada ao responsável.';
    case 'unmapped': return '\nℹ️ Este responsável ainda não tem um usuário do Discord vinculado para receber o aviso privado.';
    case 'blocked': return '\n⚠️ O Discord não permitiu enviar a mensagem privada. O responsável pode precisar habilitar mensagens diretas para este servidor. A atribuição foi mantida.';
    case 'failed':
    case 'not-assigned': return '\n⚠️ Não foi possível entregar a mensagem privada. A atribuição foi mantida; as informações continuam no aviso do canal.';
    default: return '';
  }
}
