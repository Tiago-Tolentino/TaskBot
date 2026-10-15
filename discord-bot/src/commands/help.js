import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Lista os comandos do bot e explica como usar cada um.');

export async function execute(interaction, { commands }) {
  const entries = [...commands.values()].sort((a, b) => a.data.name.localeCompare(b.data.name));
  const content = '**Ajuda — TasksBot**\n\n' + entries.map((command) =>
    `**/${command.data.name}**\n${command.helpText || command.data.description}`,
  ).join('\n\n');
  await interaction.reply({ content, allowedMentions: { parse: [] } });
}
