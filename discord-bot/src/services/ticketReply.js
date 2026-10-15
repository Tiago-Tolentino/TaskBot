import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags, escapeMarkdown } from 'discord.js';

const line = (value) => escapeMarkdown(String(value).replace(/[\r\n\t]+/g, ' '));

export function buildTicketPages(tickets, filters = {}) {
  let header = `**Tickets — Suporte B2C**\nTotal: **${tickets.length}**`;
  if (filters.status) header += `\nStatus: ${line(filters.status)}`;
  if (filters.assigneeName) header += `\nResponsável: ${line(filters.assigneeName)}`;
  header += '\n\n';
  const allowedMentions = { parse: [] };
  if (!tickets.length) return [{ content: header + 'Nenhum ticket encontrado para esta pesquisa.', allowedMentions }];

  // Reserva espaço para cabeçalho e numeração; preserva todo o resumo.
  const limit = 2000 - header.length - 60;
  const bodies = [];
  for (const ticket of tickets) {
    let text = `**${line(ticket.name)}**\nStatus: ${line(ticket.status)}\nResponsáveis: ${ticket.assignees?.length ? ticket.assignees.map((user) => line(user.name)).join(', ') : 'Não atribuído'}\n<${ticket.url}>\n\n**Resumo**\n${escapeMarkdown(ticket.summary || 'Resumo não informado.')}`;
    while (text.length) {
      let end = Math.min(limit, text.length);
      if (end < text.length) {
        const newline = text.lastIndexOf('\n', end);
        if (newline > limit / 2) end = newline + 1;
        // Não separar pares UTF-16 nem a barra de escape do Markdown.
        if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        let slashes = 0;
        for (let i = end - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
        if (slashes % 2) end--;
      }
      bodies.push(text.slice(0, end));
      text = text.slice(end);
    }
  }
  return bodies.map((body, index) => ({
    content: `${header}${body}\n\nPágina ${index + 1}/${bodies.length}`,
    allowedMentions,
  }));
}

function navigation(index, total) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:previous').setLabel('Anterior').setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
    new ButtonBuilder().setCustomId('ticket:next').setLabel('Próximo').setStyle(ButtonStyle.Primary).setDisabled(index === total - 1),
  )];
}

export async function sendTicketReply(interaction, tickets, filters) {
  const pages = buildTicketPages(tickets, filters);
  const payload = (index) => ({ ...pages[index], components: pages.length > 1 ? navigation(index, pages.length) : [] });
  const message = await interaction.editReply(payload(0));
  if (pages.length === 1) return;

  let index = 0;
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button, time: 10 * 60_000,
    filter: (button) => ['ticket:previous', 'ticket:next'].includes(button.customId),
  });
  collector.on('collect', async (button) => {
    try {
      if (button.user.id !== interaction.user.id) {
        await button.reply({ content: 'Execute /ticket para navegar na sua própria pesquisa.', flags: MessageFlags.Ephemeral });
        return;
      }
      index = Math.max(0, Math.min(pages.length - 1, index + (button.customId === 'ticket:next' ? 1 : -1)));
      await button.update(payload(index));
    } catch {
      console.error('[ERRO] Não foi possível atualizar a página de tickets. Execute /ticket novamente.');
    }
  });
  collector.on('end', () => {
    void message.edit({ components: [] }).catch(() => {});
  });
}
