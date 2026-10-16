import { createHash } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, escapeMarkdown } from 'discord.js';
import { ClickUpError, getTicket } from '../integrations/clickup.js';
import { attachmentField, prepareTicketAttachments } from './ticketAttachments.js';

const short = (text, limit) => {
  const value = String(text);
  if (value.length <= limit) return value;
  let end = limit - 1;
  if (/[\uD800-\uDBFF]/.test(value[end - 1])) end--;
  return value.slice(0, end) + '…';
};

export function buildTicketNotification(ticket, scope, discordUserMap = {}) {
  const discordUsers = [...new Set(ticket.assignees.map((user) => discordUserMap[user.id]).filter(Boolean))];
  const embed = new EmbedBuilder().setColor(0x5865f2)
    .setTitle(short(ticket.name, 256)).setURL(ticket.url)
    .setDescription(`**Resumo**\n${short(escapeMarkdown(ticket.summary || 'Resumo não informado.'), 3000)}`)
    .addFields(
      { name: 'Status', value: short(escapeMarkdown(ticket.status), 256), inline: true },
      { name: 'Responsáveis', value: short(ticket.assignees.map((user) => escapeMarkdown(user.name)).join(', ') || 'Não atribuído', 1024) },
    ).setFooter({ text: 'Novo ticket • Suporte B2C' });
  const attachments = attachmentField(ticket);
  if (attachments) embed.addFields(attachments);
  return {
    content: '🆕 Novo ticket aberto no ClickUp!' + (discordUsers.length ? '\n' + discordUsers.map((id) => `<@${id}>`).join(' ') : ''),
    embeds: [embed], allowedMentions: { parse: [], ...(discordUsers.length ? { users: discordUsers } : {}) },
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(`ticket:assign:${ticket.id}`).setLabel('Escolher responsável').setStyle(ButtonStyle.Primary))],
    nonce: createHash('sha256').update(`${scope}:${ticket.id}`).digest('hex').slice(0, 24), enforceNonce: true,
  };
}

export async function sendTicketNotification(channel, ticket, scope, discordUserMap = {}, { fetchDetails = getTicket, prepareFiles = prepareTicketAttachments, buildPayload = buildTicketNotification, signal } = {}) {
  // A listagem de recuperação não inclui os anexos; consultar o ticket completo.
  const detailed = Array.isArray(ticket.attachments) ? ticket
    : await fetchDetails({ taskId: ticket.id, listId: scope.split(':')[0], signal }) || ticket;
  const member = channel.guild?.members.me;
  const canAttach = channel.isDMBased?.() === true || Boolean(member && channel.permissionsFor(member)?.has(PermissionFlagsBits.AttachFiles));
  const { files, omitted } = await prepareFiles(detailed, { signal, canAttach });
  if (signal?.aborted) throw new ClickUpError('Envio do aviso cancelado durante o encerramento.');
  const payload = buildPayload(detailed, scope, discordUserMap);
  if (omitted) payload.content += '\n📎 Alguns anexos estão disponíveis pelos links no aviso ou no ticket.';
  try { return await channel.send({ ...payload, files }); }
  catch (error) {
    // Rejeição explícita do upload: entregar o aviso com links em vez de perder o ticket.
    if (!files.length || (!([40005, 50045, 50013].includes(error.code)) && error.status !== 413)) throw error;
    return channel.send({ ...payload, files: [], content: payload.content + '\n📎 Os arquivos não puderam ser enviados; abra os links dos anexos.' });
  }
}
