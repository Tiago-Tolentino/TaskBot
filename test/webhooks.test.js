import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readWebhookConfig } from '../src/config.js';
import { getTicket } from '../src/integrations/clickup.js';
import { ensureClickUpWebhook } from '../src/services/clickupWebhook.js';
import { createTicketMonitor } from '../src/services/ticketNotifications.js';
import { createWebhookInbox } from '../src/services/webhookInbox.js';
import { startWebhookServer, verifyWebhookSignature } from '../src/services/webhookServer.js';
import { startLocalTunnel } from '../src/services/localTunnel.js';

const memoryStore = (initial = null) => {
  let value = structuredClone(initial);
  return { read: async () => structuredClone(value), write: async (next) => { value = structuredClone(next); } };
};
const sign = (body, secret = 'segredo-ficticio') => createHmac('sha256', secret).update(body).digest('hex');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('webhook é opcional e valida monitor, workspace e porta antes de conectar', () => {
  assert.equal(readWebhookConfig({}), null);
  const env = { CLICKUP_WEBHOOK_ENABLED: 'true', TICKET_NOTIFICATIONS_ENABLED: 'true', CLICKUP_WORKSPACE_ID: '123' };
  assert.deepEqual(readWebhookConfig(env), { port: 3000, workspaceId: '123', binary: undefined });
  for (const override of [{ TICKET_NOTIFICATIONS_ENABLED: 'false' }, { CLICKUP_WORKSPACE_ID: '' }, { CLICKUP_WEBHOOK_PORT: '0' }, { CLICKUP_WEBHOOK_PORT: '65536' }, { CLICKUP_WEBHOOK_PORT: 'abc' }]) {
    assert.throws(() => readWebhookConfig({ ...env, ...override }));
  }
});

test('assinatura usa os bytes originais e rejeita adulteração e formatos inválidos', () => {
  const body = Buffer.from('{ "event": "taskCreated", "nome": "ação" }');
  const secret = 'segredo-ficticio';
  assert.equal(verifyWebhookSignature(body, sign(body), secret), true);
  assert.equal(verifyWebhookSignature(Buffer.from('{}'), sign(body), secret), false);
  for (const signature of [undefined, '', 'abc', 'g'.repeat(64), ['a'.repeat(64)]]) assert.equal(verifyWebhookSignature(body, signature, secret), false);
});

test('servidor aceita somente rota, assinatura, webhook e evento esperados; persiste antes do 202', async (t) => {
  const accepted = [];
  let credentials;
  let persist;
  const server = await startWebhookServer({ port: 0, getCredentials: () => credentials, enqueue: async (id) => { await new Promise((resolve) => { persist = resolve; }); accepted.push(id); } });
  t.after(() => server.stop());
  const url = `http://127.0.0.1:${server.port}/webhooks/clickup`;
  const send = (body, overrides = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': sign(body) }, body, ...overrides });
  const body = '{ "webhook_id": "webhook-a", "event": "taskCreated", "task_id": "ticket-a" }';
  assert.equal((await send(body)).status, 503);
  credentials = { id: 'webhook-a', secret: 'segredo-ficticio' };
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/.env`)).status, 404);
  assert.equal((await send(body, { headers: { 'Content-Type': 'application/json', 'X-Signature': 'a'.repeat(64) } })).status, 403);
  assert.equal((await send(body.replace('webhook-a', 'outro'))).status, 403);
  assert.equal((await send('{inválido')).status, 400);
  assert.equal((await send(body.replace('taskCreated', 'taskUpdated'))).status, 204);
  assert.equal((await send(body.replace('ticket-a', '../segredo'))).status, 400);
  assert.equal((await send('x'.repeat(262145))).status, 413);
  let answered = false;
  const pending = send(body).then((response) => { answered = true; return response; });
  while (!persist) await tick();
  assert.equal(answered, false);
  assert.deepEqual(accepted, []);
  persist();
  assert.equal((await pending).status, 202);
  assert.deepEqual(accepted, ['ticket-a']);
});

test('falha ao persistir retorna 503 e não confirma a entrega', async (t) => {
  const server = await startWebhookServer({ port: 0, getCredentials: () => ({ id: 'w', secret: 'segredo-ficticio' }), enqueue: async () => { throw new Error('disco'); } });
  t.after(() => server.stop());
  const body = JSON.stringify({ event: 'taskCreated', webhook_id: 'w', task_id: 'a' });
  const response = await fetch(`http://127.0.0.1:${server.port}/webhooks/clickup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': sign(body) }, body });
  assert.equal(response.status, 503);
});

test('fila persiste eventos, recupera reinício e retém falhas sem bloquear outros tickets', async () => {
  const store = memoryStore({ version: 1, taskIds: ['falha', 'ok'] });
  const processed = [];
  const inbox = await createWebhookInbox({ store, processTask: async (id) => { if (id === 'falha') throw new Error(); processed.push(id); } });
  inbox.start();
  while (!processed.includes('ok')) await tick();
  await inbox.stop();
  assert.deepEqual((await store.read()).taskIds, ['falha']);
  const next = await createWebhookInbox({ store, processTask: async (id) => processed.push(id) });
  next.start();
  while ((await store.read()).taskIds.length) await tick();
  await next.stop();
  assert.deepEqual((await store.read()).taskIds, []);
});

test('fila recebe eventos sem aguardar API ou Discord e não perde gravações simultâneas', async () => {
  let release;
  const store = memoryStore();
  const inbox = await createWebhookInbox({ store, processTask: () => new Promise((resolve) => { release = resolve; }) });
  await inbox.enqueue('a');
  await tick();
  await Promise.all([inbox.enqueue('b'), inbox.enqueue('c'), inbox.enqueue('b')]);
  assert.deepEqual((await store.read()).taskIds, ['a', 'b', 'c']);
  const stopping = inbox.stop();
  release(); await stopping;
  assert.deepEqual((await store.read()).taskIds, ['a', 'b', 'c']);
});

test('registro cria apenas taskCreated na lista; reinício atualiza endereço e preserva segredo', async () => {
  const store = memoryStore();
  const calls = [];
  const request = async (...args) => { calls.push(args); return { webhook: { id: 'w', secret: 'segredo-ficticio' } }; };
  const options = { store, scope: 'team:list:channel', workspaceId: '123', listId: '456', endpoint: 'https://example.com/webhooks/clickup', token: 'ficticio', request };
  const first = await ensureClickUpWebhook(options);
  assert.equal(first.id, 'w');
  assert.equal(calls[0][0], '/team/123/webhook');
  assert.deepEqual(calls[0][3].body, { endpoint: options.endpoint, events: ['taskCreated'], list_id: '456' });
  await ensureClickUpWebhook({ ...options, endpoint: 'https://outro.example.com/webhooks/clickup' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][3].method, 'PUT');
  assert.equal(calls[1][3].body.status, 'active');
  assert.equal((await store.read()).secret, 'segredo-ficticio');
});

test('registro removido é recriado; falha de rede não cria webhook duplicado', async () => {
  const saved = { version: 1, scope: 's', id: 'w', secret: 'segredo-ficticio' };
  const options = { store: memoryStore(saved), scope: 's', workspaceId: '123', listId: '456', endpoint: 'https://example.com/webhooks/clickup' };
  let calls = 0;
  await assert.rejects(ensureClickUpWebhook({ ...options, request: async () => { calls++; throw new Error('rede'); } }));
  assert.equal(calls, 1);
  await ensureClickUpWebhook({ ...options, request: async (_path, _token, _signal, { method }) => { if (method === 'PUT') throw Object.assign(new Error(), { status: 404 }); return { webhook: { id: 'novo', secret: 'novo-segredo' } }; } });
  assert.equal((await options.store.read()).id, 'novo');
});

test('consulta individual busca só o ticket do evento e ignora lista diferente ou recurso removido', async (t) => {
  let listId = '456';
  let removed = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://api.clickup.com/api/v2/task/a');
    return removed ? new Response('', { status: 404 }) : Response.json({ id: 'a', name: 'A', date_created: '1500', assignees: [], list: { id: listId }, description: 'Resumo\n\nConteúdo' });
  });
  const options = { taskId: 'a', listId: '456', token: 'ficticio' };
  assert.equal((await getTicket(options)).summary, 'Conteúdo');
  listId = '789'; assert.equal(await getTicket(options), null);
  removed = true; assert.equal(await getTicket(options), null);
});

test('webhook e recuperação concorrentes enviam um aviso e mantêm checkpoint', async () => {
  const value = { id: 'a', createdAt: 1500, assignees: [] };
  const store = memoryStore(); const sent = [];
  const monitor = createTicketMonitor({ store, scope: 's', now: () => 1000, fetchTickets: async () => [value], fetchTicket: async () => value, sendNotification: async (ticket) => sent.push(ticket.id) });
  await monitor.initialize();
  await Promise.all([monitor.poll(), monitor.processTask('a'), monitor.processTask('a')]);
  assert.deepEqual(sent, ['a']);
  assert.equal((await store.read()).lastScan, 1000);
  await monitor.stop();
});

test('ampliação para todos os responsáveis preserva histórico sem enviar backlog antigo', async () => {
  const store = memoryStore({ version: 1, scope: 's', startedAt: 1000, lastScan: 2000, notifiedIds: ['enviado'] });
  const sent = [];
  const monitor = createTicketMonitor({ store, scope: 's', now: () => 3000, fetchTickets: async () => [{ id: 'antigo-ignorado', createdAt: 2500 }, { id: 'novo-sem-responsavel', createdAt: 3500 }], sendNotification: async (ticket) => sent.push(ticket.id) });
  await monitor.initialize(); await monitor.poll();
  assert.deepEqual(sent, ['novo-sem-responsavel']);
  assert.equal((await store.read()).startedAt, 1000);
  assert.equal((await store.read()).allTicketsSince, 3000);
  assert.deepEqual((await store.read()).notifiedIds, ['enviado', 'novo-sem-responsavel']);
  await monitor.stop();
});

test('cloudflared é iniciado e encerrado pelo bot; processo recebe apenas ambiente mínimo', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tasksbot-fake-tunnel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'fake-cloudflared');
  await writeFile(binary, `#!/usr/bin/env node\nif (process.env.DISCORD_TOKEN || process.env.CLICKUP_API_TOKEN) process.exit(1);\nconsole.error('https://teste.trycloudflare.com');\nconsole.error('Registered tunnel connection');\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const tunnel = await startLocalTunnel({ port: 3000, binary });
  assert.equal(tunnel.url, 'https://teste.trycloudflare.com');
  await tunnel.stop(); await tunnel.closed;
});
