import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ClickUpError, requestClickUp } from '../integrations/clickup.js';
import { BotSetupError, describeError } from './errors.js';
import { createNotificationStore } from './notificationState.js';
import { createWebhookInbox } from './webhookInbox.js';
import { startWebhookServer, TICKET_WEBHOOK_EVENTS } from './webhookServer.js';
import { startLocalTunnel } from './localTunnel.js';

export async function ensureClickUpWebhook({ store, scope, workspaceId, listId, endpoint, commentDmEnabled = false, token = process.env.CLICKUP_API_TOKEN, signal, request = requestClickUp }) {
  const events = commentDmEnabled ? [...TICKET_WEBHOOK_EVENTS, 'taskCommentPosted'] : TICKET_WEBHOOK_EVENTS;
  const saved = await store.read();
  if (saved && (saved.version !== 1 || saved.scope !== scope || typeof saved.id !== 'string' || !saved.id || typeof saved.secret !== 'string' || !saved.secret)) {
    throw new BotSetupError('Registro local do webhook inválido. Preserve e verifique o arquivo em .data.');
  }
  let record;
  if (saved) {
    try {
      await request(`/webhook/${encodeURIComponent(saved.id)}`, token, signal, { method: 'PUT', body: { endpoint, events, status: 'active' } });
      record = { ...saved, endpoint };
    } catch (error) { if (error.status !== 404) throw error; }
  }
  if (!record) {
    const data = await request(`/team/${workspaceId}/webhook`, token, signal, {
      method: 'POST', body: { endpoint, events, list_id: listId },
    });
    if (typeof data.webhook?.id !== 'string' || !data.webhook.id || typeof data.webhook?.secret !== 'string' || !data.webhook.secret) {
      throw new BotSetupError('O ClickUp não confirmou o registro e o segredo do webhook.');
    }
    record = { version: 1, scope, id: data.webhook.id, secret: data.webhook.secret, endpoint };
  }
  await store.write(record);
  return record;
}

// URLs novas de Quick Tunnel podem levar alguns segundos para serem aceitas.
// Preservar o mesmo túnel evita reiniciar essa espera a cada falha no cadastro.
export async function registerWebhookWithRetry(register, { signal, onError = () => {}, wait = delay } = {}) {
  let attempt = 0;
  while (true) {
    signal?.throwIfAborted();
    try { return await register(); }
    catch (error) {
      signal?.throwIfAborted();
      onError(error);
      await wait(Math.min(15_000 * 2 ** Math.min(attempt++, 2), 60_000), undefined, { signal });
    }
  }
}

// Conexão registrada no cloudflared não garante que a URL pública já responda.
export async function verifyTunnelEndpoint(endpoint, { signal, probe = fetch, wait = delay } = {}) {
  for (const pause of [0, 5000, 15000, 30000]) {
    if (pause) await wait(pause, undefined, { signal });
    signal?.throwIfAborted();
    try {
      const response = await probe(endpoint, { method: 'GET', redirect: 'error', signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
      await response.body?.cancel();
      if (response.status === 405) return;
    } catch { /* Não expor URL, corpo de resposta ou dados de erro externos. */ }
  }
  throw new BotSetupError('O endereço público do túnel está inacessível. O bot tentará outra conexão; a recuperação periódica continua ativa.');
}

export async function startClickUpWebhook(monitor, config, notificationConfig, comments) {
  const scope = `${config.workspaceId}:${notificationConfig.listId}:${notificationConfig.channelId}`;
  const dataPath = (kind) => fileURLToPath(new URL(`../../.data/${kind}-${scope.replaceAll(':', '-')}.json`, import.meta.url));
  const store = createNotificationStore(dataPath('clickup-webhook'));
  const controller = new AbortController();
  const onError = (error) => console.error(`[ERRO] Webhook: ${error instanceof ClickUpError ? error.message : describeError(error)}`);
  const inbox = await createWebhookInbox({ store: createNotificationStore(dataPath('webhook-inbox')), processTask: (id) => monitor.processTask(id), onError });
  let credentials;
  let tunnel;
  let timer;
  let connecting;
  let healthTimer;
  let checking;
  let stopped = false;
  let server;
  try {
    server = await startWebhookServer({ port: config.port, getCredentials: () => credentials, enqueue: (id) => inbox.enqueue(id), enqueueComments: comments ? (events) => comments.enqueue(events) : undefined,
      onAccepted: ({ event, taskId }) => console.log(`[INFO] Webhook recebido e persistido: ${event}, ticket ${taskId}.`), onError });
  } catch (error) { await inbox.stop(); throw error; }
  inbox.start();
  async function connect() {
    if (stopped) return;
    const connection = new AbortController();
    const signal = AbortSignal.any([controller.signal, connection.signal]);
    try {
      tunnel = await startLocalTunnel({ port: config.port, binary: config.binary, signal });
      void tunnel.closed.then(() => connection.abort());
      await verifyTunnelEndpoint(`${tunnel.url}/webhooks/clickup`, { signal });
      credentials = await registerWebhookWithRetry(
        () => ensureClickUpWebhook({ store, scope, workspaceId: config.workspaceId, listId: notificationConfig.listId, endpoint: `${tunnel.url}/webhooks/clickup`, commentDmEnabled: notificationConfig.commentDmEnabled, signal }),
        { signal, onError },
      );
      console.log('[INFO] Webhook ClickUp ativo via túnel local: novos tickets de qualquer responsável.');
      // Uma sequência de falhas pode suspender o webhook; recuperar sem exigir
      // reinício do bot. Nunca alterar os outros webhooks do workspace.
      const checkHealth = async () => {
        let endpointReachable = false;
        try {
          await verifyTunnelEndpoint(`${tunnel.url}/webhooks/clickup`, { signal });
          endpointReachable = true;
          const data = await requestClickUp(`/team/${config.workspaceId}/webhook`, process.env.CLICKUP_API_TOKEN, signal);
          if (signal.aborted) return;
          const remote = data.webhooks?.find((item) => item.id === credentials?.id);
          if (!Array.isArray(data.webhooks)) throw new BotSetupError('Não foi possível verificar a saúde do webhook.');
          if (!remote || remote.health?.status !== 'active' || Number(remote.health?.fail_count || 0) > 0) {
            credentials = await ensureClickUpWebhook({ store, scope, workspaceId: config.workspaceId, listId: notificationConfig.listId, endpoint: `${tunnel.url}/webhooks/clickup`, commentDmEnabled: notificationConfig.commentDmEnabled, signal });
          }
        } catch (error) { if (!signal.aborted) { onError(error); if (!endpointReachable) await tunnel?.stop(); } }
        finally { if (!signal.aborted && credentials) healthTimer = setTimeout(() => { checking = checkHealth(); }, 600_000); }
      };
      healthTimer = setTimeout(() => { checking = checkHealth(); }, 600_000);
      await tunnel.closed;
      if (!stopped) throw new BotSetupError('Túnel interrompido. Reconexão automática em 60 segundos; recuperação periódica permanece ativa.');
    } catch (error) { if (!stopped) onError(error); }
    finally {
      connection.abort();
      credentials = undefined;
      clearTimeout(healthTimer);
      await checking;
      credentials = undefined;
      await tunnel?.stop();
      if (!stopped) timer = setTimeout(() => { connecting = connect(); }, 60_000);
    }
  }
  connecting = connect();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(healthTimer);
      controller.abort();
      await server.stop();
      await tunnel?.stop();
      // Libera a fila caso esteja aguardando uma consulta do monitor.
      const stoppingInbox = inbox.stop();
      await monitor.stop();
      await stoppingInbox;
      await connecting;
    },
  };
}
