import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { normalizeTicket } from '../src/integrations/clickup.js';
import { normalizeAttachments, prepareTicketAttachments } from '../src/services/ticketAttachments.js';
import { buildTicketNotification, sendTicketNotification } from '../src/services/ticketNotifications.js';

const rawFile = (id = 'a', overrides = {}) => ({ id, title: 'imagem.png', url: `https://t123.p.clickup-attachments.com/${id}`, size: 4, ...overrides });
const ticket = (count = 1) => ({ id: 'a', name: 'Ticket', status: 'to do', summary: 'Resumo', assignees: [], url: 'https://app.clickup.com/t/a', attachments: normalizeAttachments(Array.from({ length: count }, (_, i) => rawFile(String(i)))) });

test('normaliza anexos nativos, remove duplicatas, pastas, removidos e URLs inseguras', () => {
  const files = normalizeAttachments([rawFile(), rawFile(), rawFile('b', { deleted: true }), rawFile('c', { is_folder: true }), rawFile('d', { hidden: true }), rawFile('e', { url: 'file:///etc/passwd' }), rawFile('f', { url: 'https://127.0.0.1/private' })]);
  assert.equal(files.length, 1);
  const normalized = normalizeTicket({ id: 'a', name: 'A', attachments: [rawFile()], date_created: '1500' });
  assert.equal(normalized.attachments[0].name, 'imagem.png');
});

test('aviso tem botão persistente, links dos anexos e respeita limite total dos embeds', () => {
  const value = { ...ticket(40), name: 'a'.repeat(500), summary: '*'.repeat(5000), assignees: Array.from({ length: 40 }, (_, i) => ({ id: String(i), name: 'x'.repeat(100) })), status: 's'.repeat(500) };
  const payload = buildTicketNotification(value, 'list:channel');
  const embed = payload.embeds[0].toJSON();
  const size = embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  assert.ok(size <= 6000);
  assert.ok(embed.fields.find((field) => field.name === 'Anexos (40)').value.includes('abrir ticket'));
  assert.equal(payload.components[0].toJSON().components[0].custom_id, 'ticket:assign:a');
});

test('baixa arquivos sem Authorization, limpa nomes e mantém buffers em memória', async () => {
  const value = ticket(); value.attachments[0].name = '../nome\n.png';
  const result = await prepareTicketAttachments(value, { fetchFile: async (url, options) => {
    assert.equal(new URL(url).hostname, 't123.p.clickup-attachments.com');
    assert.equal(options.headers, undefined);
    assert.equal(options.redirect, 'manual');
    return new Response('data');
  } });
  assert.equal(result.files[0].attachment.toString(), 'data');
  assert.equal(result.files[0].name.includes('/'), false);
  assert.equal(result.files[0].name.includes('\n'), false);
  assert.equal(result.omitted, 0);
});

test('arquivos grandes e hosts externos não são baixados; respeita quantidade e total', async () => {
  let requests = 0;
  const value = ticket(15);
  value.attachments[0].size = 999999;
  value.attachments[1].downloadUrl = 'https://example.com/file';
  const result = await prepareTicketAttachments(value, { perFileLimit: 5, totalLimit: 12, fetchFile: async () => { requests++; return new Response('data'); } });
  assert.equal(result.files.length, 3);
  assert.equal(requests, 3);
  const capped = await prepareTicketAttachments(ticket(15), { fetchFile: async () => new Response('data') });
  assert.equal(capped.files.length, 10);
  assert.equal(capped.omitted, 5);
});

test('tamanho real do stream é limitado e redirecionamento local não é seguido', async () => {
  const tooLarge = await prepareTicketAttachments(ticket(), { perFileLimit: 4, fetchFile: async () => new Response('12345') });
  assert.equal(tooLarge.files.length, 0);
  let calls = 0;
  const redirected = await prepareTicketAttachments(ticket(), { fetchFile: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/.env' } }); } });
  assert.equal(calls, 1);
  assert.equal(redirected.omitted, 1);
});

test('falha de um download não impede envio dos demais e sem permissão mantém links', async () => {
  const result = await prepareTicketAttachments(ticket(2), { fetchFile: async (url) => { if (url.endsWith('/0')) throw new Error('segredo'); return new Response('data'); } });
  assert.equal(result.files.length, 1);
  const disabled = await prepareTicketAttachments(ticket(), { canAttach: false, fetchFile: () => assert.fail('Não deve baixar sem permissão.') });
  assert.equal(disabled.omitted, 1);
});

test('recuperação carrega detalhes e anexa arquivos à mesma mensagem do aviso', async () => {
  const sent = [];
  let details = 0;
  const channel = { guild: { members: { me: {} } }, permissionsFor: () => ({ has: (permission) => permission === PermissionFlagsBits.AttachFiles }), send: async (payload) => { sent.push(payload); return { id: 'm' }; } };
  const shallow = ticket(); delete shallow.attachments;
  await sendTicketNotification(channel, shallow, '12345:channel', {}, { fetchDetails: async (options) => { details++; assert.equal(options.listId, '12345'); return ticket(); }, prepareFiles: async () => ({ files: [{ attachment: Buffer.from('data'), name: 'arquivo.png' }], omitted: 0 }) });
  assert.equal(details, 1); assert.equal(sent.length, 1);
  assert.equal(sent[0].files.length, 1);
  assert.equal(sent[0].components.length, 1);
});

test('upload recusado usa links no mesmo aviso e falha de rede continua elegível à recuperação', async () => {
  const sent = [];
  const channel = { guild: { members: { me: {} } }, permissionsFor: () => ({ has: () => true }), send: async (payload) => { sent.push(payload); if (sent.length === 1) throw { code: 40005 }; return { id: 'm' }; } };
  const options = { prepareFiles: async () => ({ files: [{ attachment: Buffer.from('data'), name: 'arquivo.png' }], omitted: 0 }) };
  await sendTicketNotification(channel, ticket(), 'list:channel', {}, options);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].files.length, 0);
  assert.equal(sent[0].nonce, sent[1].nonce);
  assert.ok(sent[1].embeds[0].toJSON().fields.some((field) => field.name.startsWith('Anexos')));
  channel.send = async () => { throw new Error('rede'); };
  await assert.rejects(sendTicketNotification(channel, ticket(), 'list:channel', {}, options), /rede/);
});
