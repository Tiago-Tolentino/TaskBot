import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAssignmentDm, notifyTicketAssignee } from '../src/services/ticketAssignmentDm.js';
import { buildTicketNotification, sendTicketNotification } from '../src/services/ticketNotifications.js';
import { readNotificationConfig } from '../src/config.js';

const discordId = '345678901234567890';
const config = { assignmentDmEnabled: true, discordUserMap: { '22': discordId }, listId: '12345', channelId: '234567890123456789' };
const ticket = { id: 'a', name: 'Ticket @everyone', status: 'in progress', summary: 'Resumo do ticket', url: 'https://app.clickup.com/t/a',
  assignees: [{ id: '11', name: 'Atual' }, { id: '22', name: 'Pessoa vinculada' }],
  attachments: [{ id: 'f', name: 'arquivo.pdf', url: 'https://t123.p.clickup-attachments.com/f', downloadUrl: 'https://t123.p.clickup-attachments.com/f', size: 4 }] };

test('privado mantém informações e anexos do aviso, sem botão de atribuição ou menções', () => {
  const dm = buildAssignmentDm(ticket, 'list:channel', discordId, 'assignment-a');
  const channel = buildTicketNotification(ticket, 'list:channel');
  const embed = dm.embeds[0].toJSON();
  const original = channel.embeds[0].toJSON();
  for (const field of ['title', 'url', 'description', 'fields']) assert.deepEqual(embed[field], original[field]);
  assert.ok(dm.content.includes('adicionado como responsável'));
  assert.deepEqual(dm.allowedMentions, { parse: [] });
  const button = dm.components[0].toJSON().components[0];
  assert.equal(button.url, ticket.url);
  assert.equal(button.custom_id, undefined);
  assert.equal(dm.enforceNonce, true);
  assert.notEqual(dm.nonce, channel.nonce);
  assert.equal(dm.nonce, buildAssignmentDm(ticket, 'list:channel', discordId, 'assignment-a').nonce);
  assert.notEqual(dm.nonce, buildAssignmentDm(ticket, 'list:channel', discordId, 'assignment-b').nonce);
});

test('envia somente ao Discord mapeado para o responsável confirmado', async () => {
  const recipients = [];
  const channel = { isDMBased: () => true };
  const client = { users: { fetch: async (id) => { recipients.push(id); return { createDM: async () => channel }; } } };
  const result = await notifyTicketAssignee({ client, ticket, assigneeId: '22', config, assignmentId: 'event-a' }, {
    deliver: async (target, value, scope, map, options) => {
      assert.equal(target, channel); assert.equal(value, ticket);
      assert.equal(scope, '12345:234567890123456789');
      assert.deepEqual(map, {});
      assert.ok(options.buildPayload(value, scope).content.includes('responsável'));
      return { id: 'message-a' };
    },
  });
  assert.deepEqual(recipients, [discordId]);
  assert.deepEqual(result, { status: 'sent', messageId: 'message-a' });
});

test('sem vínculo, desativado ou sem atribuição confirmada não abre privado nem baixa anexos', async () => {
  const client = { users: { fetch: () => assert.fail('Não deve contatar usuários.') } };
  const options = { client, ticket, assigneeId: '22', config, assignmentId: 'event-a' };
  assert.equal((await notifyTicketAssignee({ ...options, assigneeId: '11' })).status, 'unmapped');
  assert.equal((await notifyTicketAssignee({ ...options, config: { ...config, assignmentDmEnabled: false } })).status, 'disabled');
  assert.equal((await notifyTicketAssignee({ ...options, ticket: { ...ticket, assignees: [] } })).status, 'not-assigned');
});

test('Discord bloqueado ou erro externo retorna falha controlada sem propagar dados sensíveis', async () => {
  for (const code of [50007, 50013, 'ECONNRESET']) {
    const client = { users: { fetch: async () => ({ createDM: async () => ({}) }) } };
    const result = await notifyTicketAssignee({ client, ticket, assigneeId: '22', config, assignmentId: 'event-a' }, {
      deliver: async () => { throw Object.assign(new Error('TOKEN_SECRETO'), { code }); },
    });
    assert.equal(result.status, code === 50007 ? 'blocked' : 'failed');
    assert.equal(JSON.stringify(result).includes('TOKEN_SECRETO'), false);
  }
});

test('envio reutiliza anexos em DM sem depender de guilda ou permissões de canal do servidor', async () => {
  const sent = [];
  const channel = { isDMBased: () => true, send: async (payload) => { sent.push(payload); return { id: 'm' }; } };
  await sendTicketNotification(channel, ticket, '12345:channel', {}, {
    buildPayload: (value, scope) => buildAssignmentDm(value, scope, discordId, 'event-a'),
    prepareFiles: async (_ticket, options) => { assert.equal(options.canAttach, true); return { files: [{ attachment: Buffer.from('data'), name: 'arquivo.pdf' }], omitted: 0 }; },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].files[0].name, 'arquivo.pdf');
  assert.ok(sent[0].content.includes('adicionado como responsável'));
});

test('upload recusado na DM mantém as informações e os links', async () => {
  const sent = [];
  const channel = { isDMBased: () => true, send: async (payload) => { sent.push(payload); if (sent.length === 1) throw { code: 40005 }; return { id: 'm' }; } };
  await sendTicketNotification(channel, ticket, '12345:channel', {}, {
    buildPayload: (value, scope) => buildAssignmentDm(value, scope, discordId, 'event-a'),
    prepareFiles: async () => ({ files: [{ attachment: Buffer.from('data'), name: 'arquivo.pdf' }], omitted: 0 }),
  });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].files, []);
  assert.equal(sent[0].nonce, sent[1].nonce);
  assert.ok(sent[1].embeds[0].toJSON().fields.some((field) => field.name === 'Anexos (1)'));
});

test('aviso privado é desativado por padrão e ativado explicitamente na configuração', () => {
  const env = { TICKET_NOTIFICATIONS_ENABLED: 'true', TICKET_NOTIFICATION_CHANNEL_ID: '234567890123456789', CLICKUP_API_TOKEN: 'pk_ficticio', CLICKUP_TICKETS_LIST_ID: '12345' };
  assert.equal(readNotificationConfig(env).assignmentDmEnabled, false);
  assert.equal(readNotificationConfig({ ...env, TICKET_ASSIGNMENT_DM_ENABLED: 'true' }).assignmentDmEnabled, true);
  assert.equal(readNotificationConfig({ ...env, TICKET_ASSIGNMENT_DM_ENABLED: 'false' }).assignmentDmEnabled, false);
});
