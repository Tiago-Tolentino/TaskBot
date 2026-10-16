import { randomBytes } from 'node:crypto';
import { ActionRowBuilder, MessageFlags, StringSelectMenuBuilder, escapeMarkdown } from 'discord.js';
import { addTicketAssignee, ClickUpError } from '../integrations/clickup.js';
import { getTicketFilters } from './ticketFilters.js';
import { buildTicketNotification } from './ticketNotifications.js';
import { readNotificationConfig } from '../config.js';

const OPEN = 'ticket:assign:';
const SELECT = 'ticket:assignee:';
const TTL = 10 * 60_000;
const NO_MENTIONS = { parse: [] };

export const isTicketAssignment = (interaction) => (interaction.isButton?.() && interaction.customId?.startsWith(OPEN))
  || (interaction.isStringSelectMenu?.() && interaction.customId?.startsWith(SELECT));

function picker(session, id) {
  if (session.users.length > 125) throw new ClickUpError('Não foi possível exibir todos os responsáveis nesta mensagem.');
  const components = [];
  for (let start = 0; start < session.users.length; start += 25) {
    const users = session.users.slice(start, start + 25);
    const select = new StringSelectMenuBuilder().setCustomId(`${SELECT}${id}:${start / 25}`)
      .setPlaceholder(`Escolher responsável (${start + 1}–${start + users.length} de ${session.users.length})`)
      .setMinValues(1).setMaxValues(1)
      .addOptions(users.map((user) => ({ label: [...user.name].slice(0, 100).join(''), value: user.id, description: `ID ClickUp: ${user.id}` })));
    components.push(new ActionRowBuilder().addComponents(select));
  }
  return { content: `**Escolher responsável**\nTodos os ${session.users.length} responsáveis estão nesta mensagem. Selecione uma pessoa em qualquer um dos menus abaixo para adicioná-la ao ticket, preservando os responsáveis atuais.\nEsta seleção expira em 10 minutos.`, components, allowedMentions: NO_MENTIONS };
}

export function createTicketAssignmentHandler({ loadUsers = async () => (await getTicketFilters()).users, assign = addTicketAssignee, getConfig = readNotificationConfig, now = Date.now } = {}) {
  const sessions = new Map();
  const locks = new Map();
  async function serialized(taskId, operation) {
    const previous = locks.get(taskId) || Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    locks.set(taskId, pending);
    try { return await pending; } finally { if (locks.get(taskId) === pending) locks.delete(taskId); }
  }

  return async function handleAssignment(interaction) {
    if (!isTicketAssignment(interaction)) return false;
    const privateReply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
    try {
      const config = getConfig();
      if (!config || !interaction.guildId || interaction.channelId !== config.channelId) {
        await privateReply('Use o botão de um aviso no canal de tickets configurado.'); return true;
      }
      for (const [id, session] of sessions) if (now() - session.createdAt >= TTL) sessions.delete(id);
      if (interaction.customId.startsWith(OPEN)) {
        const taskId = interaction.customId.slice(OPEN.length);
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(taskId) || interaction.message?.author?.id !== interaction.client.user.id) {
          await privateReply('Este aviso não é válido para atribuir responsáveis.'); return true;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const allowed = new Set(config.assignmentAssigneeIds || []);
        const users = (await loadUsers()).filter((user) => allowed.has(user.id))
          .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
        if (!users.length) { await interaction.editReply({ content: 'Nenhum responsável autorizado está disponível para atribuição.', allowedMentions: NO_MENTIONS }); return true; }
        if (sessions.size >= 1000) { await interaction.editReply({ content: 'Há muitas seleções abertas. Tente novamente em alguns minutos.', allowedMentions: NO_MENTIONS }); return true; }
        const id = randomBytes(12).toString('hex');
        const session = { taskId, users, userId: interaction.user.id, guildId: interaction.guildId, channelId: interaction.channelId, message: interaction.message, createdAt: now(), busy: false };
        sessions.set(id, session);
        await interaction.editReply(picker(session, id));
        return true;
      }
      const [id, group] = interaction.customId.slice(SELECT.length).split(':');
      const session = sessions.get(id);
      if (!session || session.userId !== interaction.user.id || session.guildId !== interaction.guildId || session.channelId !== interaction.channelId) {
        await privateReply('Esta seleção expirou ou pertence a outra pessoa. Clique em Escolher responsável no aviso novamente.'); return true;
      }
      if (session.busy) { await privateReply('A atribuição já está sendo processada. Aguarde a confirmação.'); return true; }
      const userId = interaction.values?.length === 1 ? interaction.values[0] : undefined;
      const users = /^\d+$/.test(group || '') ? session.users.slice(Number(group) * 25, (Number(group) + 1) * 25) : [];
      const user = users.find((candidate) => candidate.id === userId);
      if (!user || !config.assignmentAssigneeIds?.includes(userId)) { await privateReply('Selecione um responsável autorizado no menu.'); return true; }
      session.busy = true;
      await interaction.deferUpdate();
      try {
        await serialized(session.taskId, async () => {
          const currentUsers = await loadUsers();
          if (!currentUsers.some((candidate) => candidate.id === userId)) throw new ClickUpError('Este usuário não está mais disponível no ClickUp. Abra a seleção novamente.');
          const result = await assign({ taskId: session.taskId, assigneeId: userId, listId: config.listId });
          const payload = buildTicketNotification(result.ticket, `${config.listId}:${config.channelId}`, config.discordUserMap);
          let refreshed = true;
          try {
            // Não reenviar arquivos nem repetir pings ao atualizar a mensagem existente.
            await session.message.edit({ content: payload.content, embeds: payload.embeds, components: payload.components, allowedMentions: NO_MENTIONS });
          } catch { refreshed = false; }
          sessions.delete(id);
          await interaction.editReply({ content: `✅ ${escapeMarkdown(user.name)} ${result.alreadyAssigned ? 'já estava como responsável' : 'foi adicionado como responsável'} no ticket do ClickUp.`
            + (refreshed ? '\nO aviso foi atualizado.' : '\nA atribuição foi confirmada, mas não foi possível atualizar o aviso no Discord.'), components: [], allowedMentions: NO_MENTIONS });
        });
      } finally { session.busy = false; }
    } catch (error) {
      const content = error instanceof ClickUpError ? error.message : 'Não foi possível concluir a escolha do responsável. Tente novamente pelo botão do aviso.';
      console.error('[ERRO] Não foi possível concluir a interação de responsável.');
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content, components: [], allowedMentions: NO_MENTIONS });
        else await privateReply(content);
      } catch { /* A interação pode ter expirado; não registrar dados externos. */ }
    }
    return true;
  };
}

export const handleTicketAssignment = createTicketAssignmentHandler();
