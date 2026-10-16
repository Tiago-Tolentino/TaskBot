import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readNotificationConfig } from '../src/config.js';
import { createNotificationStore } from '../src/services/notificationState.js';
import { buildTicketNotification, createTicketMonitor, startTicketNotifications } from '../src/services/ticketNotifications.js';
import { getAllTickets } from '../src/integrations/clickup.js';

function fixture(overrides = {}) {
  let persisted = null;
  const sent = [];
  const store = { read: async () => structuredClone(persisted), write: async (state) => { persisted = structuredClone(state); } };
  const settings = {
    store, scope: 'list:channel', now: () => 1000,
    fetchTickets: async () => [], sendNotification: async (ticket) => sent.push(ticket.id), ...overrides,
  };
  return { monitor: createTicketMonitor(settings), settings, store, sent, state: () => persisted };
}

const ticket = (id, assignees = ['11'], createdAt = 1500) => ({
  id, createdAt, name: `Ticket ${id}`, status: 'to do', summary: 'Resumo do ticket.',
  url: `https://app.clickup.com/t/${id}`, assignees: assignees.map((id) => ({ id, name: `Pessoa ${id}` })),
});

test('avisos são opcionais e configuração valida canal e intervalo', () => {
  assert.equal(readNotificationConfig({}), null);
  const env = {
    TICKET_NOTIFICATIONS_ENABLED: 'true', TICKET_NOTIFICATION_CHANNEL_ID: '234567890123456789',
    CLICKUP_API_TOKEN: 'pk_ficticio', CLICKUP_TICKETS_LIST_ID: '12345',
  };
  assert.equal(readNotificationConfig(env).intervalMs, 600000);
  for (const invalid of [
    { TICKET_NOTIFICATION_CHANNEL_ID: 'geral' },
    { TICKET_NOTIFICATION_INTERVAL_SECONDS: '1' }, { TICKET_NOTIFICATION_INTERVAL_SECONDS: 'abc' }, { CLICKUP_API_TOKEN: '' },
  ]) assert.throws(() => readNotificationConfig({ ...env, ...invalid }));
});

test('estado é salvo atomicamente e arquivo corrompido não vira estado novo', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket-notifications-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = createNotificationStore(path);
  assert.equal(await store.read(), null);
  await store.write({ lastScan: 1000, notifiedIds: ['a'] });
  assert.deepEqual(await store.read(), { lastScan: 1000, notifiedIds: ['a'] });
  await writeFile(path, '{inválido');
  await assert.rejects(store.read(), /ler o estado/);
  assert.equal(await readFile(path, 'utf8'), '{inválido');
});

test('avisa todos os tickets novos, com qualquer responsável, uma única vez', async () => {
  const f = fixture({ fetchTickets: async () => [ticket('antigo', ['11'], 999), ticket('novo'), ticket('outro', ['44']), ticket('multiplo', ['11', '22', '33'])] });
  await f.monitor.initialize(); await f.monitor.poll(); await f.monitor.poll();
  assert.deepEqual(f.sent, ['novo', 'outro', 'multiplo']);
  assert.deepEqual(f.state().notifiedIds, ['novo', 'outro', 'multiplo']);
});

test('ticket novo sem responsável avisa imediatamente e atribuição posterior não repete', async () => {
  let assigned = [];
  const f = fixture({ fetchTickets: async () => [ticket('a', assigned)] });
  await f.monitor.initialize(); await f.monitor.poll();
  assert.deepEqual(f.sent, ['a']);
  assigned = ['22']; await f.monitor.poll(); await f.monitor.poll();
  assert.deepEqual(f.sent, ['a']);
});

test('reinício preserva avisos enviados e recupera novos tickets criados enquanto estava offline', async () => {
  const f = fixture({ fetchTickets: async () => [ticket('a')] });
  await f.monitor.initialize(); await f.monitor.poll(); await f.monitor.stop();
  const next = createTicketMonitor({ ...f.settings, now: () => 3000, fetchTickets: async () => [ticket('a'), ticket('offline', ['33'], 2500)] });
  await next.initialize(); await next.poll();
  assert.deepEqual(f.sent, ['a', 'offline']);
  assert.equal(f.state().startedAt, 1000);
});

test('falha de consulta ou envio não avança o checkpoint e permite nova tentativa', async () => {
  let apiFails = true; let sendFails = true;
  const sent = [];
  const f = fixture({ now: () => 1000,
    fetchTickets: async () => { if (apiFails) throw new Error('rede'); return [ticket('a')]; },
    sendNotification: async (ticket) => { if (sendFails) throw new Error('discord'); sent.push(ticket.id); },
  });
  await f.monitor.initialize(); await assert.rejects(f.monitor.poll());
  assert.equal(f.state().lastScan, 1000);
  apiFails = false; await assert.rejects(f.monitor.poll());
  assert.deepEqual(f.state().notifiedIds, []);
  sendFails = false; await f.monitor.poll(); await f.monitor.poll();
  assert.deepEqual(sent, ['a']);
});

test('estado incompatível não é substituído e data de criação ausente impede avanço', async () => {
  const broken = fixture({ store: { read: async () => ({ version: 99 }), write: async () => assert.fail('Não deve sobrescrever.') } });
  await assert.rejects(broken.monitor.initialize(), /Estado dos avisos inválido/);
  const f = fixture({ fetchTickets: async () => [ticket('a', ['11'], 0)] });
  await f.monitor.initialize(); await assert.rejects(f.monitor.poll(), /data de criação/);
  assert.equal(f.sent.length, 0);
});

test('consultas simultâneas são compartilhadas e interrupção cancela a requisição', async () => {
  let release; let queries = 0;
  const f = fixture({ fetchTickets: async ({ signal }) => {
    queries++;
    return new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new Error('abortado')), { once: true }); });
  } });
  await f.monitor.initialize();
  const first = f.monitor.poll(); const second = f.monitor.poll();
  assert.equal(first, second); await Promise.resolve(); assert.equal(queries, 1);
  release([]); await first;
  const pending = f.monitor.poll();
  await Promise.resolve();
  await f.monitor.stop(); await assert.rejects(pending);
  await f.monitor.poll(); assert.equal(queries, 2);
});

test('janela de atualização sobreposta parte do início da consulta, não do fim', async () => {
  let clock = 100000; const queries = [];
  const f = fixture({ now: () => clock, fetchTickets: async (filters) => { queries.push(filters); clock += 5000; return []; } });
  await f.monitor.initialize(); clock = 200000; await f.monitor.poll(); clock = 300000; await f.monitor.poll();
  assert.equal(queries[0].createdAfter, 99999);
  assert.equal(queries[1].updatedAfter, 140000);
  assert.equal(f.state().lastScan, 300000);
});

test('consulta incremental envia datas à API e preserva criação no ticket', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const query = new URL(url).searchParams;
    assert.equal(query.get('date_created_gt'), '1000'); assert.equal(query.get('date_updated_gt'), '2000');
    return Response.json({ tasks: query.get('archived') === 'true' ? [] : [{ id: 'a', name: 'A', date_created: '1500', assignees: [] }], last_page: true });
  });
  const tickets = await getAllTickets({ token: 'pk_test', listId: '12345', createdAfter: 1000, updatedAfter: 2000 });
  assert.equal(tickets[0].createdAt, 1500);
});

test('aviso usa nonce estável, respeita limites do embed e não dispara menções', () => {
  const payload = buildTicketNotification({ ...ticket('a', ['11', '22']), name: '😀'.repeat(200), summary: '*'.repeat(5000) }, 'list:channel');
  const embed = payload.embeds[0].toJSON();
  assert.ok(embed.title.length <= 256); assert.ok(embed.description.length <= 4096);
  assert.ok(embed.fields[1].value.includes('Pessoa 11')); assert.ok(embed.fields[1].value.includes('Pessoa 22'));
  assert.deepEqual(payload.allowedMentions, { parse: [] }); assert.equal(payload.enforceNonce, true);
  assert.equal(payload.nonce, buildTicketNotification(ticket('a'), 'list:channel').nonce);
  assert.notEqual(payload.nonce, buildTicketNotification(ticket('b'), 'list:channel').nonce);
});

test('canal inexistente ou sem permissão impede ativação antes de enviar avisos', async () => {
  await assert.rejects(startTicketNotifications({ channels: { fetch: async () => null } }, { channelId: 'channel' }), /canal de avisos/);
  const channel = { guild: { members: { me: {} } }, isSendable: () => true, isThread: () => false, permissionsFor: () => ({ has: () => false }) };
  await assert.rejects(startTicketNotifications({ channels: { fetch: async () => channel } }, { channelId: 'channel' }), /precisa de/);
});

test('mapeamento exige IDs entre aspas e mantém a precisão do ID Discord', () => {
  const env = {
    TICKET_NOTIFICATIONS_ENABLED: 'true', TICKET_NOTIFICATION_CHANNEL_ID: '234567890123456789',
    CLICKUP_API_TOKEN: 'pk_ficticio', CLICKUP_TICKETS_LIST_ID: '12345',
    TICKET_NOTIFICATION_DISCORD_USER_MAP: '{"12345678":"345678901234567890"}',
  };
  assert.deepEqual(readNotificationConfig(env).discordUserMap, { '12345678': '345678901234567890' });
  for (const value of ['{inválido', 'null', '[]', '{"12345678":345678901234567890}', '{"12345678":"@everyone"}', '{"12345678":"99999999999999999999"}']) {
    assert.throws(() => readNotificationConfig({ ...env, TICKET_NOTIFICATION_DISCORD_USER_MAP: value }), /DISCORD_USER_MAP/);
  }
});

test('marca Tiago uma única vez somente quando ele está atribuído, inclusive com outros responsáveis', () => {
  const mapping = { '12345678': '345678901234567890' };
  const payload = buildTicketNotification(ticket('a', ['22', '12345678', '12345678']), 'list:channel', mapping);
  assert.equal((payload.content.match(/<@345678901234567890>/g) || []).length, 1);
  assert.deepEqual(payload.allowedMentions, { parse: [], users: ['345678901234567890'] });
  const withoutTiago = buildTicketNotification(ticket('b', ['22', '33']), 'list:channel', mapping);
  assert.equal(withoutTiago.content.includes('<@'), false);
  assert.deepEqual(withoutTiago.allowedMentions, { parse: [] });
});

test('texto do ticket não autoriza menções adicionais e mapeamento não altera a deduplicação', () => {
  const value = { ...ticket('a', ['12345678']), name: '@everyone <@123456789012345678>', summary: '@here <@&123456789012345678>' };
  const payload = buildTicketNotification(value, 'list:channel', { '12345678': '345678901234567890' });
  assert.deepEqual(payload.allowedMentions, { parse: [], users: ['345678901234567890'] });
  assert.equal(payload.nonce, buildTicketNotification(value, 'list:channel').nonce);
});


test('IDs permitidos para atribuição são opcionais, validados e deduplicados', () => {
  const env = { TICKET_NOTIFICATIONS_ENABLED: 'true', TICKET_NOTIFICATION_CHANNEL_ID: '234567890123456789', CLICKUP_API_TOKEN: 'pk_ficticio', CLICKUP_TICKETS_LIST_ID: '12345' };
  assert.deepEqual(readNotificationConfig(env).assignmentAssigneeIds, []);
  assert.deepEqual(readNotificationConfig({ ...env, TICKET_ASSIGNMENT_ASSIGNEE_IDS: '11, 22,11,33' }).assignmentAssigneeIds, ['11', '22', '33']);
  for (const value of ['nome', '11,,22', '0', '999999999999999999999']) {
    assert.throws(() => readNotificationConfig({ ...env, TICKET_ASSIGNMENT_ASSIGNEE_IDS: value }), /TICKET_ASSIGNMENT_ASSIGNEE_IDS/);
  }
});
