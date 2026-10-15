import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EmbedBuilder, PermissionFlagsBits, escapeMarkdown } from 'discord.js';
import { ClickUpError, getAllTickets } from '../integrations/clickup.js';
import { BotSetupError, describeError } from './errors.js';
import { createNotificationStore } from './notificationState.js';

export function createTicketMonitor({ store, scope, assigneeIds, fetchTickets, sendNotification, intervalMs = 30_000, now = Date.now, onError = () => {} }) {
  let state;
  let timer;
  let inFlight;
  let stopped = false;
  const controller = new AbortController();
  const allowed = new Set(assigneeIds);

  async function initialize() {
    if (state) return;
    state = await store.read();
    if (state) {
      if (state.version !== 1 || state.scope !== scope || !Number.isFinite(state.startedAt) || state.startedAt <= 0 || !Number.isFinite(state.lastScan) || state.lastScan < state.startedAt || !Array.isArray(state.notifiedIds) || state.notifiedIds.some((id) => typeof id !== 'string')) {
        throw new BotSetupError('Estado dos avisos inválido ou incompatível. O monitor foi interrompido para não repetir ou perder avisos.');
      }
    } else {
      const startedAt = now();
      state = { version: 1, scope, startedAt, lastScan: startedAt, notifiedIds: [] };
      await store.write(state);
    }
  }

  function poll() {
    if (inFlight) return inFlight;
    if (stopped) return Promise.resolve();
    inFlight = (async () => {
      if (!state) throw new BotSetupError('Inicialize o monitor antes de consultar novos tickets.');
      const scanStarted = Math.max(now(), state.lastScan);
      const tickets = await fetchTickets({
        createdAfter: state.startedAt - 1,
        updatedAfter: Math.max(state.startedAt - 1, state.lastScan - 60_000),
        signal: controller.signal,
      });
      const notified = new Set(state.notifiedIds);
      for (const ticket of tickets) {
        if (stopped) return;
        if (!Number.isFinite(ticket.createdAt) || ticket.createdAt <= 0) {
          throw new BotSetupError('Um ticket retornou sem data de criação válida. O monitor repetirá a consulta sem avançar o controle.');
        }
        if (ticket.createdAt < state.startedAt || notified.has(ticket.id) || !ticket.assignees.some((user) => allowed.has(user.id))) continue;
        await sendNotification(ticket);
        notified.add(ticket.id);
        state.notifiedIds.push(ticket.id);
        // Só confirma o aviso depois do retorno de channel.send().
        await store.write(state);
      }
      state.lastScan = scanStarted;
      await store.write(state);
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  }

  async function cycle() {
    try { await poll(); }
    catch (error) { if (!stopped) onError(error); }
    finally { if (!stopped) timer = setTimeout(cycle, intervalMs); }
  }

  return {
    initialize, poll,
    async start() { await initialize(); void cycle(); },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
      try { await inFlight; } catch { /* Encerramento cancela a consulta em andamento. */ }
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
    .setDescription(`**Resumo**\n${short(escapeMarkdown(ticket.summary || 'Resumo não informado.'), 3500)}`)
    .addFields(
      { name: 'Status', value: short(escapeMarkdown(ticket.status), 256), inline: true },
      { name: 'Responsáveis', value: short(ticket.assignees.map((user) => escapeMarkdown(user.name)).join(', ') || 'Não atribuído', 1024) },
    ).setFooter({ text: 'Novo ticket • Suporte B2C' });
  return {
    content: '🆕 Novo ticket aberto no ClickUp!' + (discordUsers.length ? '\n' + discordUsers.map((id) => `<@${id}>`).join(' ') : ''),
    embeds: [embed], allowedMentions: { parse: [], ...(discordUsers.length ? { users: discordUsers } : {}) },
    nonce: createHash('sha256').update(`${scope}:${ticket.id}`).digest('hex').slice(0, 24), enforceNonce: true,
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
    store: createNotificationStore(path), scope, assigneeIds: config.assigneeIds, intervalMs: config.intervalMs,
    fetchTickets: async (filters) => {
      const tickets = await getAllTickets({ ...filters, listId: config.listId });
      if (firstRead) {
        console.log('[INFO] Monitor: consulta inicial ao ClickUp concluída.');
        firstRead = false;
      }
      return tickets;
    },
    sendNotification: async (ticket) => {
      const message = await channel.send(buildTicketNotification(ticket, scope, config.discordUserMap));
      console.log(`[INFO] Aviso de novo ticket enviado. ID da mensagem: ${message.id}`);
    },
    onError: (error) => console.error(`[ERRO] Monitor de tickets: ${error instanceof ClickUpError ? error.message : describeError(error)}`),
  });
  await monitor.start();
  console.log(`[INFO] Monitor de novos tickets ativo: canal ${config.channelId}, consulta a cada ${config.intervalMs / 1000}s.`);
  return monitor;
}
