import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { readConfig, readNotificationConfig, readWebhookConfig } from './config.js';
import { startClickUpWebhook } from './services/clickupWebhook.js';
import { startTicketNotifications } from './services/ticketNotifications.js';
import { registerReadyEvent } from './events/ready.js';
import { registerInteractionEvent } from './events/interactionCreate.js';
import { BotSetupError, describeError } from './services/errors.js';

// Caminho relativo ao arquivo, para também funcionar fora do diretório do projeto.
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

let client;
let startupTimer;
let stopping = false;
let notificationMonitor;
let webhookService;

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(startupTimer);
  process.exitCode = exitCode;
  try {
    await webhookService?.stop();
    await notificationMonitor?.stop();
    await client?.destroy();
  } catch {
    console.error('[ERRO] Não foi possível encerrar a conexão normalmente.');
    process.exitCode = 1;
  }
}

async function fail(error) {
  console.error(`[ERRO] ${describeError(error)}`);
  await stop(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    console.log('\n[INFO] Encerrando bot...');
    void stop();
  });
}

async function main() {
  console.log('[INFO] Iniciando bot...');
  const { token, channelId } = readConfig();
  const notificationConfig = readNotificationConfig();
  const webhookConfig = readWebhookConfig();

  client = new Client({ intents: [GatewayIntentBits.Guilds] });
  registerInteractionEvent(client);
  registerReadyEvent(client, channelId, fail, () => clearTimeout(startupTimer), async (readyClient) => {
    if (!notificationConfig || stopping) return;
    notificationMonitor = await startTicketNotifications(readyClient, notificationConfig);
    if (stopping) { await notificationMonitor.stop(); return; }
    if (webhookConfig) webhookService = await startClickUpWebhook(notificationMonitor, webhookConfig, notificationConfig, readyClient);
    if (stopping) await webhookService?.stop();
  });
  client.on(Events.Error, (error) => console.error(`[ERRO] ${describeError(error)}`));
  client.on(Events.ShardError, (error) => console.error(`[ERRO] ${describeError(error)}`));
  client.on(Events.ShardReconnecting, () => console.log('[INFO] Reconectando ao Discord...'));
  client.on(Events.ShardResume, () => console.log('[INFO] Conexão com o Discord restabelecida.'));
  client.on(Events.ShardDisconnect, (event) => {
    if (!stopping) {
      console.error('[ERRO] Conexão com o Discord interrompida.');
      if (event.code === 4004) void fail({ code: 4004 });
    }
  });

  startupTimer = setTimeout(() => {
    void fail(new BotSetupError('O Discord não confirmou a conexão em 45 segundos. Verifique a rede e as credenciais e tente novamente.'));
  }, 45_000);

  console.log('[INFO] Conectando ao Discord...');
  await client.login(token);
}

main().catch(fail);
