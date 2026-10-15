import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { BotSetupError } from './errors.js';

export function verifyWebhookSignature(body, signature, secret) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature) || !secret) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export async function startWebhookServer({ port, getCredentials, enqueue, onError = () => {} }) {
  let stopping = false;
  const server = createServer(async (request, response) => {
    const reply = (status) => { response.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end(); };
    if (request.url !== '/webhooks/clickup') { reply(404); request.resume(); return; }
    if (request.method !== 'POST') { reply(405); request.resume(); return; }
    const credentials = getCredentials();
    if (stopping || !credentials?.secret) { reply(503); request.resume(); return; }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) { reply(415); request.resume(); return; }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 256 * 1024) { reply(413); request.resume(); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      // 403 evita que uma chamada não autenticada suspenda o webhook no ClickUp.
      if (!verifyWebhookSignature(body, request.headers['x-signature'], credentials.secret)) { reply(403); return; }
      let payload;
      try { payload = JSON.parse(body.toString('utf8')); } catch { reply(400); return; }
      if (!payload || payload.webhook_id !== credentials.id) { reply(403); return; }
      if (payload.event !== 'taskCreated') { reply(204); return; }
      if (typeof payload.task_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(payload.task_id)) { reply(400); return; }
      await enqueue(payload.task_id);
      reply(202);
    } catch (error) {
      onError(error);
      if (!response.headersSent && !response.destroyed) reply(503);
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 100;
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new BotSetupError('Não foi possível abrir a porta local do webhook. Verifique CLICKUP_WEBHOOK_PORT e outras instâncias do bot.')));
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    async stop() {
      stopping = true;
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
