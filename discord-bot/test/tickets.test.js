import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAllTickets } from '../src/integrations/clickup.js';
import { buildTicketPages } from '../src/services/ticketReply.js';
import { handleInteraction } from '../src/events/interactionCreate.js';

const config = { token: 'pk_ficticio', listId: '12345' };
const task = (id) => ({ id: String(id), name: `Ticket ${id}`, status: { status: 'aberto' } });

function mockPages(t, pages, archivedPages = [{ tasks: [], last_page: true }]) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = new URL(url);
    const page = Number(request.searchParams.get('page'));
    const archived = request.searchParams.get('archived') === 'true';
    calls.push({ page, archived });
    assert.equal(request.pathname, '/api/v2/list/12345/task');
    assert.equal(options.headers.Authorization, config.token);
    for (const key of ['include_closed', 'include_timl', 'subtasks']) {
      assert.equal(request.searchParams.get(key), 'true');
    }
    const payload = (archived ? archivedPages : pages)[page];
    assert.ok(payload, `Página inesperada: ${archived}/${page}`);
    return payload instanceof Response ? payload : Response.json(payload);
  });
  return calls;
}

function configureEnv(t) {
  for (const [key, value] of Object.entries({ CLICKUP_API_TOKEN: config.token, CLICKUP_TICKETS_LIST_ID: config.listId })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

test('busca todas as páginas e inclui o último ticket após os primeiros 200', async (t) => {
  const calls = mockPages(t, [
    { tasks: Array.from({ length: 100 }, (_, id) => task(id)), last_page: false },
    { tasks: Array.from({ length: 100 }, (_, id) => task(id + 100)), last_page: false },
    { tasks: [task(200), task(201)], last_page: true },
  ]);
  const tickets = await getAllTickets(config);
  assert.equal(tickets.length, 202);
  assert.equal(tickets.at(-1).name, 'Ticket 201');
  assert.equal(tickets.at(-1).status, 'aberto');
  assert.equal(tickets.at(-1).url, 'https://app.clickup.com/t/201');
  assert.deepEqual(calls, [
    { page: 0, archived: false }, { page: 1, archived: false },
    { page: 2, archived: false }, { page: 0, archived: true },
  ]);
});

test('página curta com last_page=false continua e ausência de marcador termina na página vazia', async (t) => {
  mockPages(t, [{ tasks: [task('a')], last_page: false }, { tasks: [task('b')] }, { tasks: [] }]);
  assert.equal((await getAllTickets(config)).length, 2);
});

test('inclui arquivados e remove duplicações por ID entre páginas e consultas', async (t) => {
  mockPages(t, [{ tasks: [task('a'), task('b')], last_page: true }], [
    { tasks: [task('b'), task('c')], last_page: false },
    { tasks: [task('d')], last_page: true },
  ]);
  assert.deepEqual((await getAllTickets(config)).map(({ id }) => id), ['a', 'b', 'c', 'd']);
});

test('erro em página posterior rejeita toda a listagem sem retornar resultado parcial', async (t) => {
  mockPages(t, [{ tasks: [task('a')], last_page: false }, new Response('segredo', { status: 500 })]);
  await assert.rejects(getAllTickets(config), /HTTP 500/);
});

test('página repetida ou conteúdo inválido falha em vez de confirmar lista incompleta', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ tasks: [task('a')], last_page: false }));
  await assert.rejects(getAllTickets(config), /repetiu uma página/);
  fetchMock.mock.restore();
  for (const data of [{}, { tasks: [null] }, { tasks: [{ id: 'a' }] }]) {
    const mocked = t.mock.method(globalThis, 'fetch', async () => Response.json(data));
    await assert.rejects(getAllTickets(config), /inválid/);
    mocked.mock.restore();
  }
});

test('ID de lista inválido impede requisição e lista vazia é retornada normalmente', async (t) => {
  const calls = mockPages(t, [{ tasks: [], last_page: true }]);
  await assert.rejects(getAllTickets({ ...config, listId: '../outra-lista' }), /CLICKUP_TICKETS_LIST_ID/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await getAllTickets(config), []);
});

test('lista pequena apresenta nome, status e link sem menções nem Markdown do título', () => {
  const [reply] = buildTicketPages([{ id: 'a', name: '**Ticket** @everyone\nLinha', status: 'em andamento', summary: 'Resumo do chamado.', url: 'https://app.clickup.com/t/a' }]);
  assert.match(reply.content, /em andamento/);
  assert.match(reply.content, /https:\/\/app.clickup.com\/t\/a/);
  assert.ok(reply.content.includes('\\*\\*Ticket\\*\\*'));
  assert.deepEqual(reply.allowedMentions, { parse: [] });
  assert.equal(reply.files, undefined);
  assert.match(reply.content, /Resumo do chamado/);
  assert.match(buildTicketPages([])[0].content, /Nenhum ticket/);
});

test('lista grande produz mensagens com todos os tickets sem arquivos', () => {
  const tickets = Array.from({ length: 250 }, (_, id) => ({ id: String(id), name: `Solicitação ${id}`, status: 'concluído', url: `https://app.clickup.com/t/${id}` }));
  const pages = buildTicketPages(tickets);
  assert.equal(pages.length, 250);
  assert.ok(pages.every((page) => page.content.length <= 2000 && !page.files));
  assert.ok(pages.at(-1).content.includes('Solicitação 249'));
  assert.ok(pages.at(-1).content.includes('https://app.clickup.com/t/249'));
});

test('/ticket adia a resposta antes da consulta e entrega o resultado no mesmo comando', async (t) => {
  configureEnv(t);
  mockPages(t, [{ tasks: [task('a')], last_page: true }]);
  const events = [];
  const interaction = {
    commandName: 'ticket', isChatInputCommand: () => true, replied: false, deferred: false,
    deferReply: async () => { events.push('defer'); interaction.deferred = true; },
    editReply: async (reply) => { events.push(reply); interaction.replied = true; },
  };
  await handleInteraction(interaction);
  assert.equal(events[0], 'defer');
  assert.equal(events.length, 2);
  assert.match(events[1].content, /Ticket a/);
  assert.match(events[1].content, /aberto/);
});

test('/ticket informa falha após deferReply sem divulgar tickets parciais ou credenciais', async (t) => {
  configureEnv(t);
  mockPages(t, [{ tasks: [task('ticket-confidencial')], last_page: false }, new Response(config.token, { status: 401 })]);
  const replies = [];
  const interaction = {
    commandName: 'ticket', isChatInputCommand: () => true, replied: false, deferred: false,
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (reply) => { replies.push(reply); },
    reply: async () => assert.fail('Não deve responder uma interação já adiada.'),
  };
  await handleInteraction(interaction);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /autenticação/);
  assert.equal(replies[0].content.includes('ticket-confidencial'), false);
  assert.equal(replies[0].content.includes(config.token), false);
  assert.deepEqual(replies[0].files, []);
});
