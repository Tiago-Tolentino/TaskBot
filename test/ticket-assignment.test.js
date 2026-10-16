import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addTicketAssignee } from '../src/integrations/clickup.js';
import { createTicketAssignmentHandler } from '../src/services/ticketAssignment.js';
import { handleInteraction } from '../src/events/interactionCreate.js';

const config = { channelId: '234567890123456789', listId: '12345', discordUserMap: {}, assignmentAssigneeIds: ['11', '22', '30', '32'] };
const currentTicket = { id: 'a', name: 'A', status: 'to do', summary: 'Resumo', url: 'https://app.clickup.com/t/a', assignees: [{ id: '11', name: 'Atual' }, { id: '22', name: 'Novo' }] };

function fixture(overrides = {}) {
  const users = Array.from({ length: 32 }, (_, i) => ({ id: String(i + 1), name: `Pessoa ${i + 1}` }));
  const assignments = [];
  const edits = [];
  const handler = createTicketAssignmentHandler({ getConfig: () => config, loadUsers: async () => users, assign: async (options) => { assignments.push(options); return { ticket: currentTicket, alreadyAssigned: false }; }, ...overrides });
  const message = { author: { id: 'bot' }, edit: async (payload) => edits.push(payload) };
  function request(customId = 'ticket:assign:a', extra = {}) {
    const replies = [];
    const interaction = { customId, channelId: config.channelId, guildId: 'guild', client: { user: { id: 'bot' } }, user: { id: 'actor' }, message,
      isButton: () => !customId.startsWith('ticket:assignee:'), isStringSelectMenu: () => customId.startsWith('ticket:assignee:'),
      deferred: false, replied: false, replies,
      deferReply: async () => { interaction.deferred = true; }, deferUpdate: async () => { interaction.deferred = true; },
      reply: async (payload) => { interaction.replied = true; replies.push(payload); },
      editReply: async (payload) => replies.push(payload), update: async (payload) => replies.push(payload), ...extra };
    return interaction;
  }
  return { handler, request, users, assignments, edits };
}

test('menu mostra somente os quatro responsáveis autorizados em um seletor', async () => {
  const f = fixture(); const open = f.request();
  assert.equal(await f.handler(open), true);
  const reply = open.replies[0];
  assert.equal(reply.components.length, 1);
  const menu = reply.components[0].toJSON().components[0];
  assert.equal(menu.type, 3);
  assert.deepEqual(menu.options.map((user) => user.value), ['11', '22', '30', '32']);
  assert.equal(reply.content.includes('Página'), false);
});

test('ordem alfabética respeita acentos e não prioriza usuários com Discord vinculado', async () => {
  const users = [{ id: '11', name: 'Zélia' }, { id: '22', name: 'Bruno' }, { id: '30', name: 'Álvaro' }, { id: '32', name: 'Carlos' }, { id: '99', name: 'Ana não autorizada' }];
  const f = fixture({ loadUsers: async () => users, getConfig: () => ({ ...config, discordUserMap: { '11': '345678901234567890' } }) });
  const open = f.request(); await f.handler(open);
  const options = open.replies[0].components[0].toJSON().components[0].options;
  assert.deepEqual(options.map((user) => user.label), ['Álvaro', 'Bruno', 'Carlos', 'Zélia']);
  assert.equal(new Set(options.map((user) => user.value)).size, 4);
});

test('usuário existente no workspace mas não autorizado não pode ser atribuído', async () => {
  const f = fixture(); const open = f.request(); await f.handler(open);
  const menu = open.replies[0].components[0].toJSON().components[0];
  await f.handler(f.request(menu.custom_id, { values: ['1'] }));
  assert.equal(f.assignments.length, 0);
});

test('sem responsáveis autorizados o botão não oferece usuários do workspace', async () => {
  const f = fixture({ getConfig: () => ({ ...config, assignmentAssigneeIds: [] }) });
  const open = f.request(); await f.handler(open);
  assert.equal(open.replies[0].components, undefined);
  assert.ok(open.replies[0].content.includes('Nenhum responsável autorizado'));
});

test('autorização removida depois de abrir o menu é revalidada antes da atribuição', async () => {
  let allowed = ['22'];
  const f = fixture({ getConfig: () => ({ ...config, assignmentAssigneeIds: allowed }) });
  const open = f.request(); await f.handler(open);
  const menu = open.replies[0].components[0].toJSON().components[0];
  allowed = [];
  await f.handler(f.request(menu.custom_id, { values: ['22'] }));
  assert.equal(f.assignments.length, 0);
});

test('seleção adiciona no ClickUp, atualiza aviso e não remove arquivos nem repete menções', async () => {
  const f = fixture(); const open = f.request(); await f.handler(open);
  const customId = open.replies[0].components[0].toJSON().components[0].custom_id;
  const selection = f.request(customId, { values: ['22'] });
  await f.handler(selection);
  assert.deepEqual(f.assignments, [{ taskId: 'a', assigneeId: '22', listId: '12345' }]);
  assert.equal(f.edits.length, 1);
  assert.equal(f.edits[0].files, undefined);
  assert.equal(f.edits[0].attachments, undefined);
  assert.deepEqual(f.edits[0].allowedMentions, { parse: [] });
  assert.ok(selection.replies[0].content.includes('adicionado como responsável'));
  const replay = f.request(customId, { values: ['22'] }); await f.handler(replay);
  assert.equal(f.assignments.length, 1);
});

test('seleção de outra pessoa, expirada ou com usuário inválido não altera ticket', async () => {
  let clock = 0;
  const f = fixture({ now: () => clock }); const open = f.request(); await f.handler(open);
  const customId = open.replies[0].components[0].toJSON().components[0].custom_id;
  await f.handler(f.request(customId, { values: ['22'], user: { id: 'other' } }));
  await f.handler(f.request(customId, { values: ['99999'] }));
  clock = 600000;
  await f.handler(f.request(customId, { values: ['22'] }));
  assert.equal(f.assignments.length, 0);
});

test('botão persistente funciona com handler novo; canal e autor incorretos são recusados', async () => {
  const f = fixture();
  await f.handler(f.request('ticket:assign:a', { channelId: 'outro' }));
  await f.handler(f.request('ticket:assign:a', { message: { author: { id: 'outro-bot' } } }));
  assert.equal(f.assignments.length, 0);
  const open = f.request(); await f.handler(open);
  assert.equal(open.replies[0].components.length, 1);
});

test('falha ao editar aviso informa sucesso no ClickUp sem repetir a atribuição', async () => {
  const f = fixture(); const open = f.request(); await f.handler(open);
  open.message.edit = async () => { throw new Error('discord'); };
  const select = f.request(open.replies[0].components[0].toJSON().components[0].custom_id, { values: ['22'] });
  await f.handler(select);
  assert.equal(f.assignments.length, 1);
  assert.ok(select.replies[0].content.includes('não foi possível atualizar o aviso'));
});

test('API usa atualização aditiva e confirma o responsável preservando os atuais', async (t) => {
  let assigned = false; const methods = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.clickup.com/api/v2/task/a'); methods.push(options.method);
    if (options.method === 'PUT') {
      assert.deepEqual(JSON.parse(options.body), { assignees: { add: [22] } });
      assigned = true; return Response.json({});
    }
    return Response.json({ id: 'a', name: 'A', list: { id: '12345' }, assignees: [{ id: 11, username: 'Atual' }, ...(assigned ? [{ id: 22, username: 'Novo' }] : [])] });
  });
  const options = { taskId: 'a', assigneeId: '22', listId: '12345', token: 'pk_ficticio' };
  const result = await addTicketAssignee(options);
  assert.deepEqual(result.ticket.assignees.map((user) => user.id), ['11', '22']);
  assert.deepEqual(methods, ['GET', 'PUT', 'GET']);
  assert.equal((await addTicketAssignee(options)).alreadyAssigned, true);
  assert.deepEqual(methods, ['GET', 'PUT', 'GET', 'GET']);
});

test('ticket fora da lista ou responsável inválido nunca gera escrita na API', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => { calls.push(options.method); return Response.json({ id: 'a', name: 'A', list: { id: 'outra' }, assignees: [] }); });
  await assert.rejects(addTicketAssignee({ taskId: 'a', assigneeId: '22', listId: '12345', token: 'pk_ficticio' }), /lista configurada/);
  await assert.rejects(addTicketAssignee({ taskId: 'a', assigneeId: '999999999999999999999', listId: '12345', token: 'pk_ficticio' }), /responsável válido/);
  assert.deepEqual(calls, ['GET']);
});

test('API que não confirma a atribuição não produz sucesso', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => options.method === 'PUT' ? Response.json({})
    : Response.json({ id: 'a', name: 'A', list: { id: '12345' }, assignees: [] }));
  await assert.rejects(addTicketAssignee({ taskId: 'a', assigneeId: '22', listId: '12345', token: 'pk_ficticio' }), /não confirmou/);
});

test('duplo clique durante processamento não repete a atribuição', async () => {
  let release; let calls = 0;
  const f = fixture({ assign: async () => { calls++; await new Promise((resolve) => { release = resolve; }); return { ticket: currentTicket }; } });
  const open = f.request(); await f.handler(open);
  const customId = open.replies[0].components[0].toJSON().components[0].custom_id;
  const pending = f.handler(f.request(customId, { values: ['22'] }));
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const repeated = f.request(customId, { values: ['22'] }); await f.handler(repeated);
  assert.ok(repeated.replies[0].content.includes('já está sendo processada'));
  release(); await pending;
  assert.equal(calls, 1);
});

test('roteamento global trata o botão antes dos comandos e ignora navegação de /ticket', async () => {
  let reply;
  await handleInteraction({ customId: 'ticket:assign:a', isButton: () => true, isChatInputCommand: () => assert.fail('Não deve executar comando.'), reply: async (payload) => { reply = payload; } });
  assert.ok(reply.content.includes('canal de tickets'));
  const f = fixture();
  assert.equal(await f.handler(f.request('ticket:next')), false);
});
