import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { readNotificationConfig } from '../src/config.js';
import { getTicketComment } from '../src/integrations/clickup.js';
import { createCommentNotifications, buildCommentPayloads } from '../src/services/commentNotifications.js';
import { extractCommentEvents, normalizeComment } from '../src/services/ticketComments.js';
import { startWebhookServer } from '../src/services/webhookServer.js';
import { ensureClickUpWebhook } from '../src/services/clickupWebhook.js';

const discordId = '345678901234567890';
const otherDiscordId = '456789012345678901';
const config = { listId: '12345', channelId: '234567890123456789', discordUserMap: { '11': discordId, '22': otherDiscordId } };
const rawFile = { id: 'f', title: 'comentario.pdf', url: 'https://t123.p.clickup-attachments.com/file', size: 4 };
const raw = (id = 'c', overrides = {}) => ({ id, date: '1500', user: { username: 'Autora' }, comment: [{ text: 'Mensagem @everyone ' }, { type: 'attachment', attachment: rawFile }], ...overrides });
const event = (id = 'c', overrides = {}) => ({ taskId: 'a', comment: normalizeComment(raw(id, overrides)) });
const ticket = { id: 'a', createdAt: 1, name: 'Ticket antigo', status: 'to do', assignees: [{ id: '11', name: 'Pessoa' }],
  summary: 'Resumo original', url: 'https://app.clickup.com/t/a', attachments: [{ name: 'arquivo-do-ticket.pdf' }] };
const memoryStore = (initial = null) => {
  let value = structuredClone(initial);
  return { read: async () => structuredClone(value), write: async (next) => { value = structuredClone(next); } };
};
async function fixture(t, overrides = {}, store = memoryStore()) {
  const sent = [];
  const service = await createCommentNotifications({ store, config, now: () => 1000, onError: () => {},
    client: { users: { fetch: async (id) => ({ createDM: async () => ({ recipient: id }) }) } },
    fetchTicket: async () => ticket, fetchComment: async () => raw(),
    deliver: async (dm, value, scope, map, options) => { sent.push({ recipient: dm.recipient, value, payload: options.buildPayload() }); return { id: 'm' }; }, ...overrides,
  });
  t.after(() => service.stop());
  return { service, store, sent };
}

test('normaliza mensagens e anexos embutidos, sem confundir arquivos do ticket ou duplicar links', () => {
  const comment = normalizeComment(raw('c', { attachments: [rawFile], email_attachments: [rawFile] }));
  assert.equal(comment.text, 'Mensagem @everyone ');
  assert.equal(comment.attachments.length, 1);
  assert.equal(comment.attachments[0].name, 'comentario.pdf');
  const events = extractCommentEvents({ task_id: 'a', history_items: [{ field: 'status' }, { field: 'comment', date: '1500', comment: raw() }] });
  assert.deepEqual(events, [event()]);
  assert.equal(normalizeComment(raw('c', { date: 'inválida' })), null);
  assert.equal(normalizeComment(raw(Number.MAX_SAFE_INTEGER + 1)), null);
  assert.deepEqual(extractCommentEvents({ task_id: '../outro', history_items: [] }), []);
});

test('mensagem privada preserva texto longo em partes e anexos somente na primeira', () => {
  const comment = normalizeComment(raw('c', { text_content: '*😀'.repeat(4000) }));
  const parts = buildCommentPayloads(ticket, comment, 'list:channel', discordId);
  assert.ok(parts.length > 1);
  const descriptions = parts.map((part) => part.payload.embeds[0].toJSON().description.split('comentou:**\n')[1]).join('');
  assert.equal(descriptions, '\\*😀'.repeat(4000));
  for (const [index, part] of parts.entries()) {
    const embed = part.payload.embeds[0].toJSON();
    assert.ok(embed.description.length <= 4096);
    assert.deepEqual((embed.fields || []).map((field) => field.name), index === 0 ? ['Anexos (1)'] : []);
    assert.deepEqual(part.payload.allowedMentions, { parse: [] });
    assert.equal(part.payload.components[0].toJSON().components[0].url, ticket.url);
    assert.equal(part.ticket.attachments.length, index === 0 ? 1 : 0);
  }
  assert.notEqual(parts[0].payload.nonce, parts[1].payload.nonce);
  assert.equal(parts[0].payload.nonce, buildCommentPayloads(ticket, comment, 'list:channel', discordId)[0].payload.nonce);
});

test('envia comentário novo em ticket antigo somente aos responsáveis vinculados e deduplica após reinício', async (t) => {
  const f = await fixture(t);
  await f.service.enqueue([event()]); await f.service.flush();
  await f.service.enqueue([event()]); await f.service.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].recipient, discordId);
  assert.equal(f.sent[0].value.attachments[0].name, 'comentario.pdf');
  await f.service.stop();
  const next = await fixture(t, {}, f.store);
  await next.service.enqueue([event()]); await next.service.flush();
  assert.equal(next.sent.length, 0);
});

test('sem responsável, sem vínculo ou fora da lista não abre privados; ignora backlog anterior à ativação', async (t) => {
  for (const value of [null, { ...ticket, assignees: [] }, { ...ticket, assignees: [{ id: '99' }] }]) {
    const f = await fixture(t, { fetchTicket: async () => value, client: { users: { fetch: () => assert.fail('Sem destinatário elegível.') } } });
    await f.service.enqueue([event()]); await f.service.flush();
    assert.equal(f.sent.length, 0);
  }
  const f = await fixture(t);
  await f.service.enqueue([event('antigo', { date: '999' })]); await f.service.flush();
  assert.equal(f.sent.length, 0);
});

test('cada responsável recebe uma cópia; falha transitória não repete destinatários já confirmados', async (t) => {
  let failed = true; const calls = [];
  const f = await fixture(t, {
    fetchTicket: async () => ({ ...ticket, assignees: [{ id: '11', name: 'Primeiro' }, { id: '22', name: 'Segundo' }, { id: '11', name: 'Primeiro' }, { id: '99', name: 'Sem vínculo' }] }),
    deliver: async (dm) => { calls.push(dm.recipient); if (dm.recipient === otherDiscordId && failed) throw new Error('rede'); return { id: 'm' }; },
  });
  await f.service.enqueue([event()]); await f.service.flush();
  assert.equal((await f.store.read()).pending.length, 1);
  failed = false; await f.service.flush();
  assert.deepEqual(calls, [discordId, otherDiscordId, otherDiscordId]);
  assert.equal((await f.store.read()).pending.length, 0);
});

test('privado bloqueado não impede outro responsável nem mantém fila em repetição', async (t) => {
  const calls = [];
  const f = await fixture(t, { fetchTicket: async () => ({ ...ticket, assignees: [{ id: '11', name: 'Primeiro' }, { id: '22', name: 'Segundo' }] }),
    deliver: async (dm) => { calls.push(dm.recipient); if (dm.recipient === discordId) throw { code: 50007 }; return { id: 'm' }; },
  });
  await f.service.enqueue([event()]); await f.service.flush();
  assert.deepEqual(calls, [discordId, otherDiscordId]);
  assert.equal((await f.store.read()).pending.length, 0);
});

test('progresso de uma mensagem longa é persistido e não repete partes confirmadas', async (t) => {
  const calls = []; let fail = true;
  const f = await fixture(t, { deliver: async (_dm, _value, _scope, _map, options) => {
    const payload = options.buildPayload(); calls.push(payload.nonce);
    if (calls.length === 2 && fail) throw new Error('rede'); return { id: 'm' };
  } });
  await f.service.enqueue([event('longa', { comment_text: 'a'.repeat(5801) })]); await f.service.flush();
  assert.equal((await f.store.read()).pending[0].sent.length, 1);
  fail = false; await f.service.flush();
  assert.equal(calls.length, 4);
  assert.equal(calls[1], calls[2]);
  assert.notEqual(calls[0], calls[3]);
  assert.equal((await f.store.read()).pending.length, 0);
});

test('evento incompleto consulta comentários na API antes do envio', async (t) => {
  const calls = [];
  const f = await fixture(t, { fetchComment: async (options) => { calls.push(options); return raw(); } });
  const events = extractCommentEvents({ task_id: 'a', history_items: [{ field: 'comment', after: 'c', date: '1500', user: { username: 'Pessoa' } }] });
  await f.service.enqueue(events); await f.service.flush();
  assert.equal(calls[0].commentId, 'c'); assert.equal(f.sent.length, 1);
});

test('API de comentários percorre páginas com data e ID sem perder precisão', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests++;
    if (requests === 1) return Response.json({ comments: [raw('9999999999999999999', { date: '2000' })] });
    const query = new URL(url).searchParams;
    assert.equal(query.get('start_id'), '9999999999999999999'); assert.equal(query.get('start'), '2000');
    return Response.json({ comments: [raw('alvo')] });
  });
  assert.equal((await getTicketComment({ taskId: 'a', commentId: 'alvo', token: 'ficticio' })).id, 'alvo');
  assert.equal(requests, 2);
});

test('API detecta paginação repetida e não trata consulta incompleta como sucesso', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ comments: [raw()] }));
  await assert.rejects(getTicketComment({ taskId: 'a', commentId: 'outro', token: 'ficticio' }), /repetiu uma página/);
});

test('webhook confirma comentário somente após persistir e o mantém separado de criação de tickets', async (t) => {
  const accepted = []; let release; let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const server = await startWebhookServer({ port: 0, getCredentials: () => ({ id: 'w', secret: 'ficticio' }),
    enqueue: () => assert.fail('Não deve processar como ticket novo.'),
    enqueueComments: async (events) => { started(); await new Promise((resolve) => { release = resolve; }); accepted.push(...events); },
  });
  t.after(() => server.stop());
  const body = JSON.stringify({ event: 'taskCommentPosted', webhook_id: 'w', task_id: 'a', history_items: [{ field: 'comment', comment: raw() }] });
  const signature = createHmac('sha256', 'ficticio').update(body).digest('hex');
  let answered = false;
  const response = fetch(`http://127.0.0.1:${server.port}/webhooks/clickup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': signature }, body }).then((value) => { answered = true; return value; });
  await waiting;
  assert.equal(answered, false); assert.deepEqual(accepted, []);
  release(); assert.equal((await response).status, 202); assert.deepEqual(accepted, [event()]);
});

test('comentários são opcionais, funcionam sem webhook e são adicionados ao cadastro quando habilitados', async () => {
  const env = { TICKET_NOTIFICATIONS_ENABLED: 'true', TICKET_NOTIFICATION_CHANNEL_ID: '234567890123456789', CLICKUP_API_TOKEN: 'ficticio', CLICKUP_TICKETS_LIST_ID: '12345' };
  assert.equal(readNotificationConfig(env).commentDmEnabled, false);
  assert.equal(readNotificationConfig({ ...env, TICKET_COMMENT_DM_ENABLED: 'true' }).commentDmEnabled, true);
  assert.equal(readNotificationConfig({ ...env, TICKET_COMMENT_DM_ENABLED: 'true', CLICKUP_WEBHOOK_ENABLED: 'true' }).commentDmEnabled, true);
  const calls = [];
  await ensureClickUpWebhook({ store: memoryStore(), scope: 's', workspaceId: '123', listId: '12345', endpoint: 'https://example.com/webhooks/clickup', commentDmEnabled: true,
    request: async (...args) => { calls.push(args); return { webhook: { id: 'w', secret: 'ficticio' } }; },
  });
  assert.deepEqual(calls[0][3].body.events, ['taskCreated', 'taskStatusUpdated', 'taskCommentPosted']);
});

test('estado inválido é preservado e não é substituído por uma fila vazia', async () => {
  const store = { read: async () => ({ version: 99 }), write: () => assert.fail('Não deve apagar estado inválido.') };
  await assert.rejects(createCommentNotifications({ store, config }), /Estado dos comentários inválido/);
});

test('comentário pendente sobrevive a reinício, com texto e anexos preservados', async (t) => {
  const store = memoryStore();
  const first = await fixture(t, { fetchTicket: async () => { throw new Error('offline'); } }, store);
  await first.service.enqueue([event()]); await first.service.flush(); await first.service.stop();
  assert.equal((await store.read()).pending[0].comment.attachments.length, 1);
  const next = await fixture(t, {}, store);
  await next.service.flush();
  assert.equal(next.sent.length, 1);
  assert.equal((await store.read()).pending.length, 0);
});

test('encerramento cancela consulta e preserva comentário pendente para reinício', async (t) => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { fetchTicket: async ({ signal }) => {
    entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelado')), { once: true }));
  } });
  await f.service.enqueue([event()]); await started;
  await f.service.stop();
  assert.equal((await f.store.read()).pending.length, 1);
  assert.equal(f.sent.length, 0);
});

test('receptor rejeita comentários inválidos e assinatura falsa; falha de persistência retorna 503', async (t) => {
  let calls = 0;
  const server = await startWebhookServer({ port: 0, getCredentials: () => ({ id: 'w', secret: 'ficticio' }), enqueue: () => assert.fail(),
    enqueueComments: async () => { calls++; throw new Error('disco'); },
  });
  t.after(() => server.stop());
  const url = `http://127.0.0.1:${server.port}/webhooks/clickup`;
  const send = (value, signature) => {
    const body = JSON.stringify(value);
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': signature ?? createHmac('sha256', 'ficticio').update(body).digest('hex') }, body });
  };
  const value = { event: 'taskCommentPosted', webhook_id: 'w', task_id: 'a', history_items: [{ field: 'comment', comment: raw() }] };
  assert.equal((await send(value, '0'.repeat(64))).status, 403);
  assert.equal((await send({ ...value, history_items: [] })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await send(value)).status, 503);
  assert.equal(calls, 1);
});


test('imagens embutidas usam os metadados reais do ClickUp e não perdem o arquivo', () => {
  const value = normalizeComment(raw('imagem', { comment: [{ type: 'image', text: '', image: rawFile,
    attributes: { 'data-attachment': rawFile } }] }));
  assert.equal(value.attachments.length, 1);
  assert.equal(value.attachments[0].name, 'comentario.pdf');
  const parts = buildCommentPayloads(ticket, value, 'list:channel', discordId);
  assert.equal(parts[0].ticket.attachments.length, 1);
  assert.ok(parts[0].payload.embeds[0].toJSON().description.includes('Mensagem com anexo.'));
});


test('aviso da Activity sem anexos mostra o comentário sem campos de status ou responsáveis', () => {
  const comment = normalizeComment(raw('texto', { comment_text: 'Atualização da tratativa.', comment: [{ text: 'Atualização da tratativa.' }] }));
  const [part] = buildCommentPayloads(ticket, comment, 'list:channel', discordId);
  const embed = part.payload.embeds[0].toJSON();
  assert.ok(embed.description.includes('Atualização da tratativa.'));
  assert.deepEqual(embed.fields || [], []);
  assert.deepEqual(part.ticket.attachments, []);
});
