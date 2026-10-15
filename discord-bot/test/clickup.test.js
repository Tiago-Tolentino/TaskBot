import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ClickUpError, getAuthorizedUser } from '../src/integrations/clickup.js';

test('token vazio impede consulta à API do ClickUp', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Não deve consultar a API sem token.'));
  for (const token of ['', '   ', null]) {
    await assert.rejects(getAuthorizedUser(token), /Preencha CLICKUP_API_TOKEN/);
  }
});

test('consulta a conta autenticada com o token no cabeçalho e sem alterar dados', async (t) => {
  const user = { id: 123, username: 'Conta de teste' };
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.clickup.com/api/v2/user');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'pk_token_ficticio');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ user });
  });
  assert.deepEqual(await getAuthorizedUser(' pk_token_ficticio '), user);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('falhas HTTP são tratadas sem expor token ou corpo da resposta', async (t) => {
  for (const [status, expected] of [
    [401, /autenticação/],
    [403, /Acesso ao ClickUp negado/],
    [429, /Limite de requisições/],
    [500, /HTTP 500/],
  ]) {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('TOKEN_SECRETO', { status }));
    await assert.rejects(getAuthorizedUser('TOKEN_SECRETO'), (error) => {
      assert.ok(error instanceof ClickUpError);
      assert.match(error.message, expected);
      assert.equal(error.message.includes('TOKEN_SECRETO'), false);
      return true;
    });
    fetchMock.mock.restore();
  }
});

test('erros de rede e timeout não propagam detalhes sensíveis', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('TOKEN_SECRETO'); });
  await assert.rejects(getAuthorizedUser('TOKEN_SECRETO'), (error) => {
    assert.ok(error instanceof ClickUpError);
    assert.match(error.message, /conexão de rede/);
    assert.equal(error.message.includes('TOKEN_SECRETO'), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('resposta sem conta autenticada não confirma conexão', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({}));
  await assert.rejects(getAuthorizedUser('pk_token_ficticio'), /resposta inesperada/);
});

test('verificação no terminal sem token falha sem iniciar o Discord', () => {
  const result = spawnSync(process.execPath, ['scripts/check-clickup.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, CLICKUP_API_TOKEN: '' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Preencha CLICKUP_API_TOKEN/);
  assert.equal(result.stdout.includes('Conectando ao Discord'), false);
  assert.equal(result.stdout.includes('validada com sucesso'), false);
});
