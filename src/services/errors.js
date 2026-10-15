export class BotSetupError extends Error {}

// Não registrar objetos de erro externos: eles podem incluir dados da requisição.
export function describeError(error) {
  if (error instanceof BotSetupError) return error.message;

  switch (error?.code) {
    case 'TokenInvalid':
    case 4004:
    case 50014:
    case 401:
      return 'Falha na autenticação. Verifique DISCORD_TOKEN no .env; use o token do bot, sem o prefixo Bot.';
    case 10003:
      return 'Canal inexistente. Verifique CHANNEL_ID no .env.';
    case 50001:
      return 'Canal inacessível. Verifique se o bot está no servidor e pode visualizar o canal.';
    case 50013:
      return 'Permissão insuficiente. Verifique Visualizar canal e Enviar mensagens no canal configurado.';
    case 50083:
      return 'A thread está arquivada. Escolha um canal de texto ou uma thread ativa.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ECONNRESET':
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
      return 'Falha de conexão com o Discord. Verifique a rede e tente iniciar novamente.';
    default:
      if (error?.status === 401) return describeError({ code: 401 });
      return 'Não foi possível concluir a operação no Discord. Verifique a conexão, as credenciais e as permissões do canal.';
  }
}
