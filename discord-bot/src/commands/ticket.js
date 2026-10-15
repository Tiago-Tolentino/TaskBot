import { SlashCommandBuilder } from 'discord.js';
import { getAllTickets } from '../integrations/clickup.js';
import { sendTicketReply } from '../services/ticketReply.js';
import { buildFilterSuggestions, getTicketFilters, resolveTicketFilters } from '../services/ticketFilters.js';

export const data = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Pesquisa tickets do Suporte B2C por status e responsável.')
  .addStringOption((option) => option.setName('status').setDescription('Filtrar pelo status do ClickUp.').setAutocomplete(true))
  .addStringOption((option) => option.setName('responsavel').setDescription('Filtrar pelo usuário atribuído no ClickUp.').setAutocomplete(true));

export const helpText = [
  'Consulta os tickets da lista **Tickets**, no space **Suporte B2C** do ClickUp.',
  'Mostra título, status, responsáveis, resumo e link em páginas com botões Anterior/Próximo.',
  '**Filtros opcionais:** `status` e `responsavel`. Podem ser usados juntos.',
  '• `/ticket` — todos os tickets.',
  '• `/ticket status:validando` — apenas tickets nesse status.',
  '• `/ticket responsavel:Tiago` — tickets atribuídos ao usuário selecionado.',
  '• `/ticket status:validando responsavel:Tiago` — combina os dois filtros.',
  'Ao digitar, selecione o status e o usuário nas sugestões do ClickUp. Os botões de navegação ficam ativos por 10 minutos.',
].join('\n');

export async function execute(interaction) {
  await interaction.deferReply();
  const hasFilters = interaction.options?.getString('status') || interaction.options?.getString('responsavel');
  const filters = hasFilters ? resolveTicketFilters(interaction.options, await getTicketFilters()) : {};
  const tickets = await getAllTickets(filters);
  await sendTicketReply(interaction, tickets, filters);
}

export async function autocomplete(interaction) {
  let timer;
  try {
    const focused = interaction.options.getFocused(true);
    const available = await Promise.race([
      getTicketFilters(),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1800); }),
    ]);
    await interaction.respond(available ? buildFilterSuggestions(available, focused.name, focused.value) : []);
  } finally { clearTimeout(timer); }
}
