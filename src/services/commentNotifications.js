import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } from 'discord.js';
import { ClickUpError, getAllTickets, getTicket, getTicketComment, getTicketCommentsSince, requestClickUp } from '../integrations/clickup.js';
import { BotSetupError } from './errors.js';
import { createNotificationStore } from './notificationState.js';
import { buildTicketNotification, sendTicketNotification } from './ticketMessages.js';
import { normalizeComment, validCommentId } from './ticketComments.js';
import { attachmentField } from './ticketAttachments.js';

const keyOf = ({ taskId, comment }) => `${taskId}:${comment.id}`;
const clip = (value, length) => [...String(value)].slice(0, length).join('');
const validJob = (job) => job && validCommentId(job.taskId) && validCommentId(job.comment?.id)
  && Number.isSafeInteger(job.comment.createdAt) && job.comment.createdAt > 0
  && typeof job.comment.author === 'string' && (job.comment.text === null || typeof job.comment.text === 'string')
  && Array.isArray(job.comment.attachments) && Array.isArray(job.sent) && job.sent.every((id) => /^\d{17,20}:\d+$/.test(id))
  && Array.isArray(job.blocked) && job.blocked.every((id) => /^\d{17,20}$/.test(id));

export function buildCommentPayloads(ticket, comment, scope, discordId) {
  const text = escapeMarkdown(comment.text?.trim() || (comment.attachments.length ? 'Mensagem com anexo.' : 'Mensagem sem texto.'));
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 2900, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(start, end)); start = end;
  }
  return chunks.map((chunk, index) => {
    const value = { ...ticket, attachments: index === 0 ? comment.attachments : [] };
    const payload = buildTicketNotification(value, scope);
    payload.content = '💬 Nova mensagem na Activity de um ticket do ClickUp.';
    const attachments = attachmentField(value);
    payload.embeds[0].setFields(attachments ? [attachments] : []);
    payload.embeds[0].setDescription(`**${escapeMarkdown(clip(comment.author, 100))} comentou:**\n${chunk}`)
      .setTimestamp(comment.createdAt).setFooter({ text: `Activity • Mensagem ${index + 1} de ${chunks.length}` });
    payload.components = [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setStyle(ButtonStyle.Link).setLabel('Abrir ticket no ClickUp').setURL(ticket.url))];
    payload.allowedMentions = { parse: [] };
    payload.nonce = createHash('sha256').update(`comment:${scope}:${ticket.id}:${comment.id}:${discordId}:${index}`).digest('hex').slice(0, 24);
    return { ticket: value, payload };
  });
}

export async function getCommentRecoveryTickets({ config, signal, loadTickets = getAllTickets }) {
  const tickets = new Map();
  for (const assigneeId of Object.keys(config.discordUserMap || {})) {
    for (const ticket of await loadTickets({ listId: config.listId, assigneeId, signal })) tickets.set(ticket.id, ticket);
  }
  return [...tickets.values()];
}

// Espaçar as consultas de comentários deixa margem para comandos e webhooks.
export function createCommentRecoveryRequest({ request = requestClickUp, wait = delay } = {}) {
  let previous;
  return async (...args) => {
    const pause = previous === undefined ? 0 : Math.max(0, 1000 - (Date.now() - previous));
    if (pause) await wait(pause, undefined, { signal: args[2] });
    args[2]?.throwIfAborted();
    previous = Date.now();
    return request(...args);
  };
}

export async function createCommentNotifications({ store, client, config, now = Date.now, retryMs = 30_000,
  fetchTicket = getTicket, fetchComment = getTicketComment, deliver = sendTicketNotification,
  fetchRecoveryTickets = (options) => getCommentRecoveryTickets({ ...options, config }),
  fetchRecoveryComments = getTicketCommentsSince, intervalMs = config.intervalMs || 600_000,
  onError = () => console.error('[ERRO] Aviso privado de comentário indisponível; nova tentativa será feita pela fila.'),
}) {
  const scope = `${config.listId}:${config.channelId}`;
  let state = await store.read();
  if (!state) {
    state = { version: 1, scope, startedAt: now(), pending: [], completedIds: [] };
    await store.write(state);
  }
  if (state.version !== 1 || state.scope !== scope || !Number.isSafeInteger(state.startedAt) || state.startedAt <= 0
    || !Array.isArray(state.pending) || !state.pending.every(validJob) || !Array.isArray(state.completedIds)
    || (state.lastRecovery !== undefined && (!Number.isSafeInteger(state.lastRecovery) || state.lastRecovery < state.startedAt))
    || state.completedIds.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}:[a-zA-Z0-9_-]{1,100}$/.test(id))) {
    throw new BotSetupError('Estado dos comentários inválido. Preserve e verifique o arquivo em .data.');
  }
  if (state.lastRecovery === undefined) {
    const migrated = { ...state, lastRecovery: state.startedAt };
    await store.write(migrated); state = migrated;
  }
  const controller = new AbortController();
  const signal = controller.signal;
  let writes = Promise.resolve();
  let worker;
  let timer;
  let recoveryTimer;
  let recovering;
  let stopped = false;
  function update(change) {
    const operation = writes.then(async () => {
      const next = change(state);
      await store.write(next); state = next;
    });
    writes = operation.catch(() => {});
    return operation;
  }
  const currentJob = (key) => state.pending.find((item) => keyOf(item) === key);
  const mark = (key, field, value) => update((current) => ({ ...current, pending: current.pending.map((job) => keyOf(job) === key
    ? { ...job, [field]: [...new Set([...job[field], value])] } : job) }));
  const finish = (key) => update((current) => ({ ...current,
    pending: current.pending.filter((job) => keyOf(job) !== key), completedIds: [...new Set([...current.completedIds, key])],
  }));

  async function process(job) {
    const key = keyOf(job);
    const ticket = await fetchTicket({ taskId: job.taskId, listId: config.listId, signal });
    if (!ticket) { await finish(key); return; }
    let comment = job.comment;
    if (comment.text === null) {
      comment = normalizeComment(await fetchComment({ taskId: job.taskId, commentId: comment.id, signal }));
      if (!comment || comment.text === null) throw new ClickUpError('Comentário ainda não disponível para envio.');
    }
    const recipients = [...new Set(ticket.assignees.map((user) => config.discordUserMap?.[user.id]).filter(Boolean))];
    let failed = false;
    for (const discordId of recipients) {
      if (signal.aborted) return;
      if (currentJob(key).blocked.includes(discordId)) continue;
      try {
        const parts = buildCommentPayloads(ticket, comment, scope, discordId);
        if (parts.every((_, index) => currentJob(key).sent.includes(`${discordId}:${index}`))) continue;
        const user = await client.users.fetch(discordId);
        const dm = await user.createDM();
        for (const [index, part] of parts.entries()) {
          if (signal.aborted) return;
          const deliveryId = `${discordId}:${index}`;
          if (currentJob(key).sent.includes(deliveryId)) continue;
          const message = await deliver(dm, part.ticket, scope, {}, { signal, buildPayload: () => part.payload });
          await mark(key, 'sent', deliveryId);
          console.log(`[INFO] Comentário enviado no privado. ID da mensagem: ${message.id}`);
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error?.code === 50007) {
          await mark(key, 'blocked', discordId);
          console.error('[ERRO] O Discord bloqueou o privado de comentário para um responsável vinculado.');
        } else { failed = true; }
      }
    }
    if (failed) throw new ClickUpError('Falha ao entregar um comentário no privado.');
    if (!signal.aborted) await finish(key);
  }

  function drain() {
    if (worker || stopped) return worker;
    clearTimeout(timer);
    worker = (async () => {
      const attempted = new Set();
      while (!stopped) {
        const job = state.pending.find((item) => !attempted.has(keyOf(item)));
        if (!job) break;
        attempted.add(keyOf(job));
        try { await process(job); } catch { if (!stopped) onError(); }
      }
    })().finally(() => {
      worker = undefined;
      if (!stopped && state.pending.length) timer = setTimeout(drain, retryMs);
    });
    return worker;
  }
  async function enqueue(events) {
    if (stopped) throw new BotSetupError('Recepção de comentários em encerramento.');
    const jobs = events.map((event) => ({ ...event, sent: [], blocked: [] }));
    if (!jobs.length || !jobs.every(validJob)) throw new BotSetupError('Evento de comentário inválido.');
    await update((current) => {
      const pending = [...current.pending];
      for (const job of jobs) {
        const key = keyOf(job);
        if (job.comment.createdAt < current.startedAt || current.completedIds.includes(key) || pending.some((item) => keyOf(item) === key)) continue;
        if (pending.length >= 10_000) throw new BotSetupError('Fila de comentários cheia.');
        pending.push(job);
      }
      return { ...current, pending };
    });
    void drain();
  }

  function poll() {
    if (recovering) return recovering;
    if (stopped) return Promise.resolve();
    recovering = (async () => {
      const scanStarted = Math.max(now(), state.lastRecovery);
      const since = Math.max(state.startedAt, state.lastRecovery - 60_000);
      const tickets = await fetchRecoveryTickets({ signal });
      let failed = false;
      for (const ticket of tickets) {
        if (stopped) return;
        try {
          const raw = await fetchRecoveryComments({ taskId: ticket.id, since, signal });
          if (!Array.isArray(raw)) throw new ClickUpError('Consulta de comentários incompleta.');
          const events = raw.map((value) => ({ taskId: ticket.id, comment: normalizeComment(value) }));
          if (events.some((event) => !event.comment || event.comment.text === null)) throw new ClickUpError('Comentário incompleto na recuperação.');
          events.sort((a, b) => a.comment.createdAt - b.comment.createdAt || a.comment.id.localeCompare(b.comment.id));
          for (let start = 0; start < events.length && !stopped; start += 100) await enqueue(events.slice(start, start + 100));
        } catch (error) {
          if (stopped) return;
          failed = true;
          console.error('[ERRO] Não foi possível recuperar os comentários de um ticket; o checkpoint foi preservado.');
        }
      }
      if (stopped) return;
      if (failed) throw new ClickUpError('A recuperação de comentários não foi concluída; será repetida.');
      await update((current) => ({ ...current, lastRecovery: scanStarted }));
      console.log('[INFO] Recuperação de comentários da Activity concluída.');
    })().finally(() => { recovering = undefined; });
    return recovering;
  }
  async function cycle() {
    try { await poll(); }
    catch { if (!stopped) console.error('[ERRO] Recuperação de comentários indisponível; nova consulta será feita no próximo ciclo.'); }
    finally { if (!stopped) recoveryTimer = setTimeout(cycle, intervalMs); }
  }
  return {
    start() { void drain(); void cycle(); },
    flush: drain, poll, enqueue,
    async stop() {
      stopped = true; controller.abort(); clearTimeout(timer); clearTimeout(recoveryTimer);
      await recovering?.catch(() => {}); await worker; await writes;
    },
  };
}

export async function startTicketCommentNotifications(client, config) {
  if (!config.commentDmEnabled) return null;
  const path = fileURLToPath(new URL(`../../.data/comment-notifications-${config.listId}-${config.channelId}.json`, import.meta.url));
  const request = createCommentRecoveryRequest();
  const service = await createCommentNotifications({ store: createNotificationStore(path), client, config,
    fetchRecoveryComments: (options) => getTicketCommentsSince({ ...options, request }),
  });
  service.start();
  console.log(`[INFO] Avisos privados da Activity ativos; recuperação a cada ${config.intervalMs / 1000}s após a consulta anterior.`);
  return service;
}
