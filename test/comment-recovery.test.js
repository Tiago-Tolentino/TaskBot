import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getTicketCommentsSince } from '../src/integrations/clickup.js';
import { createCommentNotifications, createCommentRecoveryRequest, getCommentRecoveryTickets } from '../src/services/commentNotifications.js';
import { normalizeComment } from '../src/services/ticketComments.js';

const discordId = '345678901234567890';
const config = { listId: '12345', channelId: '234567890123456789', discordUserMap: { '11': discordId }, intervalMs: 600_000 };
const raw = (id, date = 1500, extra = {}) => ({ id, date: String(date), comment_text: `Comentário ${id}`, user: { username: 'Pessoa' }, reply_count: 0, ...extra });
const ticket = (id = 'a') => ({ id, name: 'Ticket antigo', status: 'to do', createdAt: 1, summary: 'Resumo',
  assignees: [{ id: '11', name: 'Pessoa' }], url: `https://app.clickup.com/t/${id}` });
const memoryStore = (initial = null) => {
  let state = structuredClone(initial);
  return { read: async () => structuredClone(state), write: async (next) => { state = structuredClone(next); } };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(t, overrides = {}, store = memoryStore()) {
  const sent = [];
  const service = await createCommentNotifications({ store, config, now: () => 1000,
    client: { users: { fetch: async () => ({ createDM: async () => ({}) }) } },
    fetchTicket: async ({ taskId }) => ticket(taskId), fetchRecoveryTickets: async () => [ticket()], fetchRecoveryComments: async () => [],
    deliver: async (_dm, _ticket, _scope, _map, options) => { sent.push(options.buildPayload().nonce); return { id: 'm' }; }, ...overrides,
  });
  t.after(() => service.stop());
  return { service, store, sent };
}

test('recuperação percorre páginas e busca resposta nova em um comentário pai antigo', async () => {
  const paths = [];
  const comments = await getTicketCommentsSince({ taskId: 'a', since: 1000, token: 'ficticio', request: async (path) => {
    paths.push(path);
    if (path === '/task/a/comment') return { comments: [raw('recente', 3000), raw('9999999999999999999', 500, { reply_count: 1 })] };
    if (path === '/comment/9999999999999999999/reply') return { comments: [raw('resposta', 2000, { attachments: [{ title: 'anexo.pdf', url: 'https://t123.p.clickup-attachments.com/f' }] }), raw('resposta-antiga', 999)] };
    const query = new URL('https://example.com' + path).searchParams;
    if (query.get('start_id') === '9999999999999999999') { assert.equal(query.get('start'), '500'); return { comments: [raw('pai-mais-antigo', 400, { reply_count: 1 })] }; }
    if (path === '/comment/pai-mais-antigo/reply') return { comments: [raw('resposta-mais-antiga', 1500)] };
    assert.equal(query.get('start_id'), 'pai-mais-antigo'); return { comments: [] };
  } });
  assert.deepEqual(comments.map((item) => item.id), ['resposta-mais-antiga', 'resposta', 'recente']);
  assert.equal(normalizeComment(comments[1]).attachments.length, 1);
  assert.equal(paths.length, 5);
});

test('data limite é inclusiva e IDs de comentários repetidos são removidos', async () => {
  let calls = 0;
  const comments = await getTicketCommentsSince({ taskId: 'a', since: 1000, request: async () => {
    calls++; return calls === 1 ? { comments: [raw('igual', 1000), raw('igual', 1000), raw('antes', 999)] } : { comments: [] };
  } });
  assert.deepEqual(comments.map((item) => item.id), ['igual']);
});

test('paginação repetida, comentário inválido e thread incompleta não viram recuperação completa', async () => {
  await assert.rejects(getTicketCommentsSince({ taskId: 'a', since: 1000, request: async () => ({ comments: [raw('repetido')] }) }), /repetiu uma página/);
  await assert.rejects(getTicketCommentsSince({ taskId: 'a', since: 1000, request: async () => ({ comments: [raw('inválido', 0)] }) }), /comentário inválido/);
  await assert.rejects(getTicketCommentsSince({ taskId: 'a', since: 1000, request: async (path) => path.includes('/reply') ? {} : { comments: [raw('pai', 500, { reply_count: 1 })] } }), /respostas de comentário inválidas/);
});

test('ticket removido não impede conclusão e cancelamento é encaminhado à API', async () => {
  const controller = new AbortController();
  const comments = await getTicketCommentsSince({ taskId: 'a', since: 1000, signal: controller.signal, request: async (_path, _token, signal) => {
    controller.abort(); assert.equal(signal.aborted, true); throw Object.assign(new Error(), { status: 404 });
  } });
  assert.deepEqual(comments, []);
});

test('candidatos abrangem responsáveis vinculados e não filtram criação ou atualização do ticket', async () => {
  const calls = [];
  const values = await getCommentRecoveryTickets({ config: { ...config, discordUserMap: { '11': discordId, '22': '456789012345678901' } },
    loadTickets: async (options) => { calls.push(options); return [ticket('comum'), ticket(options.assigneeId)]; },
  });
  assert.deepEqual(calls.map((call) => call.assigneeId), ['11', '22']);
  assert.ok(calls.every((call) => call.listId === config.listId && call.createdAfter === undefined && call.updatedAfter === undefined));
  assert.deepEqual(values.map((value) => value.id), ['comum', '11', '22']);
  assert.deepEqual(await getCommentRecoveryTickets({ config: { ...config, discordUserMap: {} }, loadTickets: () => assert.fail() }), []);
});

test('recupera comentário sem webhook e não repete os entregues por webhook', async (t) => {
  let clock = 1000;
  const f = await fixture(t, { now: () => clock, fetchRecoveryComments: async () => [raw('webhook'), raw('perdido', 1600), raw('antigo', 999)] });
  await f.service.enqueue([{ taskId: 'a', comment: normalizeComment(raw('webhook')) }]); await f.service.flush();
  clock = 2000; await f.service.poll(); await f.service.flush();
  await f.service.poll(); await f.service.flush();
  assert.equal(f.sent.length, 2);
  assert.deepEqual((await f.store.read()).completedIds.sort(), ['a:perdido', 'a:webhook']);
  assert.equal((await f.store.read()).lastRecovery, 2000);
});

test('webhook concorrente com recuperação usa a mesma fila e envia só uma vez', async (t) => {
  let release;
  const f = await fixture(t, { fetchRecoveryComments: () => new Promise((resolve) => { release = resolve; }) });
  const scan = f.service.poll(); while (!release) await tick();
  await f.service.enqueue([{ taskId: 'a', comment: normalizeComment(raw('simultaneo')) }]);
  release([raw('simultaneo')]); await scan; await f.service.flush();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.store.read()).pending.length, 0);
});

test('migração preserva início, histórico e progresso já salvo na fila', async (t) => {
  const store = memoryStore({ version: 1, scope: '12345:234567890123456789', startedAt: 1000,
    pending: [{ taskId: 'a', comment: normalizeComment(raw('pendente')), sent: [`${discordId}:0`], blocked: [] }], completedIds: ['a:concluido'] });
  const f = await fixture(t, { now: () => 5000, fetchRecoveryComments: async () => [raw('concluido'), raw('pendente')] }, store);
  let state = await store.read();
  assert.equal(state.startedAt, 1000); assert.equal(state.lastRecovery, 1000);
  assert.deepEqual(state.pending[0].sent, [`${discordId}:0`]);
  await f.service.poll(); await f.service.flush(); state = await store.read();
  assert.equal(f.sent.length, 0); assert.equal(state.pending.length, 0);
  assert.deepEqual(state.completedIds.sort(), ['a:concluido', 'a:pendente']);
});

test('reinício recupera o período offline com sobreposição, sem depender de ticket recém-criado', async (t) => {
  let clock = 1000;
  const first = await fixture(t, { now: () => clock }); clock = 1_000_000;
  await first.service.poll(); await first.service.stop();
  const queries = [];
  const next = await fixture(t, { now: () => 2_000_000, fetchRecoveryComments: async (options) => { queries.push(options); return [raw('offline', 1_500_000)]; } }, first.store);
  await next.service.poll(); await next.service.flush();
  assert.equal(queries[0].since, 940_000);
  assert.equal(next.sent.length, 1);
  assert.equal((await next.store.read()).startedAt, 1000);
});

test('erro em um ticket preserva checkpoint e permite processar os outros sem duplicá-los na repetição', async (t) => {
  let clock = 1000; let fails = true;
  const f = await fixture(t, { now: () => clock, fetchRecoveryTickets: async () => [ticket('a'), ticket('b')], fetchRecoveryComments: async ({ taskId }) => {
    if (taskId === 'a' && fails) throw new Error('API indisponível'); return [raw('c')];
  } });
  clock = 2000; await assert.rejects(f.service.poll()); await f.service.flush();
  assert.equal((await f.store.read()).lastRecovery, 1000); assert.equal(f.sent.length, 1);
  fails = false; await f.service.poll(); await f.service.flush();
  assert.equal((await f.store.read()).lastRecovery, 2000); assert.equal(f.sent.length, 2);
});

test('entrega pendente fica na fila mesmo quando checkpoint da consulta já avançou', async (t) => {
  let fails = true; let clock = 1000;
  const f = await fixture(t, { now: () => clock, fetchRecoveryComments: async () => [raw('c')], deliver: async () => { if (fails) throw new Error('Discord indisponível'); return { id: 'm' }; } });
  clock = 2000; await f.service.poll(); await f.service.flush();
  assert.equal((await f.store.read()).lastRecovery, 2000); assert.equal((await f.store.read()).pending.length, 1);
  fails = false; await f.service.flush();
  assert.deepEqual((await f.store.read()).completedIds, ['a:c']);
});

test('falha ao salvar checkpoint preserva mensagens já processadas', async (t) => {
  const store = memoryStore(); const save = store.write; let fail = true; let clock = 1000;
  store.write = async (state) => { if (state.lastRecovery === 2000 && fail) throw new Error('disco'); await save(state); };
  const f = await fixture(t, { now: () => clock, fetchRecoveryComments: async () => [raw('c')] }, store);
  clock = 2000; await assert.rejects(f.service.poll()); await f.service.flush();
  fail = false; await f.service.poll(); await f.service.flush();
  assert.equal(f.sent.length, 1); assert.equal((await store.read()).lastRecovery, 2000);
});

test('poll simultâneo é compartilhado; encerramento cancela recuperação sem avançar checkpoint', async (t) => {
  let entered;
  const f = await fixture(t, { fetchRecoveryTickets: ({ signal }) => new Promise((_resolve, reject) => {
    entered = true; signal.addEventListener('abort', () => reject(new Error('cancelado')), { once: true });
  }) });
  const first = f.service.poll(); const second = f.service.poll();
  assert.equal(first, second); assert.equal(entered, true);
  const rejected = assert.rejects(first);
  await f.service.stop(); await rejected;
  assert.equal((await f.store.read()).lastRecovery, 1000);
});

test('recuperação inicia com o serviço e repete no intervalo de dez minutos', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const f = await fixture(t, { fetchRecoveryTickets: async () => { calls++; return []; } });
  f.service.start(); await f.service.poll(); await tick();
  assert.equal(calls, 1);
  t.mock.timers.tick(599_999); await tick(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await tick(); assert.equal(calls, 2);
  await f.service.stop(); t.mock.timers.tick(600_000); await tick(); assert.equal(calls, 2);
});

test('consultas de recuperação são espaçadas e canceláveis', async () => {
  const pauses = []; const controller = new AbortController(); let calls = 0;
  const request = createCommentRecoveryRequest({ wait: async (ms, _value, options) => { pauses.push(ms); assert.equal(options.signal, controller.signal); }, request: async () => { calls++; } });
  await request('/primeira', 'ficticio', controller.signal); await request('/segunda', 'ficticio', controller.signal);
  assert.equal(calls, 2); assert.equal(pauses.length, 1); assert.ok(pauses[0] > 0 && pauses[0] <= 1000);
  controller.abort(); await assert.rejects(request('/terceira', 'ficticio', controller.signal)); assert.equal(calls, 2);
});
