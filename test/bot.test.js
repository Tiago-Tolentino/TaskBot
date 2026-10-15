import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Events } from 'discord.js';
import { readConfig } from '../src/config.js';
import { registerReadyEvent } from '../src/events/ready.js';
import { describeError } from '../src/services/errors.js';

const channelId = '123456789012345678';

function fixture() {
  const sent = [];
  const registrations = [];
  const channel = {
    guild: {
      name: 'Servidor de teste',
      commands: {
        create: async (data) => {
          registrations.push(data);
          return { id: 'command-id', name: data.name };
        },
      },
    },
    send: async (payload) => { sent.push(payload); return { id: 'message-id' }; },
  };
  const client = Object.assign(new EventEmitter(), {
    user: { tag: 'BotDeTeste' },
    channels: { fetch: async (id) => { assert.equal(id, channelId); return channel; } },
  });
  return { client, channel, sent, registrations };
}

test('configuração exige variáveis sem expor os valores', () => {
  assert.throws(() => readConfig({}), /DISCORD_TOKEN e CHANNEL_ID/);
  assert.throws(() => readConfig({ DISCORD_TOKEN: 'segredo' }), /CHANNEL_ID/);
  assert.throws(() => readConfig({ DISCORD_TOKEN: ' ', CHANNEL_ID: channelId }), /DISCORD_TOKEN/);
  assert.deepEqual(readConfig({ DISCORD_TOKEN: ' segredo ', CHANNEL_ID: ` ${channelId} ` }), {
    token: 'segredo', channelId,
  });
});

test('ID inválido é recusado antes da conexão', () => {
  for (const invalid of ['geral', '#123', '123', '0'.repeat(18), '9'.repeat(20)]) {
    assert.throws(() => readConfig({ DISCORD_TOKEN: 'segredo', CHANNEL_ID: invalid }), /CHANNEL_ID inválido/);
  }
});

test('inicialização e reconexões registram os comandos uma vez sem enviar mensagens', async () => {
  const { client, sent, registrations } = fixture();
  registerReadyEvent(client, channelId, (error) => assert.fail(describeError(error)));
  client.emit(Events.ClientReady, client);
  client.emit(Events.ClientReady, client);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(registrations.map((command) => command.name), ['test', 'ticket', 'help']);
  assert.equal(sent.length, 0);
  client.emit(Events.ClientReady, client);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registrations.length, 3);
  assert.equal(sent.length, 0);
});

test('falha de registro inicial aciona tratamento uma vez sem enviar mensagens', async () => {
  const { client, channel, sent } = fixture();
  const error = Object.assign(new Error('segredo'), { code: 50001 });
  channel.guild.commands.create = async () => { throw error; };
  const failures = [];
  registerReadyEvent(client, channelId, (received) => { failures.push(received); });
  client.emit(Events.ClientReady, client);
  await new Promise((resolve) => setImmediate(resolve));
  client.emit(Events.ClientReady, client);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, [error]);
  assert.equal(sent.length, 0);
});

test('erros externos nunca expõem mensagem ou token nos logs controlados', () => {
  for (const code of ['TokenInvalid', 4004, 401, 10003, 50001, 50013, 50083, 'ENOTFOUND', 'ETIMEDOUT', 'UNKNOWN']) {
    const result = describeError({ code, message: 'TOKEN_SECRETO', requestBody: { token: 'TOKEN_SECRETO' } });
    assert.equal(result.includes('TOKEN_SECRETO'), false);
    assert.ok(result.length > 0);
  }
  assert.match(describeError({ status: 401 }), /autenticação/);
});

test('npm start sem credenciais encerra com erro antes de conectar', () => {
  const result = spawnSync(process.execPath, ['src/index.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, DISCORD_TOKEN: '', CHANNEL_ID: '' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DISCORD_TOKEN e CHANNEL_ID/);
  assert.equal(result.stdout.includes('Conectando ao Discord'), false);
});
