import { Events, MessageFlags } from 'discord.js';
import { commands } from '../commands/index.js';
import { ClickUpError } from '../integrations/clickup.js';
import { describeError } from '../services/errors.js';

export async function handleInteraction(interaction) {
  if (interaction.isAutocomplete?.()) {
    try {
      await commands.get(interaction.commandName)?.autocomplete?.(interaction);
    } catch {
      console.error('[ERRO] Não foi possível carregar as sugestões do ClickUp.');
      if (!interaction.responded) {
        try { await interaction.respond([]); } catch { /* A interação pode ter expirado. */ }
      }
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, { commands });
    console.log(`[INFO] Comando /${command.data.name} respondido com sucesso!`);
  } catch (error) {
    const description = error instanceof ClickUpError ? error.message : describeError(error);
    console.error(`[ERRO] Falha ao responder /${command.data.name}: ${description}`);
    const failures = {
      test: 'Não foi possível realizar o teste. Tente novamente.',
      ticket: 'Não foi possível listar os tickets. Tente novamente.',
      help: 'Não foi possível mostrar a ajuda. Tente novamente.',
    };
    const content = error instanceof ClickUpError ? error.message
      : failures[command.data.name] || 'Não foi possível executar o comando. Tente novamente.';

    if (!interaction.replied) {
      try {
        if (interaction.deferred) {
          await interaction.editReply({ content, files: [], allowedMentions: { parse: [] } });
        } else {
          await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
      } catch (replyError) {
        console.error(`[ERRO] Falha ao comunicar o erro de /${command.data.name}: ${describeError(replyError)}`);
      }
    }
  }
}

export function registerInteractionEvent(client) {
  client.on(Events.InteractionCreate, handleInteraction);
}
