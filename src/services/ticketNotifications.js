import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits } from 'discord.js';
import { ClickUpError, getAllTickets, getTicket } from '../integrations/clickup.js';
import { BotSetupError, describeError } from './errors.js';
import { createNotificationStore } from './notificationState.js';
import { sendTicketNotification } from './ticketMessages.js';
import { notifyNewTicketAssignees } from './ticketAssignmentDm.js';
export { buildTicketNotification, sendTicketNotification } from './ticketMessages.js';

export function createTicketMonitor({ store, scope, fetchTickets, fetchTicket, sendNotification, afterNotification = async () => {}, intervalMs = 600_000, now = Date.now, onError = () => {} }) {
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
    const delivered = await sendNotification(ticket, { signal: controller.signal });
    const next = { ...state, notifiedIds: [...state.notifiedIds, ticket.id] };
    // Só altera o estado em memória depois de persistir a confirmação.
    await store.write(next);
    state = next;
    // O privado é adicional: sua falha nunca invalida o aviso público persistido.
    if (!stopped) {
      try { await afterNotification(delivered?.ticket ?? ticket, { signal: controller.signal }); }
      catch (error) { if (!stopped) onError(error); }
    }
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
      const detailed = Array.isArray(ticket.attachments) ? ticket
        : await getTicket({ taskId: ticket.id, listId: config.listId, signal }) || ticket;
      const message = await sendTicketNotification(channel, detailed, scope, config.discordUserMap, { signal });
      console.log(`[INFO] Aviso de novo ticket enviado. ID da mensagem: ${message.id}`);
      return { ticket: detailed };
    },
    afterNotification: (ticket, { signal }) => notifyNewTicketAssignees({ client, ticket, config, signal }),
    onError: (error) => console.error(`[ERRO] Monitor de tickets: ${error instanceof ClickUpError ? error.message : describeError(error)}`),
  });
  await monitor.start();
  console.log(`[INFO] Monitor de novos tickets ativo: canal ${config.channelId}, recuperação a cada ${config.intervalMs / 1000}s.`);
  return monitor;
}
