import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('test')
  .setDescription('Realiza um teste de resposta do bot.');

export const helpText = 'Verifica se o bot está respondendo.\nUso: `/test`\nResposta: “Teste realizado com sucesso!”';

export async function execute(interaction) {
  await interaction.reply('Teste realizado com sucesso!');
}
