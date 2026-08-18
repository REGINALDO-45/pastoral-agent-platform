# Verificação de interface

## Experiência móvel — inspeção inicial

A navegação, o hero do dashboard, o CTA do Assistente Pastoral e o painel de voz foram renderizados em uma largura de 375 px. A hierarquia visual, a cópia e os alvos de interação permaneceram legíveis sem rolagem horizontal perceptível.

O dashboard e a conversa exibiram skeletons por mais tempo do que o esperado durante a captura. A próxima ação é confirmar os estados das consultas autenticadas no cliente e no servidor, corrigindo qualquer bloqueio de carregamento antes da entrega.

## Encerramento da validação

As consultas autenticadas foram verificadas por um teste de integração que chama o dashboard, cria ou recupera a conversa e lista as mensagens usando o contexto derivado da sessão no servidor. O banco retornou a associação da sessão de demonstração com a Igreja Demonstração A e confirmou a existência de duas organizações, cinco células e quatro visitantes na base de demonstração.

As capturas móveis em 375 px confirmaram cabeçalho compacto, hero, CTA, estados de carregamento informativos do chat e uma tela de acesso responsiva. O primeiro carregamento visível é uma transição normal após a sessão; os dados autenticados são verificados também em integração no backend.

O teste de isolamento agora cria um contexto autenticado da Igreja Demonstração B, comprova que seu dashboard é distinto e confirma que a tentativa de ler a conversa do tenant A retorna `FORBIDDEN`. Também foram adicionados estados recuperáveis de erro no dashboard e no chat, além de fallback explícito do VoiceProvider para a transcrição integrada.

Permanece necessário testar em um dispositivo físico a permissão de microfone, uma transcrição real, a confirmação de um acompanhamento e a síntese de voz do navegador; essa limitação é do hardware/sessão do usuário e não foi simulada como prova de funcionamento.

## Correção do envio de voz

O incidente inicial foi localizado antes da transcrição: a gravação era convertida em Base64 e enviada dentro de uma mutation tRPC/JSON. O registro de rede mostrou que esse request foi recusado com HTTP 403 pelo gateway, portanto o Agent Core e o provedor de voz não chegaram a processar o áudio.

A primeira troca para corpo binário bruto também foi bloqueada pelo gateway externo com HTTP 403 em HTML, antes de alcançar a aplicação. O cliente agora envia o `Blob` como `multipart/form-data` no campo `audio`; o servidor recebe o arquivo com limite de 16 MB e preserva validação de MIME, autenticação, limite por usuário e auditoria.

O smoke test externo multipart alcançou a aplicação e recebeu `401` JSON sem sessão, em vez do `403` do gateway. Isso comprova que o transporte passa pelo gateway e chega ao middleware de autenticação. A checagem TypeScript, os 23 testes automatizados e o build de produção também foram concluídos após a alteração. A confirmação restante exige uma sessão autenticada no celular.

## URL assinada para transcrição

Com o multipart aceito pelo gateway, os registros autenticados mostraram que o processamento ainda falhava depois do upload. A causa era a URL relativa privada retornada por `storagePut` (`/manus-storage/...`), que não é um endereço que o serviço de transcrição consegue buscar. O gateway agora solicita uma URL de leitura assinada pelo `storageGetSignedUrl` e somente essa URL é enviada ao provedor; o caminho interno e os bytes de áudio permanecem fora do log de auditoria.

O comportamento foi coberto por teste de unidade que confirma uma URL assinada no provedor. A checagem TypeScript e a regressão de 23 testes foram aprovadas. A validação final permanece dependente de uma gravação autenticada no navegador do usuário.

## Compatibilidade m4a em celular

O teste no navegador desktop passou, enquanto a transcrição móvel continuou falhando. A revisão do formato revelou que navegadores móveis podem gravar `audio/mp4` com codec AAC, mas o gateway o salvava com extensão `.mp4`; a transcrição integrada declara suporte a `.m4a`, não a `.mp4`. O mapeamento agora normaliza `audio/mp4` e `audio/x-m4a` para a extensão `.m4a`, preservando MIME, tamanho, URL assinada e os controles multipart.

Foi adicionado um teste que verifica o nome `.m4a` gerado para um MIME móvel com parâmetros de codec. A checagem TypeScript, 24 testes e o build de produção foram aprovados. Resta confirmar a transcrição em um dispositivo móvel autenticado.

## Persistência de sessão em celular

Os registros do servidor apontaram requisições com cookie de sessão ausente, compatíveis com rejeição ou perda do cookie no navegador móvel. A aplicação e a API são atendidas pelo mesmo domínio; por isso, a sessão deixou de usar `SameSite=None`, que caracteriza um cookie entre sites e exige suporte a cookies de terceiros, e passou a usar `SameSite=Lax`, suficiente para o retorno OAuth em navegação de nível superior. O cookie continua `HttpOnly`, sem `Domain` explícito, com `Path=/` e com duração de um ano.

Em produção, o atributo `Secure` agora é sempre aplicado, inclusive quando o TLS é encerrado antes do processo Express. Também foi incluída uma proteção no cliente para que vários erros 401 concorrentes não iniciem mais de um redirecionamento OAuth e não substituam o nonce de estado durante uma única tentativa de login. A validação automatizada cobre o caso de proxy TLS em produção; a suíte total passou com 26 testes e o build de produção concluiu. Uma tentativa de validação externa no navegador sandbox chegou ao portal OAuth, mas não pôde ser concluída por ausência de uma sessão Manus disponível nesse ambiente. Portanto, ainda é necessária a confirmação pelo usuário no celular.

## Conversa por voz orientada ao agente

O envio de áudio deixou de devolver a transcrição ao cliente para uma segunda chamada de chat. Agora, após o armazenamento privado e a transcrição pelo provedor configurado, o servidor entrega esse texto somente ao Agent Core na mesma requisição. A transcrição não é gravada como mensagem de usuário, não aparece na interface e não é retornada na resposta HTTP.

A rota retorna exclusivamente a resposta final do agente, junto de metadados mínimos de confirmação quando cabíveis. O cliente atualiza o histórico com essa resposta e só anuncia que ela foi falada após receber o evento nativo de início da síntese. Erros, exceções e ausência de início dentro do tempo de segurança passam a informar que a resposta permanece disponível apenas no histórico. Em navegadores sem síntese de voz, o controle de ouvir é desabilitado e a limitação é explicada de forma visível. O histórico preserva a resposta do assistente como registro canônico, sem reter o texto intermediário reconhecido do áudio.

Foram incluídos testes para o Agent Core com mensagem de voz interna e para o contrato do cliente, garantindo que um payload contendo apenas `text` não seja aceito ou exibido como resposta. A cobertura também simula o início confirmado e a falha da síntese de voz. A regressão total chegou a 33 testes aprovados, com build de produção aprovado. A única evidência ainda pendente é o teste em dispositivo móvel autenticado, necessário porque permissão de microfone e política de reprodução falada são controladas pelo navegador e pelo sistema operacional.

A captura de revisão em 390 px confirmou que o painel de voz permanece legível, o atalho de ouvir fica acessível e o campo de gravação não cria rolagem horizontal. A reprodução real continua dependente da política de áudio e das permissões do navegador usado no dispositivo físico.

## Histórico de mensagem de voz sem transcrição

O histórico de conversas agora possui o campo estruturado `messageType`, com os valores `text` e `voice`. A migração aditiva foi aplicada com `text` como valor padrão, preservando todas as mensagens existentes. Antes de entregar o áudio ao Agent Core, a rota autenticada registra uma mensagem de usuário do tipo `voice` com o conteúdo fixo **“Mensagem de voz enviada.”** e a origem `voice-input-v1`; a transcrição reconhecida não participa desse registro.

A interface renderiza esse evento como uma bolha de “Mensagem de voz”, com ícone e indicação de processamento privado, em vez de revelar o texto reconhecido. A mensagem permanece submetida às mesmas verificações de organização, usuário e conversa aplicadas pelo repositório; a resposta final do agente continua registrada na sequência. Um teste de regressão confirma que o marcador de voz precede a resposta, que a fala reconhecida não consta em nenhuma mensagem persistida no cenário e que a resposta permanece associada à mesma conversa. O teste de integração inclui agora uma mensagem marcada como `voice` na conversa da Igreja A e confirma que tanto o caller da Igreja B quanto um segundo usuário da própria Igreja A recebem `FORBIDDEN` ao tentar ler essa conversa. A migração foi verificada no banco, a regressão passou com 35 testes e o build de produção foi aprovado. A inspeção visual em 375 px confirmou que a área de chat e o painel de voz continuam legíveis; a criação física da bolha depende ainda de um envio autenticado pelo usuário.

O usuário confirmou o teste em celular após a publicação: a interação foi enviada, apareceu no histórico como mensagem de voz sem revelar a fala reconhecida e a resposta final do agente foi entregue no chat e pela saída de voz disponível no navegador. Com isso, a validação manual de microfone, transcrição interna, bolha privada e resposta falada foi concluída. Não foi necessária instrumentação adicional de MIME ou provedor, pois o fluxo móvel transcorreu sem nova falha de transcrição.

## Cobertura de interface de voz

O componente de chat passou a ter teste de renderização que verifica a bolha “Mensagem de voz”, a indicação de processamento privado, a resposta seguinte do agente e a ausência de qualquer fala reconhecida no HTML produzido. O painel lateral de voz foi extraído para um componente próprio e tem teste de renderização do fallback: quando a síntese não está disponível, a explicação é exibida e o comando “Ouvir última resposta” é desabilitado. A configuração do Vitest inclui agora os testes de componentes. A regressão total passou com 39 testes, e o build de produção foi aprovado.

Quando o navegador informa que possui síntese, mas a reprodução não chega a iniciar, o painel de voz agora mostra um aviso persistente com a orientação de consultar o histórico ou tentar novamente. O botão de ouvir permanece disponível para uma nova tentativa. A cobertura de interface valida esse estado visual sem confundi-lo com a indisponibilidade total do recurso. A regressão total passou com 40 testes e o build de produção foi aprovado.

O estado de falha de início foi separado da indisponibilidade total de síntese. O chat só produz o aviso persistente de falha quando o navegador declara suporte à síntese e a tentativa não inicia; se não há suporte, o painel exibe exclusivamente a mensagem de indisponibilidade e mantém o botão desabilitado. A cobertura valida ambos os cenários no componente utilizado pela página de chat, inclusive a prevenção de duplicidade entre avisos. A regressão total passou com 42 testes e o build de produção foi aprovado.

O painel de voz que a própria página `PastoralChat` utiliza agora possui teste de apresentação integrado. O cenário de suporte à síntese com falha de início apresenta o aviso persistente e preserva uma nova tentativa; o cenário sem suporte exibe somente a indisponibilidade e desabilita a ação. A regressão total passou com 44 testes em 15 arquivos, e o build de produção foi aprovado.

Após reiniciar os serviços de desenvolvimento, a verificação visual em 375 px mostrou a página do assistente renderizada sem erro de compilação, com histórico, campo de mensagem e painel “Voz” legíveis e sem rolagem horizontal. O painel apresentou o comando de ouvir no estado normal de síntese disponível; os estados alternativos permanecem cobertos pelos testes de apresentação e de lógica.

## Espelho privado no GitHub

O espelho foi criado no repositório privado [`cuecagg-oss/pastoral-agent-platform`](https://github.com/cuecagg-oss/pastoral-agent-platform), com branch padrão `main`. A API autenticada do GitHub confirmou o último commit `06e941ec` e a presença dos arquivos de aplicação, documentação, `client`, `server`, `drizzle` e `todo.md`. Uma visita ao mesmo endereço em navegador sem sessão GitHub retornou a página 404 padrão; esse é o comportamento de privacidade esperado para repositórios privados sem autenticação. O acesso deve ser feito com a conta que possui permissão para a organização `cuecagg-oss`.

Após confirmação explícita do usuário, a visibilidade foi alterada para pública. Uma nova visita anônima confirmou que [`cuecagg-oss/pastoral-agent-platform`](https://github.com/cuecagg-oss/pastoral-agent-platform) apresenta o badge **Public**, o branch `main`, o commit `06e941e` e os diretórios `client`, `server`, `drizzle` e `shared`, sem exigir login no GitHub. A listagem em modo leitura indicou que este é o único repositório acessível sob `cuecagg-oss` no momento da verificação, eliminando risco de confusão com outro projeto homônimo.

## Validação final de sessão móvel

O usuário confirmou em dispositivo móvel que a sessão permaneceu ativa após o login Manus OAuth, a atualização da página e a alternância entre o dashboard e o Assistente Pastoral. Assim, a correção de cookies de primeira parte, `Secure` obrigatório em produção e proteção contra redirecionamentos OAuth concorrentes foi validada no fluxo real. Como não houve nova expiração, não foi necessária a instrumentação condicional para distinguir bloqueio de cookies, ausência pós-callback ou incompatibilidade de navegador.

## Evolução arquitetural e validação consolidada

A evolução posterior consolidou o `AgentGateway` por tenant, o catálogo declarativo de ferramentas, a configuração persistida por organização, confirmações idempotentes e auditoria enriquecida com `requestId`, resultado, confirmação e provedor/modelo. Os controles administrativos foram mantidos sanitizados: chaves, URLs internas, prompts privados, transcrições e erros brutos não foram retornados à interface nem incluídos na auditoria.

Hermes foi implementado como caminho opt-in, com timeout, retries limitados, circuit breaker, resposta estruturada e fallback obrigatório ao `AgentCore` local. O n8n continua desativado por padrão, com allowlist de identificadores e sem URL, webhook ou workflow arbitrário. O Dashboard passou a combinar métricas tradicionais, tendências, pendências com escopo declarado e uma camada inteligente determinística somente leitura; a área de Configurações passou a exigir papel administrativo tanto na interface quanto no servidor.

Na validação de encerramento, a regressão Vitest aprovou **74 testes em 25 arquivos**, a checagem TypeScript e o build de produção concluíram sem erros, e a auditoria de dependências não encontrou vulnerabilidades conhecidas. Foram feitas inspeções visuais de Dashboard, Assistente Pastoral e Configurações em desktop e celular. O checkpoint de referência é `1ef5db45`; o ambiente publicado permanece acessível em [pastoralai-js2vazr4.manus.space](https://pastoralai-js2vazr4.manus.space).

## Ciclo THÁNOS — validação final

As Fases A–F consolidaram o núcleo THÁNOS sem substituir a rota pública do Assistente Pastoral. Foram caracterizados os contratos existentes, criada a separação tipada entre `workspaceKey`, `tenantId` e `domain`, implantados registros fechados de workspace/skill, adaptadores de leitura e uma fachada compatível para o primeiro workspace Pastoral. A skill declarativa permanece limitada ao canal `chat`, à capability `agent:read` e às ferramentas de categoria `READ`.

O piloto multi-step encadeia `consultar_celulas`, `consultar_presenca` e, quando a intenção fechada exige, `consultar_relatorios`, sempre com o mesmo contexto de organização. Ele compõe apenas evidências autorizadas, audita cada etapa e usa fallback determinístico para falha operacional.

## Adoção pública controlada do THÁNOS

O novo roteador público foi caracterizado sobre o contrato de conversa existente e começa desativado por padrão. A elegibilidade depende exclusivamente de configuração server-side, audiência explícita de organização e/ou usuário e intenção READ fechada; `THANOS_PILOT_KILL_SWITCH=true` força a rota legada antes de qualquer execução. O caminho THÁNOS persiste a mensagem do usuário uma única vez, preserva `conversationId`, `requestId` e tenant. Se houver falha inesperada, o `AgentGateway` responde com `persistUserMessage=false`, sem duplicar a entrada do histórico.

Foram cobertos roteamento de duas e três etapas, tenant/usuário fora da audiência, kill switch, intenção não elegível, fallback de exceção, fallback determinístico, telemetria sanitizada e compatibilidade da fachada. A validação aprovou `pnpm check`, build de produção, **102 testes Vitest em 34 arquivos** e auditoria de dependências de produção sem vulnerabilidades conhecidas. Após reinício, o servidor iniciou sem erro de tipagem ou módulo; a revisão visual do Dashboard permaneceu funcional. Escrita, voz, visitantes, líderes, consulta entre organizações e ferramentas `SENSITIVE` continuam fora da rota THÁNOS.

## Correção de atomicidade e prova pública

Foi corrigido o ponto de falha pós-resposta identificado na adoção pública. A persistência da mensagem de usuário, a execução THÁNOS e a telemetria de rota agora são estágios separados. Se a persistência inicial falha, o núcleo não é chamado e o legado mantém a responsabilidade de gravar a mensagem. Se o THÁNOS falha após a entrada já existir, o legado recebe `persistUserMessage=false`. Se a telemetria falha depois de uma resposta THÁNOS válida, não há retorno ao legado, não há segunda resposta e é gerado apenas um evento sanitizado de falha de telemetria.

O orquestrador multi-step passou a registrar duração não negativa para cada etapa. A auditoria de etapa contém o `requestId` comum, `workspaceKey`, `tenantId`, domínio, índice e ferramenta; as provas abrangem a terceira consulta `consultar_relatorios` em sucesso, falha parcial e tenant B, sem cruzamento de contexto. A mutation pública foi exercitada com piloto desligado, público e intenção elegíveis, audiência e intenção não elegíveis, falha THÁNOS e kill switch, confirmando exatamente uma entrada de usuário e uma resposta de assistente por envio.

O rollback foi executado em cenário controlado pela configuração de runtime: o plano READ elegível foi aceito e, em seguida, o kill switch redirecionou imediatamente as novas mensagens ao caminho legado. Nenhuma configuração publicada foi alterada. A regressão aprovou **107 testes em 34 arquivos**, além de `pnpm check`, build de produção e auditoria de dependências sem vulnerabilidades conhecidas.

## Fechamento das pendências de validação THÁNOS

A medição de duração foi deslocada para antes das verificações de capability. Assim, uma etapa negada recebe `durationMs` finito e não negativo, com o mesmo `requestId`, tenant, workspace, domínio, ferramenta e índice do fluxo autorizado; nenhum executor ou repositório é chamado quando a autorização falha.

`consultar_relatorios` recebeu provas dedicadas de sucesso isolado, seleção no terceiro passo composto, desabilitação no catálogo, papel sem autorização, capability ausente, falha parcial e isolamento de tenant. As recusas ocorrem antes da consulta e não persistem resposta. A auditoria de três etapas confirma duração não negativa para células, presença e relatórios, sem registrar a pergunta original.

A prova operacional final usou variáveis temporárias somente no processo de teste. Ela ativou a audiência controlada, confirmou o roteamento THÁNOS para o plano READ de três ferramentas, aplicou o kill switch para a requisição imediatamente posterior, confirmou a resposta pelo legado e restaurou todos os valores de ambiente de origem. Nenhuma configuração de produção foi gravada ou publicada durante o exercício. A regressão final aprovou **113 testes em 35 arquivos**, `pnpm check`, build de produção e auditoria de dependências sem vulnerabilidades conhecidas.

## Governed Action Runtime — prova synthetic READ/WRITE

A branch empilhada sobre o checkpoint integrado `669ed725715001b0adf2e4f2e26a2675a831c6ab` adicionou `ActionIntent` declarativo e `ThanosGovernedActionRuntime` como composição interna única. O runtime resolve contexto, workspace, skill, operação e connector a partir dos registries trusted; não aceita authority, capability, tenant efetivo ou status textual do caller; aplica a `channelPolicy`; devolve evidence e audit sanitizados; e não altera a rota pública do piloto.

A prova end-to-end usa somente o workspace `synthetic-operations`, connectors determinísticos e armazenamento em memória. READ executou sem grant. WRITE permaneceu `confirmation_pending` sem incrementar o executor, confirmou somente por `confirmationId` e `idempotencyKey`, emitiu grant trusted com vínculos de usuário, conversa, tenant, workspace, operação, connector, fingerprint, TTL e `originRequestId`, e consumiu esse grant uma única vez no Connector Registry. A execução também comprovou tenant/workspace/domain isolados, ausência de payload sensível na evidência, auditoria com `requestId`, replay negado, payload adulterado, grant forjado, TTL expirado, usuário/conversa/capability/skill/operação/connector incompatíveis, concorrência deduplicada e falha do connector sem retry automático.

A suíte focada passou com **7 testes**. A regressão synthetic-safe passou com **45 arquivos e 175 testes**. `pnpm check`, build de produção e `git diff --check` passaram. A execução local completa registrou **45 arquivos aprovados, 175 testes aprovados e 9 falhas** exclusivamente nos testes de integração pastoral que exigem `DATABASE_URL`/banco de teste indisponível no sandbox local; esses testes não foram classificados como regressão funcional verde local e serão cobertos pelo workflow MySQL 8.4 efêmero após a publicação. Não houve rede, banco, Hermes, n8n, WhatsApp, Telegram, produção ou connector externo durante a prova.

A implementação permanece sem rota pública e com Hermes/piloto desativados por padrão. O rollback é a remoção/reversão dos commits da branch empilhada; o caminho público legado e o piloto READ existente não foram alterados.

## Command Center THÁNOS — experiência visual sanitizada

A branch de experiência adicionou um Command Center frontend sobre os contratos existentes, sem alterar a arquitetura funcional aprovada. O shell apresenta identidade THÁNOS, modo USER e modo SUPERADMIN, sidebar/drawer responsivo, workspace ativo, chat persistente, voz privada, evidence sanitizada, joias, poderes e confirmação visual. A navegação SUPERADMIN é uma superfície de apresentação e só deve ser alimentada por autorização server-side; a URL, role ou estado do cliente não criam autoridade.

A interface não serializa `ThanosConfirmationGrant`, payload, connector interno, segredo, allowlist, `platformRole`, `platformCapabilities` ou erro bruto. A confirmação visual informa que a execução pública WRITE continua desativada nesta fase. WhatsApp, Telegram, webhook, n8n, Hermes remoto e providers externos aparecem somente como estados `Em breve`/`Desativado` quando aplicável e não recebem execução, credenciais ou configuração pela UI.

As provas frontend passaram com **10 arquivos e 34 testes**, incluindo navegação USER/SUPERADMIN, renderização estática do shell, drawer mobile, labels ARIA, evidence sem payload/grant, confirmação pending/blocked, status online/pending/disabled, capacidades disponíveis/futuras, privacidade da voz e fallback do chat. `pnpm check`, build de produção e `git diff --check` passaram. A screenshot desktop, a screenshot mobile após o ajuste de contraste e a screenshot SUPERADMIN não autorizado foram inspecionadas; o mobile não apresentou overflow e os prompts sugeridos ficaram legíveis após regra escopada ao Command Center.

A regressão local completa passou com **47 arquivos e 189 testes**, com **9 falhas exclusivamente nos testes de integração pastoral dependentes de `DATABASE_URL`/banco de teste indisponível** no sandbox local. Nenhuma rota pública nova, produção, Hermes, n8n, WhatsApp, Telegram ou WRITE externo foi ativado. O rollback é a reversão dos commits da branch de experiência, preservando o shell e as rotas legadas.
