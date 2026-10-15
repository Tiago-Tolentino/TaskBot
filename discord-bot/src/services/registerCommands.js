import { commands } from '../commands/index.js';
import { BotSetupError } from './errors.js';

export async function registerCommands(client, channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.guild) {
    throw new BotSetupError('Não foi possível localizar o servidor do canal configurado para registrar os comandos. Verifique CHANNEL_ID e o acesso do bot.');
  }

  // create também atualiza um comando de mesmo nome, preservando os demais.
  const registered = [];
  for (const { data } of commands.values()) {
    const command = await channel.guild.commands.create(data.toJSON());
    console.log(`[INFO] Comando /${command.name} registrado no servidor: ${channel.guild.name}`);
    registered.push(command);
  }
  return registered;
}
