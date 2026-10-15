import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { getAllTickets, loadTicketFilterOptions } from '../src/integrations/clickup.js';
import { buildFilterSuggestions, createTicketFilterProvider, resolveTicketFilters } from '../src/services/ticketFilters.js';
import { extractTicketSummary } from '../src/services/ticketSummary.js';
import { buildTicketPages, sendTicketReply } from '../src/services/ticketReply.js';
import { handleInteraction } from '../src/events/interactionCreate.js';
import { data as ticketCommand } from '../src/commands/ticket.js';

const available = {
  statuses: ['to do', 'in progress', 'em execução', 'validando', 'complete'],
  users: [{ id: '11', name: 'Tiago' }, { id: '22', name: 'Guilherme Sélis Barros' }],
};
const options = (values) => ({ getString: (name) => values[name] || null });

function configure(t) {
  for (const [key, value] of Object.entries({ CLICKUP_API_TOKEN: 'pk_filters', CLICKUP_TICKETS_LIST_ID: '12345', CLICKUP_WORKSPACE_ID: '900' })) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
}

test('status e responsável são opcionais e possuem autocomplete no mesmo comando', () => {
  const definition = ticketCommand.toJSON();
  assert.deepEqual(definition.options.map(({ name }) => name), ['status', 'responsavel']);
  assert.ok(definition.options.every((option) => !option.required && option.autocomplete));
  assert.deepEqual(resolveTicketFilters(options({}), available), { status: undefined, assigneeId: undefined, assigneeName: undefined });
  assert.equal(resolveTicketFilters(options({ status: 'EM EXECUCAO' }), available).status, 'em execução');
  assert.equal(resolveTicketFilters(options({ responsavel: '22' }), available).assigneeName, 'Guilherme Sélis Barros');
  assert.deepEqual(resolveTicketFilters(options({ status: 'validando', responsavel: '11' }), available), { status: 'validando', assigneeId: '11', assigneeName: 'Tiago' });
  assert.throws(() => resolveTicketFilters(options({ responsavel: 'Tiago' }), available), /Selecione o usuário/);
  assert.throws(() => resolveTicketFilters(options({ status: 'desconhecido' }), available), /Status inválido/);
});

test('sugestões usam nomes reais, ignoram acentos e retornam o ID do usuário', () => {
  assert.deepEqual(buildFilterSuggestions(available, 'responsavel', 'selis'), [{ name: 'Guilherme Sélis Barros (22)', value: '22' }]);
  assert.equal(buildFilterSuggestions(available, 'status', 'EXECUCAO')[0].value, 'em execução');
  assert.deepEqual(buildFilterSuggestions(available, 'responsavel', 'ninguém'), []);
  const many = { statuses: [], users: Array.from({ length: 40 }, (_, id) => ({ id: String(id), name: 'Pessoa'.repeat(30) })) };
  const choices = buildFilterSuggestions(many, 'responsavel', '');
  assert.equal(choices.length, 25);
  assert.ok(choices.every((choice) => choice.name.length <= 100));
});

test('carrega membros do workspace, incluindo quem acessa a lista por herança', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.endsWith('/list/12345')) return Response.json({ statuses: available.statuses.map((status) => ({ status })) });
    assert.ok(url.endsWith('/team'));
    return Response.json({ teams: [{ id: '900', members: available.users.map(({ id, name }) => ({ user: { id: Number(id), username: name } })) }] });
  });
  const result = await loadTicketFilterOptions({ token: 'pk_test', listId: '12345', workspaceId: '900' });
  assert.deepEqual(result.statuses, available.statuses);
  assert.deepEqual(result.users.map((user) => user.id).sort(), ['11', '22']);
});

test('cache compartilha chamadas simultâneas, expira e permite nova tentativa após falha', async (t) => {
  let time = 1000; t.mock.method(Date, 'now', () => time);
  let calls = 0;
  const provider = createTicketFilterProvider(async () => { calls++; return available; });
  await Promise.all([provider(), provider()]); await provider();
  assert.equal(calls, 1);
  time += 5 * 60_000 + 1; await provider();
  assert.equal(calls, 2);
  let attempts = 0;
  const retry = createTicketFilterProvider(async () => { if (++attempts === 1) throw new Error('falha'); return available; });
  await assert.rejects(retry());
  assert.equal(await retry(), available);
});

test('consulta status, responsável ou ambos em todas as páginas e exige a combinação', async (t) => {
  const tasks = [
    { id: 'a', name: 'A', status: { status: 'validando' }, assignees: [{ id: 11, username: 'Tiago' }, { id: 22, username: 'Guilherme' }], text_content: 'Resumo\n\nUm resumo.\n\nCliente\nNão incluir.' },
    { id: 'b', name: 'B', status: { status: 'complete' }, assignees: [{ id: 11, username: 'Tiago' }] },
    { id: 'c', name: 'C', status: { status: 'validando' }, assignees: [] },
  ];
  for (const [filters, expected] of [[{}, ['a', 'b', 'c']], [{ status: 'validando' }, ['a', 'c']], [{ assigneeId: '22' }, ['a']], [{ status: 'validando', assigneeId: '11' }, ['a']]]) {
    const calls = [];
    const mocked = t.mock.method(globalThis, 'fetch', async (url) => {
      const params = new URL(url).searchParams; calls.push(params);
      assert.equal(params.get('statuses[]'), filters.status || null);
      assert.equal(params.get('assignees[]'), filters.assigneeId || null);
      const page = Number(params.get('page'));
      return Response.json(params.get('archived') === 'true'
        ? { tasks: [], last_page: true }
        : { tasks: page === 0 ? tasks.slice(0, 1) : tasks.slice(1), last_page: page === 1 });
    });
    const result = await getAllTickets({ token: 'pk_test', listId: '12345', ...filters });
    assert.deepEqual(result.map(({ id }) => id), expected);
    assert.equal(calls.length, 3);
    assert.equal(result[0].summary, 'Um resumo.');
    mocked.mock.restore();
  }
});

test('extrai apenas Resumo e preserva parágrafos, com alternativas para descrição vazia', () => {
  assert.equal(extractTicketSummary({ text_content: 'Resumo\n\nTexto A.\n\nTexto B.\n\n↗ Abrir conversa original no Intercom\nCliente\nDados pessoais' }), 'Texto A.\n\nTexto B.');
  assert.equal(extractTicketSummary({ description: '## Resumo\nConteúdo\n## Cliente\nOutro conteúdo' }), 'Conteúdo');
  assert.equal(extractTicketSummary({ description: '**Resumo**: Texto inline\n\nSituação\nOutros dados' }), 'Texto inline');
  assert.equal(extractTicketSummary({ description: 'Descrição simples.' }), 'Descrição simples.');
  assert.equal(extractTicketSummary({}), 'Resumo não informado.');
});

test('resumo longo é preservado inteiro em páginas válidas, sem TXT', () => {
  const summary = ('texto com emoji 😀 e acento ç '.repeat(300)) + 'FIM-DO-RESUMO';
  const ticket = { name: 'Título', status: 'validando', assignees: [{ name: 'Tiago' }], summary, url: 'https://app.clickup.com/t/a' };
  const pages = buildTicketPages([ticket], { status: 'validando', assigneeName: 'Tiago' });
  assert.ok(pages.length > 1);
  assert.ok(pages.every((page) => page.content.length <= 2000 && !page.files));
  const body = pages.map(({ content }) => content.split('\n\n').slice(1).join('\n\n').replace(/\n\nPágina \d+\/\d+$/, '')).join('');
  assert.ok(body.includes(summary));
});

test('botões navegam em todas as páginas, somente pelo autor, e expiram', async () => {
  const collector = new EventEmitter(); const updates = []; const edits = [];
  const message = { createMessageComponentCollector: () => collector, edit: async (payload) => edits.push(payload) };
  const interaction = { user: { id: 'autor' }, editReply: async (payload) => { updates.push(payload); return message; } };
  await sendTicketReply(interaction, [1, 2].map((id) => ({ name: `Ticket ${id}`, status: 'aberto', summary: 'Resumo.', url: `https://app.clickup.com/t/${id}` })));
  assert.match(updates[0].content, /Ticket 1/);
  const next = { customId: 'ticket:next', user: { id: 'autor' }, update: async (payload) => updates.push(payload) };
  collector.emit('collect', next); await new Promise(setImmediate);
  assert.match(updates.at(-1).content, /Ticket 2/);
  assert.equal(updates.at(-1).components[0].toJSON().components[1].disabled, true);
  const rejected = [];
  collector.emit('collect', { ...next, user: { id: 'outro' }, reply: async (payload) => rejected.push(payload) }); await new Promise(setImmediate);
  assert.equal(rejected.length, 1); assert.equal(updates.length, 2);
  collector.emit('collect', { ...next, customId: 'ticket:previous' }); await new Promise(setImmediate);
  assert.match(updates.at(-1).content, /Ticket 1/);
  collector.emit('end'); await new Promise(setImmediate);
  assert.deepEqual(edits, [{ components: [] }]);
});

test('autocomplete é atendido pelo evento e os dois filtros chegam à execução', async (t) => {
  configure(t);
  const queries = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.endsWith('/list/12345')) return Response.json({ statuses: available.statuses.map((status) => ({ status })) });
    if (url.endsWith('/team')) return Response.json({ teams: [{ id: '900', members: available.users.map(({ id, name }) => ({ user: { id, username: name } })) }] });
    const params = new URL(url).searchParams; queries.push(params);
    return Response.json({ tasks: [{ id: 'a', name: 'Ticket filtrado', status: { status: 'validando' }, assignees: [{ id: 11, username: 'Tiago' }], text_content: 'Resumo\nTexto resumido.' }], last_page: true });
  });
  const suggestions = [];
  await handleInteraction({ commandName: 'ticket', isAutocomplete: () => true, options: { getFocused: () => ({ name: 'responsavel', value: 'tia' }) }, respond: async (choices) => suggestions.push(choices) });
  assert.equal(suggestions[0][0].value, '11');
  const replies = [];
  const interaction = { commandName: 'ticket', isChatInputCommand: () => true, options: options({ status: 'validando', responsavel: '11' }), deferReply: async () => {}, editReply: async (reply) => { replies.push(reply); } };
  await handleInteraction(interaction);
  assert.ok(queries.every((params) => params.get('statuses[]') === 'validando' && params.get('assignees[]') === '11'));
  assert.match(replies[0].content, /Texto resumido/);
  assert.match(replies[0].content, /Responsável: Tiago/);
  assert.equal(replies[0].files, undefined);
});
