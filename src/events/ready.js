import { Events } from 'discord.js';
import { registerCommands } from '../services/registerCommands.js';
import { getTicketFilters } from '../services/ticketFilters.js';

export function registerReadyEvent(client, channelId, onFailure, onReady = () => {}, onConnected = async () => {}) {
  // Registra os comandos somente na primeira conexão do processo.
  client.once(Events.ClientReady, async (readyClient) => {
    onReady();
    console.log(`[INFO] Bot conectado: ${readyClient.user.tag}`);

    try {
      console.log('[INFO] Registrando comandos...');
      await registerCommands(readyClient, channelId);
      if (process.env.CLICKUP_API_TOKEN && process.env.CLICKUP_WORKSPACE_ID) {
        void getTicketFilters().catch(() => console.error('[ERRO] Não foi possível preparar as sugestões do ClickUp; elas serão consultadas novamente ao pesquisar.'));
      }
      await onConnected(readyClient);
      console.log('[INFO] Bot em execução. Use Ctrl + C para encerrar.');
    } catch (error) {
      await onFailure(error);
    }
  });
}
