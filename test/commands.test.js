import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Events, MessageFlags } from 'discord.js';
import { handleInteraction, registerInteractionEvent } from '../src/events/interactionCreate.js';
import { registerCommands } from '../src/services/registerCommands.js';
import { commands } from '../src/commands/index.js';

function interaction(overrides = {}) {
  const replies = [];
  return {
    replies,
    commandName: 'test',
    isChatInputCommand: () => true,
    replied: false,
    deferred: false,
    reply: async (content) => { replies.push(content); },
    ...overrides,
  };
}

test('/test responde exatamente com a mensagem solicitada', async () => {
  const request = interaction();
  await handleInteraction(request);
  assert.deepEqual(request.replies, ['Teste realizado com sucesso!']);
});

test('/help lista todos os comandos registrados com explicações e exemplos dos filtros', async () => {
  const request = interaction({ commandName: 'help' });
  await handleInteraction(request);
  assert.equal(request.replies.length, 1);
  const reply = request.replies[0];
  assert.ok(reply.content.length <= 2000);
  for (const name of commands.keys()) assert.ok(reply.content.includes(`**/${name}**`));
  assert.ok(reply.content.includes('Teste realizado com sucesso!'));
  assert.ok(reply.content.includes('/ticket status:validando responsavel:Tiago'));
  assert.ok(reply.content.includes('selecione o status e o usuário'));
  assert.deepEqual(reply.allowedMentions, { parse: [] });
});

test('outros comandos e interações de botões não acionam /test', async () => {
  for (const request of [
    interaction({ commandName: 'outro' }),
    interaction({ isChatInputCommand: () => false }),
  ]) {
    await handleInteraction(request);
    assert.equal(request.replies.length, 0);
  }
});

test('falha de resposta é tratada com aviso privado sem encerrar o bot', async () => {
  const attempts = [];
  const request = interaction({
    reply: async (payload) => {
      attempts.push(payload);
      if (attempts.length === 1) throw { code: 50013 };
    },
  });
  await handleInteraction(request);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], {
    content: 'Não foi possível realizar o teste. Tente novamente.',
    flags: MessageFlags.Ephemeral,
  });
});

test('interação já respondida ou adiada não recebe segunda resposta inicial em caso de erro', async () => {
  for (const state of [{ replied: true }, { deferred: true }]) {
    let attempts = 0;
    const request = interaction({
      ...state,
      editReply: async () => {},
      reply: async () => { attempts++; throw { code: 40060 }; },
    });
    await handleInteraction(request);
    assert.equal(attempts, 1);
  }
});

test('falha também no aviso de erro não deixa uma rejeição sem tratamento', async () => {
  const request = interaction({ reply: async () => { throw { code: 10062 }; } });
  await assert.doesNotReject(handleInteraction(request));
});

test('listener encaminha cada execução de /test para uma resposta', async () => {
  const client = new EventEmitter();
  registerInteractionEvent(client);
  const first = interaction();
  const second = interaction();
  client.emit(Events.InteractionCreate, first);
  client.emit(Events.InteractionCreate, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(first.replies, ['Teste realizado com sucesso!']);
  assert.deepEqual(second.replies, ['Teste realizado com sucesso!']);
});

test('registra /test, /ticket e /help sem substituir outros comandos do servidor', async () => {
  const created = [];
  const client = {
    channels: {
      fetch: async (id) => {
        assert.equal(id, '123456789012345678');
        return {
          guild: {
            name: 'Servidor de teste',
            commands: {
              create: async (data) => { created.push(data); return { id: 'command-id', name: data.name }; },
              set: () => assert.fail('Não deve substituir todos os comandos.'),
            },
          },
        };
      },
    },
  };
  const result = await registerCommands(client, '123456789012345678');
  assert.equal(result.length, 3);
  assert.deepEqual(created.map((command) => command.name), ['test', 'ticket', 'help']);
  assert.ok(created.every((command) => command.type === 1));
});

test('registro exige um canal de servidor acessível', async () => {
  for (const channel of [null, {}]) {
    await assert.rejects(
      registerCommands({ channels: { fetch: async () => channel } }, '123456789012345678'),
      /localizar o servidor/,
    );
  }
});

test('falha de registro é propagada ao tratamento da inicialização', async () => {
  const error = { code: 50001 };
  const client = {
    channels: { fetch: async () => ({ guild: { commands: { create: async () => { throw error; } } } }) },
  };
  await assert.rejects(registerCommands(client, '123456789012345678'), (received) => received === error);
});
