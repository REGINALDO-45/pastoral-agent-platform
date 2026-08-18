# Assistente Pastoral de IA — estado da implementação

## Visão geral

O Assistente Pastoral de IA é uma aplicação multi-tenant para gestão de igrejas, com autenticação Manus OAuth, Dashboard gerencial, conversa persistente, entrada de voz privada e um agente governado no servidor. A identidade vem da sessão autenticada; a organização e o papel efetivo vêm da membership resolvida no servidor. Nenhuma requisição do cliente, modelo ou conector externo define o tenant com autoridade.

## Capacidades entregues

| Área | Implementação atual | Limite de segurança |
|---|---|---|
| Dashboard | Métricas de células, presença, média, visitantes, cadastros e lideranças; tendências, pendências e camada inteligente determinística. | Todos os agregados e escopos são calculados somente para a organização atual. |
| Assistente | `AgentGateway`, `AgentCore`, `PolicyEngine`, Model Router, Tool Registry e fallback determinístico. | Modelos não recebem SQL, repositórios ou acesso direto a ferramentas. |
| Ferramentas | Catálogo declarativo com categoria, papéis, confirmação, status e descrição; habilitação persistida por organização. | Administrações só alteram ferramentas conhecidas; não criam tools arbitrárias. |
| Escritas e auditoria | Prévia, confirmação idempotente, `requestId`, resultado, provedor/modelo e estado de confirmação. | Auditoria não armazena segredos, transcrições, prompts privados ou raciocínio interno. |
| Voz | Upload multipart autenticado, armazenamento privado, URL de leitura assinada, normalização `.m4a`, transcrição interna e TTS do navegador. | A fala reconhecida não aparece no histórico; apenas o marcador “Mensagem de voz” é persistido. |
| Configurações | Área administrativa com Geral, Usuários, Assistente IA, Hermes, Voz, Ferramentas, Integrações e Auditoria. | Leitura e alteração sensíveis são bloqueadas no servidor para papéis não administrativos. |
| Núcleo THÁNOS | Contexto com identidades segregadas, registros fechados, adaptador Pastoral, orquestração READ, roteador público controlado e `ThanosGovernedActionRuntime` interno. | Workspaces não acessam repositórios diretamente nem aceitam tenant, domínio, skill, operação, connector ou authority arbitrários do cliente. |
| Piloto multi-step | Sequência declarativa de `consultar_celulas`, `consultar_presenca` e `consultar_relatorios`, evidência composta, geração única e fallback determinístico. | Somente 2–3 passos READ são aceitos; cada etapa é auditada e nenhuma falha interna é retornada ao usuário. |
| Action Runtime | `ActionIntent` declarativo e runtime server-side único para READ/WRITE, com resolução trusted de catálogo, channel policy, pending/confirmed/grant/execute e evidence/audit sanitizados. | WRITE não executa sem confirmação explícita e grant consumível; a implementação exercitada é synthetic-only, in-memory e sem rota pública ou efeitos externos. |
| Command Center | Shell THÁNOS responsivo com modo USER e SUPERADMIN, navegação, chat, voz, workspace, evidence, joias, poderes e confirmação visual. | SUPERADMIN é apresentado somente após autorização server-side; a UI não cria authority, tenant, capabilities ou canais e não expõe grants, payloads, erros brutos ou segredos. WRITE público permanece bloqueado. |

## Operação do Agent Gateway

O caminho local do `AgentCore` é sempre preservado. Hermes é opcional, desativado por padrão e recebe somente um prompt controlado com a pergunta e as evidências autorizadas pela ferramenta local. O cliente Hermes possui timeout, tentativas limitadas, circuit breaker por processo, resposta estruturada validada e retorno ao caminho local em timeout, indisponibilidade ou circuito aberto. O estado exibido para administradores é sanitizado e nunca inclui URL, chave, cabeçalho ou erro bruto.

O conector n8n permanece desativado por padrão. Nesta versão, ele aceita apenas identificadores de workflow previamente allowlisted; não aceita URL, webhook, destino ou carga arbitrária e não executa saída externa sem uma aprovação futura de contrato e política.

## Configuração server-side

Todas as variáveis são configuradas fora do repositório. Para a operação do Gateway, os controles documentados são `AGENT_GATEWAY_ENABLED`, `AGENT_GATEWAY_PROVIDER`, `AGENT_GATEWAY_MODEL`, `HERMES_ENABLED`, `HERMES_MODEL`, `HERMES_BASE_URL`, `HERMES_API_KEY`, `HERMES_TIMEOUT_MS`, `HERMES_RETRIES`, `HERMES_CIRCUIT_FAILURE_THRESHOLD`, `HERMES_CIRCUIT_COOLDOWN_MS`, `N8N_ENABLED`, `N8N_ALLOWED_WORKFLOWS`, `THANOS_PILOT_ENABLED`, `THANOS_PILOT_KILL_SWITCH`, `THANOS_PILOT_ORGANIZATION_IDS`, `THANOS_PILOT_USER_IDS` e `THANOS_PILOT_VERSION`. Os valores e quaisquer segredos não são exibidos pela aplicação, pela auditoria ou por esta documentação.

Para manter o comportamento local, use o provider legado e mantenha `HERMES_ENABLED=false` e `N8N_ENABLED=false`. A voz continua usando o provider interno selecionado no servidor; sua disponibilidade final depende das permissões e recursos do navegador.

## Ciclo THÁNOS

O ciclo concluiu a extração de um núcleo genérico com contratos tipados, `ThanosContext`, registros fechados de workspace e skill, portas de auditoria/geração/execução e uma fachada compatível para o workspace Pastoral. As identidades `workspaceKey`, `tenantId` e `domain` permanecem separadas desde a construção do contexto. A skill Pastoral atual é de somente leitura e usa o catálogo pastoral já autorizado, em vez de duplicar regras de papel ou tenant no núcleo.

O piloto multi-step foi adotado de forma controlada no chat público. O roteador só o seleciona quando flag, kill switch, audiência de tenant/usuário e intenção READ fechada permitem; as intenções aceitas são células, presença, relatórios e os resumos compostos dessas três leituras. Qualquer outra mensagem, incluindo escrita, voz, consulta organizacional, visitantes e líderes, conserva o `AgentGateway`/`AgentCore`. A falha inesperada no THÁNOS usa esse mesmo legado sem persistir a mensagem do usuário uma segunda vez.

O `ThanosGovernedActionRuntime` compõe o fluxo interno único de ações. O caller declara somente o `ActionIntent`; o runtime deriva autoridade, resolve workspace/skill/operação e aplica policy no servidor. READ executa diretamente e devolve evidence sanitizada. WRITE produz `confirmation_pending`, não executa no preparo, confirma com identidade e idempotência vinculadas, emite grant trusted e consome esse grant no Connector Registry antes de uma única execução. A prova usa o workspace sintético, connectors determinísticos e armazenamento em memória, sem ativar qualquer integração externa ou rota pública.

## Validação da versão

A validação histórica desta evolução concluiu regressão Vitest com **102 testes em 34 arquivos**, checagem TypeScript, build de produção e auditoria de dependências de produção sem vulnerabilidades conhecidas. Nesta branch de experiência, os testes frontend passaram com **10 arquivos e 34 testes**, incluindo layout USER/SUPERADMIN, primitives de evidence/confirmation, privacidade de voz/chat e fallback visual; `pnpm check`, build de produção e `git diff --check` também passaram. A regressão local completa encontrou **9 testes de integração dependentes de `DATABASE_URL`/banco**, enquanto os demais **189 testes** permaneceram verdes; a validação MySQL 8.4 será repetida no CI efêmero após a publicação da branch.

O projeto publicado está disponível em [pastoralai-js2vazr4.manus.space](https://pastoralai-js2vazr4.manus.space). A versão de referência anterior à consolidação documental final é o checkpoint `9e4f5e92`.
