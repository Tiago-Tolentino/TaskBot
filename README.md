# TasksBot

Bot para Discord desenvolvido em JavaScript com Node.js e `discord.js`, integrado ao ClickUp para consultar tickets de suporte e enviar avisos de novas atribuições elegíveis.

O projeto atende a lista **Tickets** do space **Suporte B2C**. Os IDs da lista, do workspace, dos canais e dos usuários são definidos localmente por variáveis de ambiente.

## Funcionalidades

- Ajuda no Discord com a descrição dos comandos disponíveis.
- Comando de teste para verificar a resposta do bot.
- Consulta de tickets com filtros opcionais de **status** e **responsável**, usados individualmente ou em conjunto.
- Sugestões dos status da lista e dos usuários do workspace enquanto você digita.
- Resultados em mensagens com título, status, responsáveis, resumo e link, navegáveis por botões.
- Consulta de todas as páginas da API, incluindo tickets concluídos, arquivados e subtarefas.
- Avisos automáticos de novos tickets atribuídos aos responsáveis configurados.
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

As dependências estão fixadas no [package.json](package.json), com instalação reproduzível pelo [package-lock.json](package-lock.json).

## Estrutura do repositório

```text
discord-bot/
├── README.md
├── src/
│   ├── index.js                 # Inicialização e encerramento
│   ├── config.js                # Validação da configuração
│   ├── commands/                # /help, /test e /ticket
│   ├── events/                  # Conexão e interações do Discord
│   ├── integrations/            # Cliente da API do ClickUp
│   └── services/                # Filtros, respostas e avisos
├── scripts/
│   └── check-clickup.js         # Validação manual da autenticação
├── test/                       # Testes automatizados
├── .env.example                # Modelo de configuração
├── .gitignore
├── package.json
└── package-lock.json
```

O arquivo `.env`, o diretório `node_modules/` e o estado de execução em `.data/` são locais e estão ignorados pelo Git.

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
TICKET_NOTIFICATION_ASSIGNEE_IDS=
TICKET_NOTIFICATION_INTERVAL_SECONDS=30
TICKET_NOTIFICATION_DISCORD_USER_MAP={}
```

| Variável | Finalidade |
| --- | --- |
| `DISCORD_TOKEN` | Token do bot do Discord. Obrigatório para iniciar. |
| `CHANNEL_ID` | ID de um canal acessível ao bot, usado para identificar o servidor onde os comandos serão registrados. Obrigatório para iniciar. |
| `CLICKUP_API_TOKEN` | Token do ClickUp, necessário para consultar tickets, carregar sugestões e executar o monitor. |
| `CLICKUP_TICKETS_LIST_ID` | ID da lista Tickets a ser consultada. |
| `CLICKUP_WORKSPACE_ID` | ID do workspace usado nas sugestões e na validação dos responsáveis. |
| `TICKET_NOTIFICATIONS_ENABLED` | Ativa o monitor quando definido como `true`. Padrão: desativado. |
| `TICKET_NOTIFICATION_CHANNEL_ID` | ID do canal que receberá os avisos automáticos. |
| `TICKET_NOTIFICATION_ASSIGNEE_IDS` | IDs dos responsáveis do ClickUp que devem gerar avisos, separados por vírgula. |
| `TICKET_NOTIFICATION_INTERVAL_SECONDS` | Intervalo entre verificações: inteiro de 30 a 3600 segundos. Padrão: `30`. |
| `TICKET_NOTIFICATION_DISCORD_USER_MAP` | Objeto JSON que associa IDs do ClickUp a IDs do Discord para as menções. |

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

Os IDs dos responsáveis são do **ClickUp**. Para marcar alguém no Discord, configure separadamente o ID correspondente do **Discord**.

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

## Avisos automáticos

Para habilitar o monitor, configure no `.env`:

- `TICKET_NOTIFICATIONS_ENABLED=true`;
- o canal de destino em `TICKET_NOTIFICATION_CHANNEL_ID`;
- os IDs dos responsáveis acompanhados em `TICKET_NOTIFICATION_ASSIGNEE_IDS`;
- opcionalmente, as associações para menções em `TICKET_NOTIFICATION_DISCORD_USER_MAP`.

Exemplo com **IDs fictícios**:

```dotenv
TICKET_NOTIFICATION_ASSIGNEE_IDS=12345678,87654321
TICKET_NOTIFICATION_DISCORD_USER_MAP={"12345678":"123456789012345678"}
```

As chaves do objeto são IDs do ClickUp; os valores são IDs do Discord. **Mantenha os IDs entre aspas** no JSON para preservar sua precisão.

O monitor verifica os tickets a cada 30 segundos por padrão. O intervalo é contado após concluir a consulta anterior. O funcionamento segue estas regras:

1. Acompanha tickets **criados a partir da primeira ativação** do monitor para a combinação de lista e canal.
2. Envia um aviso quando ao menos um dos responsáveis configurados está atribuído ao ticket.
3. Se um ticket novo receber um responsável acompanhado depois de criado, também poderá gerar o aviso.
4. Ter vários responsáveis acompanhados continua gerando um único aviso por ticket.
5. Tickets anteriores à ativação não geram avisos, mesmo se forem reabertos ou reatribuídos.

Cada aviso contém título, status, responsáveis, trecho do resumo e link. Quando um responsável atribuído tem um ID do Discord mapeado, ele é mencionado uma vez no aviso. Somente esses usuários são autorizados nas menções; o texto do ticket não libera menções a outros usuários, cargos ou `@everyone`.

O monitor usa consultas periódicas à API e não exige um endereço público para webhooks. O bot precisa permanecer em execução e conectado à rede.

### Estado dos avisos

O controle fica em:

```text
.data/ticket-notifications-<lista>-<canal>.json
```

O arquivo registra o início do acompanhamento, o último ponto consultado e os IDs dos tickets já avisados. **Preserve `.data/` ao reiniciar ou transferir a execução do bot.** Esse estado é local e não deve ser publicado no GitHub.

Com o mesmo estado, o monitor recupera tickets elegíveis criados durante o período offline e evita repetir avisos já confirmados. Falhas de rede ou envio são tentadas novamente na verificação seguinte. Um estado inválido não é apagado automaticamente.

A confirmação do Discord e a gravação local são operações separadas. O bot grava cada aviso confirmado e usa um `nonce` estável para reduzir duplicações; uma interrupção abrupta entre essas operações ainda pode exigir conferência manual.

Para desativar o monitor, defina `TICKET_NOTIFICATIONS_ENABLED=false` e reinicie o bot.

## Testes e verificações

Na raiz do projeto:

```sh
npm run check
npm test
```

| Comando npm | Finalidade |
| --- | --- |
| `npm ci` | Instala as dependências conforme o arquivo de lock. |
| `npm start` | Inicia o bot e as funcionalidades habilitadas. |
| `npm run check` | Verifica a sintaxe dos arquivos de execução. |
| `npm test` | Executa os testes automatizados locais. |
| `npm run clickup:check` | Valida a autenticação na API real do ClickUp. |

Os testes locais simulam APIs, canais e interações. Cobrem configuração, comandos, paginação, filtros, sugestões, resumos, navegação, menções, persistência e falhas do monitor. Eles não enviam mensagens reais nem modificam tickets no ClickUp.

Para uma validação real, execute `/test` e `/ticket` no Discord. Para testar o monitor, crie um ticket novo após a ativação, atribua a um responsável acompanhado e confira o aviso no canal e o log de confirmação com o ID da mensagem.

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
| O monitor não avisa | Confira a ativação, o canal, as permissões, os IDs dos responsáveis e se o ticket foi criado desde a primeira ativação. |
| A menção não notifica a pessoa | Confira o vínculo de IDs, a atribuição no ticket, o acesso ao canal e as configurações de notificações do usuário. |
| O ClickUp limita as requisições | Aguarde antes de repetir a pesquisa e mantenha o intervalo do monitor dentro da configuração permitida. |
| O estado dos avisos está inválido | Verifique o arquivo em `.data/` e restaure um backup válido antes de reativar o monitor. |

Cada requisição ao ClickUp tem limite de 10 segundos, e uma consulta completa de tickets tem limite de 2 minutos. Alterações simultâneas na lista podem afetar a paginação, pois a consulta não é uma cópia congelada dos dados.

## Publicação no GitHub

O repositório deve incluir o código, os arquivos `package.json` e `package-lock.json`, o modelo `.env.example` e esta documentação.

O [.gitignore](.gitignore) exclui `.env`, arquivos locais `.env.*` (preservando `.env.example`), `node_modules/`, `.data/`, cobertura de testes e logs de depuração do npm. Confira os arquivos preparados para o commit com `git status`.

Preencha tokens e IDs da sua instalação somente no `.env` local. Os exemplos deste README usam valores vazios ou fictícios.
