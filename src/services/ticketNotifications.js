import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, escapeMarkdown } from 'discord.js';
import { ClickUpError, getAllTickets, getTicket } from '../integrations/clickup.js';
import { BotSetupError, describeError } from './errors.js';
import { createNotificationStore } from './notificationState.js';
import { attachmentField, prepareTicketAttachments } from './ticketAttachments.js';

export function createTicketMonitor({ store, scope, fetchTickets, fetchTicket, sendNotification, intervalMs = 600_000, now = Date.now, onError = () => {} }) {
  let state;
  let timer;
  let inFlight;
  let operations = Promise.resolve();
  let stopped = false;
  const controller = new AbortController();

  // API e Discord podem demorar; serializar impede corrida entre webhook e recuperação.
  function serial(operation) {
    const result = operations.then(() => { if (!stopped) return operation(); });
    operations = result.catch(() => {});
    return result;
  }

  async function initialize() {
    if (state) return;
    const saved = await store.read();
    if (saved) {
      if (saved.version !== 1 || saved.scope !== scope || !Number.isFinite(saved.startedAt) || saved.startedAt <= 0 || !Number.isFinite(saved.lastScan) || saved.lastScan < saved.startedAt || !Array.isArray(saved.notifiedIds) || saved.notifiedIds.some((id) => typeof id !== 'string')
        || (saved.allTicketsSince !== undefined && (!Number.isFinite(saved.allTicketsSince) || saved.allTicketsSince < saved.startedAt))) {
        throw new BotSetupError('Estado dos avisos inválido ou incompatível. O monitor foi interrompido para não repetir ou perder avisos.');
      }
      // Ampliação do escopo: preservar histórico sem avisar retroativamente os antes excluídos.
      const migrated = { ...saved, allTicketsSince: saved.allTicketsSince ?? Math.max(now(), saved.startedAt) };
      if (saved.allTicketsSince === undefined) await store.write(migrated);
      state = migrated;
    } else {
      const startedAt = now();
      const initial = { version: 1, scope, startedAt, allTicketsSince: startedAt, lastScan: startedAt, notifiedIds: [] };
      await store.write(initial);
      state = initial;
    }
  }

  async function notify(ticket) {
    if (stopped || !ticket) return;
    if (!Number.isFinite(ticket.createdAt) || ticket.createdAt <= 0) {
      throw new BotSetupError('Um ticket retornou sem data de criação válida. O monitor repetirá a consulta sem avançar o controle.');
    }
    if (ticket.createdAt < state.allTicketsSince || state.notifiedIds.includes(ticket.id)) return;
    await sendNotification(ticket, { signal: controller.signal });
    const next = { ...state, notifiedIds: [...state.notifiedIds, ticket.id] };
    // Só altera o estado em memória depois de persistir a confirmação.
    await store.write(next);
    state = next;
  }

  function poll() {
    if (inFlight) return inFlight;
    if (stopped) return Promise.resolve();
    inFlight = serial(async () => {
      if (!state) throw new BotSetupError('Inicialize o monitor antes de consultar novos tickets.');
      const scanStarted = Math.max(now(), state.lastScan);
      const tickets = await fetchTickets({
        createdAfter: state.allTicketsSince - 1,
        updatedAfter: Math.max(state.allTicketsSince - 1, state.lastScan - 60_000),
        signal: controller.signal,
      });
      for (const ticket of tickets) await notify(ticket);
      if (stopped) return;
      const next = { ...state, lastScan: scanStarted };
      await store.write(next);
      state = next;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  }

  async function cycle() {
    try { await poll(); }
    catch (error) { if (!stopped) onError(error); }
    finally { if (!stopped) timer = setTimeout(cycle, intervalMs); }
  }

  return {
    initialize, poll,
    processTask(taskId) {
      return serial(async () => {
        if (!state) throw new BotSetupError('Inicialize o monitor antes de processar eventos.');
        if (state.notifiedIds.includes(taskId)) return;
        await notify(await fetchTicket({ taskId, signal: controller.signal }));
      });
    },
    async start() { await initialize(); void cycle(); },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
      await operations;
    },
  };
}

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

export async function sendTicketNotification(channel, ticket, scope, discordUserMap = {}, { fetchDetails = getTicket, prepareFiles = prepareTicketAttachments, signal } = {}) {
  // A listagem de recuperação não inclui os anexos; consultar o ticket completo.
  const detailed = Array.isArray(ticket.attachments) ? ticket
    : await fetchDetails({ taskId: ticket.id, listId: scope.split(':')[0], signal }) || ticket;
  const member = channel.guild.members.me;
  const canAttach = Boolean(member && channel.permissionsFor(member)?.has(PermissionFlagsBits.AttachFiles));
  const { files, omitted } = await prepareFiles(detailed, { signal, canAttach });
  if (signal?.aborted) throw new ClickUpError('Envio do aviso cancelado durante o encerramento.');
  const payload = buildTicketNotification(detailed, scope, discordUserMap);
  if (omitted) payload.content += '\n📎 Alguns anexos estão disponíveis pelos links no aviso ou no ticket.';
  try { return await channel.send({ ...payload, files }); }
  catch (error) {
    // Rejeição explícita do upload: entregar o aviso com links em vez de perder o ticket.
    if (!files.length || (!([40005, 50045, 50013].includes(error.code)) && error.status !== 413)) throw error;
    return channel.send({ ...payload, files: [], content: payload.content + '\n📎 Os arquivos não puderam ser enviados; abra os links dos anexos.' });
  }
}

export async function startTicketNotifications(client, config) {
  const channel = await client.channels.fetch(config.channelId);
  if (!channel?.guild || !channel.isSendable()) {
    throw new BotSetupError('O canal de avisos não existe, está inacessível ou não aceita mensagens.');
  }
  const member = channel.guild.members.me ?? await channel.guild.members.fetchMe();
  const permissions = channel.permissionsFor(member);
  const sendPermission = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(sendPermission) || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    throw new BotSetupError('O bot precisa de Visualizar canal, Enviar mensagens e Inserir links no canal de avisos.');
  }
  if (channel.isThread() && (channel.archived || channel.locked)) {
    throw new BotSetupError('O canal de avisos não pode ser uma thread arquivada ou bloqueada.');
  }
  const scope = `${config.listId}:${config.channelId}`;
  const path = fileURLToPath(new URL(`../../.data/ticket-notifications-${config.listId}-${config.channelId}.json`, import.meta.url));
  let firstRead = true;
  const monitor = createTicketMonitor({
    store: createNotificationStore(path), scope, intervalMs: config.intervalMs,
    fetchTicket: (filters) => getTicket({ ...filters, listId: config.listId }),
    fetchTickets: async (filters) => {
      const tickets = await getAllTickets({ ...filters, listId: config.listId });
      if (firstRead) {
        console.log('[INFO] Monitor: consulta inicial ao ClickUp concluída.');
        firstRead = false;
      }
      return tickets;
    },
    sendNotification: async (ticket, { signal }) => {
      const message = await sendTicketNotification(channel, ticket, scope, config.discordUserMap, { signal });
      console.log(`[INFO] Aviso de novo ticket enviado. ID da mensagem: ${message.id}`);
    },
    onError: (error) => console.error(`[ERRO] Monitor de tickets: ${error instanceof ClickUpError ? error.message : describeError(error)}`),
  });
  await monitor.start();
  console.log(`[INFO] Monitor de novos tickets ativo: canal ${config.channelId}, recuperação a cada ${config.intervalMs / 1000}s.`);
  return monitor;
}
