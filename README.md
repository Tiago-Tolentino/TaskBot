# TasksBot

Bot para Discord desenvolvido em JavaScript com Node.js e `discord.js`, integrado ao ClickUp para consultar tickets de suporte e enviar avisos de novos tickets.

O projeto atende a lista **Tickets** do space **Suporte B2C**. Os IDs da lista, do workspace, dos canais e dos usuários são definidos localmente por variáveis de ambiente.

## Funcionalidades

- Ajuda no Discord com a descrição dos comandos disponíveis.
- Comando de teste para verificar a resposta do bot.
- Consulta de tickets com filtros opcionais de **status** e **responsável**, usados individualmente ou em conjunto.
- Sugestões dos status da lista e dos usuários do workspace enquanto você digita.
- Resultados em mensagens com título, status, responsáveis, resumo e link, navegáveis por botões.
- Consulta de todas as páginas da API, incluindo tickets concluídos, arquivados e subtarefas.
- Avisos de qualquer ticket novo, inclusive sem responsável, recebidos por webhook com túnel local.
- Consulta de recuperação a cada 10 minutos e ao iniciar, para cobrir falhas de entrega.
- Menções aos usuários do Discord vinculados aos responsáveis do ClickUp.
- Controle local dos avisos enviados para evitar repetições nas consultas e nos reinícios normais.

## Tecnologias

- **JavaScript**, com módulos ES.
- **Node.js 22.12.0 ou superior**, conforme o requisito do projeto.
- **npm** para gerenciamento de dependências e execução.
- **discord.js 14.27.0** para a comunicação com o Discord.
- **dotenv 18.0.8** para carregar a configuração local.
- **API do ClickUp**, acessada pelo `fetch` nativo do Node.js.
- **Executor de testes nativo do Node.js**.
- **cloudflared**, instalado localmente, para receber webhooks por um túnel HTTPS.

As dependências estão fixadas no [package.json](package.json), com instalação reproduzível pelo [package-lock.json](package-lock.json).

## Estrutura do repositório

```text
discord-bot/
├── AGENTS.md                  # Orientações para agentes de programação
├── README.md
├── src/
│   ├── index.js                 # Inicialização e encerramento
│   ├── config.js                # Validação da configuração
│   ├── commands/                # /help, /test e /ticket
│   ├── events/                  # Conexão e interações do Discord
│   ├── integrations/            # Cliente da API do ClickUp
│   └── services/                # Filtros, respostas e avisos
├── scripts/
│   ├── check-clickup.js         # Validação manual da autenticação
│   └── install-tunnel.js        # Instalação local do cloudflared
├── test/                       # Testes automatizados
├── .env.example                # Modelo de configuração
├── .gitignore
├── package.json
└── package-lock.json
```

O arquivo `.env`, os diretórios `node_modules/` e `.tools/` e o estado de execução em `.data/` são locais e estão ignorados pelo Git.

## Instalação

Clone ou baixe este repositório e, na pasta que contém `package.json`, instale as dependências:

```sh
npm ci
```

Verifique o ambiente, se necessário:

```sh
node --version
npm --version
```

Todos os comandos npm descritos abaixo devem ser executados na raiz do projeto, na mesma pasta de `package.json`.

## Configuração

Crie um arquivo `.env` na raiz do projeto, copiando o conteúdo de [.env.example](.env.example). Se já existir um `.env`, edite o arquivo existente para preservar suas credenciais.

```dotenv
DISCORD_TOKEN=
CHANNEL_ID=

CLICKUP_API_TOKEN=
CLICKUP_TICKETS_LIST_ID=
CLICKUP_WORKSPACE_ID=

TICKET_NOTIFICATIONS_ENABLED=false
TICKET_NOTIFICATION_CHANNEL_ID=
TICKET_NOTIFICATION_INTERVAL_SECONDS=600
TICKET_NOTIFICATION_DISCORD_USER_MAP={}

CLICKUP_WEBHOOK_ENABLED=false
CLICKUP_WEBHOOK_PORT=3000
CLOUDFLARED_PATH=
```

| Variável | Finalidade |
| --- | --- |
| `DISCORD_TOKEN` | Token do bot do Discord. Obrigatório para iniciar. |
| `CHANNEL_ID` | ID de um canal acessível ao bot, usado para identificar o servidor onde os comandos serão registrados. Obrigatório para iniciar. |
| `CLICKUP_API_TOKEN` | Token do ClickUp, necessário para consultar tickets, carregar sugestões e executar o monitor. |
| `CLICKUP_TICKETS_LIST_ID` | ID da lista Tickets a ser consultada. |
| `CLICKUP_WORKSPACE_ID` | ID do workspace usado nas sugestões de responsáveis e no cadastro do webhook. |
| `TICKET_NOTIFICATIONS_ENABLED` | Ativa o monitor quando definido como `true`. Padrão: desativado. |
| `TICKET_NOTIFICATION_CHANNEL_ID` | ID do canal que receberá os avisos automáticos. |
| `TICKET_NOTIFICATION_INTERVAL_SECONDS` | Intervalo entre consultas de recuperação: inteiro de 30 a 3600 segundos. Padrão: `600` (10 minutos). |
| `TICKET_NOTIFICATION_DISCORD_USER_MAP` | Objeto JSON que associa IDs do ClickUp a IDs do Discord para as menções. Não limita quais tickets geram avisos. |
| `CLICKUP_WEBHOOK_ENABLED` | Ativa o servidor de webhook, o túnel local e o cadastro automático no ClickUp quando definido como `true`. Padrão: desativado. |
| `CLICKUP_WEBHOOK_PORT` | Porta HTTP local do receptor, de 1024 a 65535. Padrão: `3000`; escuta somente em `127.0.0.1`. |
| `CLOUDFLARED_PATH` | Caminho opcional do executável. Se vazio, procura `.tools/cloudflared` e depois `cloudflared` no PATH. |

Variáveis já definidas no ambiente do terminal têm prioridade sobre o `.env`. Reinicie o bot depois de alterar a configuração.

### Preparar o Discord

1. Acesse o [Discord Developer Portal](https://discord.com/developers/applications) e abra ou crie a aplicação do bot.
2. Na seção **Bot**, obtenha o token e preencha `DISCORD_TOKEN` localmente, sem o prefixo `Bot`. Regenerar o token invalida o anterior.
3. Instale o bot no servidor com os escopos `bot` e `applications.commands`.
4. No aplicativo Discord, ative **Configurações de usuário → Avançado → Modo desenvolvedor**.
5. Clique com o botão direito em um canal do servidor, selecione **Copiar ID do canal** e preencha `CHANNEL_ID`. Esse valor é o ID do canal, não o ID do servidor.

O bot usa somente o intent `Guilds`. Não é necessário habilitar intents privilegiados, como Message Content, para as funcionalidades atuais.

Nos canais utilizados, conceda **Visualizar canal** e **Enviar mensagens**. No canal dos avisos, conceda também **Inserir links** para os embeds. Confira as permissões de uso dos comandos de aplicativos. Não é necessário conceder Administrador.

### Preparar o ClickUp

1. Obtenha um token pessoal em sua conta do ClickUp, conforme a [documentação de autenticação](https://developer.clickup.com/docs/authentication).
2. Preencha `CLICKUP_API_TOKEN` diretamente no `.env`, com o valor fornecido pelo ClickUp e sem acrescentar `Bearer`.
3. Informe o ID da lista Tickets em `CLICKUP_TICKETS_LIST_ID` e o ID do workspace em `CLICKUP_WORKSPACE_ID`.
4. Confirme que a conta do token tem acesso à lista e aos tickets que deseja consultar.

O filtro de responsável do `/ticket` usa IDs do **ClickUp**. Para marcar alguém nos avisos, configure separadamente o ID correspondente do **Discord**.

Valide a autenticação:

```sh
npm run clickup:check
```

Esse comando consulta a conta autenticada, mostra uma confirmação em caso de sucesso e encerra. Ele não modifica tarefas nem envia mensagens ao Discord.

## Execução

```sh
npm start
```

Ao conectar, o bot registra automaticamente `/help`, `/test` e `/ticket` no servidor identificado por `CHANNEL_ID`. Ele permanece conectado aguardando comandos e, se habilitado, executando o monitor de tickets.

Use **Ctrl + C** para encerrar. O processo também trata `SIGTERM` e cancela a consulta do monitor ao encerrar.

Não há mensagem de teste ou saudação enviada automaticamente ao iniciar. O monitor pode entregar avisos pendentes de tickets elegíveis.

## Comandos do Discord

| Comando | Descrição |
| --- | --- |
| `/help` | Lista os comandos disponíveis, explica suas funções e mostra exemplos de uso. |
| `/test` | Responde `Teste realizado com sucesso!` para verificar se o bot está respondendo. |
| `/ticket` | Consulta os tickets da lista configurada, com filtros opcionais de status e responsável. |

### Pesquisar tickets

| Pesquisa | Exemplo |
| --- | --- |
| Todos os tickets | `/ticket` |
| Por status | `/ticket status:validando` |
| Por responsável | `/ticket responsavel:Nome` |
| Pelos dois filtros | `/ticket status:validando responsavel:Nome` |

Os exemplos representam os campos preenchidos na interface do Discord. Ao digitar, **selecione o status e o usuário nas sugestões**; o filtro de responsável usa o ID do usuário selecionado.

- As sugestões de status vêm da própria lista do ClickUp.
- As sugestões de responsáveis vêm dos membros do workspace, incluindo pessoas com acesso herdado à lista.
- A busca nas sugestões ignora diferenças entre maiúsculas, minúsculas e acentos. Até 25 opções são mostradas por vez; digite mais para refinar a busca.
- Com os dois filtros, o ticket precisa ter o status escolhido **e** a pessoa entre seus responsáveis. Tickets com vários responsáveis também são considerados.
- Sem filtros, todas as páginas são consultadas. Sem correspondências, o bot informa que nenhum ticket foi encontrado.

O resultado mostra **título, status, responsáveis, resumo e link**. O resumo é extraído da seção Resumo da descrição do ticket. Na ausência dessa seção, é utilizada a descrição disponível; se estiver vazia, aparece `Resumo não informado.`

Use **Anterior** e **Próximo** para navegar. Apenas quem executou a pesquisa pode mudar suas páginas. Resumos longos continuam nas páginas seguintes, respeitando o limite de mensagem sem gerar arquivos TXT. Os botões ficam ativos por **10 minutos**; após esse período ou após reiniciar o bot, execute `/ticket` novamente.

A consulta inclui tickets abertos, concluídos, arquivados, subtarefas e tickets vinculados a múltiplas listas. Resultados são deduplicados pelo ID e limitados ao acesso permitido ao token. Falhas na consulta geram uma mensagem de erro, sem apresentar resultados parciais como completos.

## Avisos automáticos com webhook e túnel local

O bot avisa sobre **qualquer ticket novo na lista configurada**, inclusive sem responsável. Não existe filtro de responsável para os avisos. O filtro opcional do comando `/ticket` continua disponível para pesquisas manuais.

### Ativar

1. Instale o executável local do túnel:

   ```sh
   npm run tunnel:install
   ```

   O instalador suporta macOS e Linux, nas arquiteturas ARM64 e x64. Baixa uma release oficial da Cloudflare, confere o SHA-256 publicado no GitHub e grava em `.tools/cloudflared`, ignorado pelo Git. Como alternativa, instale `cloudflared` pelo gerenciador do seu sistema e configure `CLOUDFLARED_PATH` se necessário.

2. Configure no `.env`:

   ```dotenv
   TICKET_NOTIFICATIONS_ENABLED=true
   TICKET_NOTIFICATION_CHANNEL_ID=
   TICKET_NOTIFICATION_INTERVAL_SECONDS=600
   CLICKUP_WEBHOOK_ENABLED=true
   CLICKUP_WEBHOOK_PORT=3000
   CLOUDFLARED_PATH=
   ```

   Preencha o canal e mantenha as credenciais, `CLICKUP_TICKETS_LIST_ID` e `CLICKUP_WORKSPACE_ID` configurados.

3. Execute `npm start`. O bot inicia a recuperação, abre o receptor HTTP local, inicia o túnel e cadastra no ClickUp um webhook para `taskCreated`, limitado à lista Tickets. Aguarde o log `Webhook ClickUp ativo via túnel local`.

O [Quick Tunnel da Cloudflare](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) fornece um endereço HTTPS temporário, sem exigir conta ou domínio. A cada nova execução, o endereço pode mudar; o bot atualiza o mesmo webhook salvo em `.data/`. Não é necessário copiar a URL manualmente para o ClickUp.

O computador, o bot, a conexão de rede e o túnel precisam permanecer ativos. Quick Tunnels são voltados ao desenvolvimento e não têm garantia de disponibilidade. Se o processo do túnel encerrar, o bot tenta recriá-lo após 60 segundos. O encerramento normal do bot também encerra seu túnel.

### Recepção e recuperação

1. O ClickUp envia o evento de criação ao endpoint `/webhooks/clickup`.
2. O bot valida a assinatura HMAC-SHA256 sobre o corpo original e o ID do webhook. O receptor não publica arquivos nem oferece outras rotas.
3. O ID do ticket é persistido em uma fila local antes da resposta de aceitação. O envio ao Discord acontece em segundo plano.
4. O bot consulta os detalhes daquele ticket e aplica o período de acompanhamento e o histórico de avisos. Tickets já avisados não geram um novo aviso.
5. A consulta de recuperação busca todas as páginas necessárias ao iniciar e, por padrão, a cada **10 minutos após a consulta anterior terminar**. Ela recupera tickets que não chegaram por webhook, inclusive durante períodos offline. A saúde do webhook também é verificada a cada 10 minutos; se necessário, o cadastro é reativado.

Falhas no processamento da fila são tentadas novamente após 30 segundos. O webhook e a recuperação compartilham o controle de envio para evitar corridas e duplicações. Um ticket removido ou fora da lista principal configurada é descartado na consulta individual; a recuperação periódica também considera tickets vinculados a múltiplas listas.

O acompanhamento começa na primeira ativação. Ao migrar da versão com filtro de responsáveis, o bot mantém o histórico e registra o início da nova regra: tickets anteriores a essa migração que não tinham sido avisados não geram uma enxurrada de avisos retroativos. Depois disso, reinícios preservam esse marco e recuperam tickets novos do período offline. Reabrir um ticket antigo não o transforma em um ticket novo.

Cada aviso contém título, status, responsáveis, trecho do resumo e link. Se a consulta ocorrer antes de o responsável ser atribuído, o aviso pode mostrar `Não atribuído`; uma atribuição posterior não gera um segundo aviso.

### Menções

As menções continuam opcionais. Exemplo com **IDs fictícios**:

```dotenv
TICKET_NOTIFICATION_DISCORD_USER_MAP={"12345678":"123456789012345678"}
```

As chaves são IDs do ClickUp e os valores são IDs do Discord. Mantenha ambos entre aspas. O usuário só é mencionado se estiver atribuído ao ticket no momento da consulta. Todos os outros tickets também geram avisos. O texto dos tickets não autoriza menções a cargos, `@everyone` ou outros usuários.

### Estado local e desativação

Preserve todo o diretório `.data/`, incluindo:

- `ticket-notifications-<lista>-<canal>.json`: marcos de acompanhamento, checkpoint e IDs já avisados.
- `clickup-webhook-<workspace>-<lista>-<canal>.json`: ID, endereço e **segredo do webhook**; não publique nem exiba seu conteúdo.
- `webhook-inbox-<workspace>-<lista>-<canal>.json`: IDs dos tickets recebidos e ainda pendentes.

Esses arquivos são gravados com acesso restrito e estão ignorados pelo Git. Estado inválido não é apagado automaticamente. A confirmação do Discord e a gravação local continuam sendo operações separadas; o `nonce` estável reduz duplicações em uma interrupção abrupta entre elas.

Para usar apenas a consulta de recuperação, defina `CLICKUP_WEBHOOK_ENABLED=false` e reinicie. Para desativar todos os avisos, defina também `TICKET_NOTIFICATIONS_ENABLED=false`. O cadastro remoto é preservado e atualizado/reativado quando o webhook voltar a ser habilitado.

## Testes e verificações

Na raiz do projeto:

```sh
npm run check
npm test
```

| Comando npm | Finalidade |
| --- | --- |
| `npm ci` | Instala as dependências conforme o arquivo de lock. |
| `npm start` | Inicia o bot, o monitor e o túnel/webhook quando habilitados. |
| `npm run tunnel:install` | Instala o executável oficial do túnel em `.tools/`, com verificação de SHA-256. |
| `npm run check` | Verifica a sintaxe dos arquivos de execução. |
| `npm test` | Executa os testes automatizados locais. |
| `npm run clickup:check` | Valida a autenticação na API real do ClickUp. |

Os testes locais simulam APIs, canais e interações. Cobrem configuração, comandos, paginação, filtros, sugestões, resumos, navegação, menções, persistência, assinaturas de webhook, fila, concorrência e falhas do monitor. Os testes HTTP usam somente um servidor local simulado. Eles não enviam mensagens reais nem modificam tickets no ClickUp.

Para uma validação real, execute `/test` e `/ticket` no Discord. Para testar o monitor, crie um ticket novo após a ativação, com ou sem responsável, e confira o aviso no canal e o log de confirmação com o ID da mensagem.

## Organização do código

- **`src/index.js`** cria o cliente Discord, registra os eventos e coordena o encerramento.
- **`src/config.js`** valida as variáveis obrigatórias e a configuração dos avisos.
- **`src/commands/`** contém as definições e os comportamentos dos comandos. Novos comandos devem ser adicionados ao registro em `src/commands/index.js`; `/help` usa esse mesmo registro para listar as opções disponíveis.
- **`src/events/`** trata a conexão e encaminha as interações aos comandos.
- **`src/integrations/clickup.js`** concentra as consultas autenticadas ao ClickUp e a paginação.
- **`src/services/`** organiza filtros, extração do resumo, mensagens, notificações e estado persistente.

Toda comunicação com o Discord passa pelo `discord.js`. A integração com o ClickUp utiliza o `fetch` nativo do Node.js.

## Solução de problemas

| Situação | O que verificar |
| --- | --- |
| O bot não inicia | Versão do Node.js, dependências instaladas e variáveis obrigatórias no `.env`. |
| O Discord recusa a autenticação | Use o token atual do bot, sem o prefixo `Bot`. |
| O comando não aparece | Confira o registro no terminal, o servidor de `CHANNEL_ID`, os escopos da instalação e as permissões dos comandos. Reabra o Discord se necessário. |
| As sugestões não aparecem | Confira token, lista e workspace do ClickUp. As opções ficam em cache por até 5 minutos; uma consulta lenta pode prepará-las para a próxima tentativa. |
| A pesquisa não encontra tickets | Verifique os filtros, a lista configurada e o acesso da conta do token. |
| Os botões pararam | A navegação expira após 10 minutos ou ao reiniciar o bot. Execute `/ticket` novamente. |
| O monitor não avisa | Confira a ativação, o canal, as permissões e se o ticket foi criado desde o início do acompanhamento da regra atual. |
| A menção não notifica a pessoa | Confira o vínculo de IDs, a atribuição no ticket, o acesso ao canal e as configurações de notificações do usuário. |
| O ClickUp limita as requisições | Aguarde antes de repetir a pesquisa e mantenha o intervalo do monitor dentro da configuração permitida. |
| O túnel ou webhook não conecta | Confira a rede, `npm run tunnel:install`, a porta local, o workspace e o acesso da conta do token. A recuperação de 10 minutos continua ativa se o túnel falhar. |
| O estado dos avisos está inválido | Verifique o arquivo em `.data/` e restaure um backup válido antes de reativar o monitor. |

Cada requisição ao ClickUp tem limite de 10 segundos, e uma consulta completa de tickets tem limite de 2 minutos. Alterações simultâneas na lista podem afetar a paginação, pois a consulta não é uma cópia congelada dos dados.

## Publicação no GitHub

O repositório deve incluir o código, os arquivos `package.json` e `package-lock.json`, o modelo `.env.example` e esta documentação.

O [.gitignore](.gitignore) exclui `.env`, arquivos locais `.env.*` (preservando `.env.example`), `node_modules/`, `.data/`, `.tools/`, cobertura de testes e logs de depuração do npm. Confira os arquivos preparados para o commit com `git status`.

Preencha tokens e IDs da sua instalação somente no `.env` local. Os exemplos deste README usam valores vazios ou fictícios.
