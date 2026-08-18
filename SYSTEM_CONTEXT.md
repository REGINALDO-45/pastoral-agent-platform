# Contexto Operacional e de Segurança

## Modelo de acesso

O sistema opera por organização. A sessão identifica o usuário; a membership ativa resolve o tenant e o papel efetivo. O servidor aplica a autorização antes de qualquer consulta, ferramenta, confirmação, configuração ou auditoria.

| Papel | Acesso operacional previsto |
|---|---|
| Usuário com membership | Dashboard e Assistente dentro da igreja atual, conforme a política de ferramentas. |
| Líder/Pastor | Consultas e ações pastorais permitidas pela matriz de risco do tenant. |
| Admin do tenant | Configurações permitidas da própria organização, status sanitizado e auditoria local. |
| Superadmin | Capacidade futura, explícita e verificada no servidor; nunca inferida pelo cliente. |

## Generalidade do núcleo THÁNOS

O bootstrap mantém o workspace Pastoral e um workspace sintético `synthetic-operations` com skill `READ-only` e executor determinístico. Essa entrada existe para provar isolamento de `workspaceKey`, `tenantId` e `domain`; ela não é exposta por rota pública, não importa ferramentas pastorais e não altera a audiência do piloto `chat`.

O `ThanosContext` também carrega `platformRole` e `platformCapabilities` separadamente do `role` e das capabilities do tenant. O valor padrão é `role: none` sem capabilities; mesmo `superadmin` só pode usar capabilities globais explicitamente concedidas, e a fundação ainda não cria rota pública para listar, ler ou assumir tenants.

O núcleo dispõe de um planner READ interno para planos declarados de dois a cinco passos. Ele faz preflight de capabilities, recusa intenção `WRITE`, cria uma referência de contexto por passo e devolve fallback parcial determinístico em caso de falha. Cada evidência recebe proveniência de fonte, workspace, tenant, `requestId`, ferramenta e etapa; essa proveniência é metadado sanitizado e não representa armazenamento de prompt, áudio, transcrição ou segredo.

Os contratos de canais são channel-agnostic: envelopes e respostas carregam canal, tipo de payload, `requestId`, workspace e tenant, enquanto a `channelPolicy` mantém uma allowlist explícita e pode ser READ-only. O núcleo conhece nomes de canais futuros para fins de validação, mas não configura WhatsApp, Slack, email, webhook ou credenciais externas; payloads não autorizados e eventos mutáveis são recusados antes da execução.

O Connector Registry é uma porta interna fechada: cada connector precisa de manifest, key na allowlist, capability compatível, canais e payloads permitidos, além de estar explicitamente habilitado. A execução mantém o `requestId` do contexto, recusa divergência de escopo e exige, para `WRITE`, um grant consumível produzido pelo Confirmation Engine. A autoridade de validação/consumo do grant é injetada server-side no construtor trusted; `execute()` não aceita um validator fornecido pelo caller. O grant é vinculado a `userId`, `conversationId` quando aplicável, tenant, workspace, operação, connector e fingerprint recalculado do payload; `originRequestId` registra a requisição que originou a confirmação, enquanto confirmação e consumo preservam seus próprios requestIds. `createdAt`/`expiresAt` definem o TTL, e o consumo único impede replay. `confirmationStatus` permanece apenas metadado de resposta/auditoria e nunca concede autorização. A idempotência deduplica a confirmação por chave e escopo, sem prometer exactly-once do efeito externo. A execução audita somente resultado sanitizado. Os connectors usados nos testes são mocks determinísticos e não representam integração externa ativa.

O `ThanosGovernedActionRuntime` é a composição interna única para `Action Intent` READ/WRITE. Ele resolve no servidor o contexto, workspace, skill e operação trusted; valida a relação entre intent e catálogo, aplica channel policy e delega a execução ao Connector Registry. READ pode retornar evidência diretamente. WRITE retorna `confirmation_pending` sem executar, confirma somente por `confirmationId` e `idempotencyKey`, emite grant trusted e só então consome o grant durante a execução. Nenhuma authority, capability, tenant efetivo ou status textual enviado pelo caller é aceito como autorização. A prova atual usa o workspace `synthetic-operations`, connectors in-memory e nenhuma rota pública, banco, rede, Hermes, n8n ou efeito externo.

## Dados e privacidade

| Dado | Tratamento |
|---|---|
| Áudio enviado | Armazenamento privado de curta finalidade para transcrição autorizada. |
| Roteamento de voz | Após a transcrição privada, a resposta entra pelo `AgentGateway` com o mesmo `requestId`, política e fallback local; isso não amplia o piloto THÁNOS, que continua restrito a `chat`. |
| Transcrição de áudio | Processamento interno; não aparece no histórico nem no audit log. |
| Mensagem de voz | Marcador estruturado no histórico, sem conteúdo reconhecido. |
| Métricas do Dashboard | Agregadas no servidor e sempre delimitadas ao tenant atual. |
| Insights | Dados agregados e sanitizados; sem nomes pessoais, áudio, chaves ou dados de outras organizações. |
| Auditoria | Metadados operacionais mínimos, sem segredos, transcrição ou chain-of-thought; confirmações registram apenas decisão, identidade/escopo sanitizados e resultado do grant. |
| Contexto THÁNOS | `workspaceKey` identifica o workspace, `tenantId` a organização autenticada e `domain` o domínio de negócio. |
| Piloto multi-step | Duas ou três etapas READ — células, presença e relatórios — usam o mesmo contexto autenticado; evidências aprovadas são compostas e falhas operacionais usam fallback determinístico. |
| Roteamento THÁNOS | Flag, allowlists de organização/usuário e intenção fechada são avaliadas somente no servidor; o kill switch vence qualquer elegibilidade. |
| Action Runtime | `ActionIntent` declarativo e runtime interno channel-agnostic para READ/WRITE, com pending/confirmed/grant/execute e evidence/audit sanitizados. | Somente a composição trusted pode resolver catálogo e consumir grants; a prova WRITE é synthetic-only e permanece desconectada de produção e integrações externas. |

## Variáveis e configuração

Configuração de provedores é exclusivamente server-side. O Gateway usa `AGENT_GATEWAY_ENABLED`, `AGENT_GATEWAY_PROVIDER` e `AGENT_GATEWAY_MODEL`; Hermes usa `HERMES_ENABLED`, `HERMES_MODEL`, `HERMES_BASE_URL`, `HERMES_API_KEY`, `HERMES_TIMEOUT_MS`, `HERMES_RETRIES`, `HERMES_CIRCUIT_FAILURE_THRESHOLD` e `HERMES_CIRCUIT_COOLDOWN_MS`. O n8n é controlado por `N8N_ENABLED` e `N8N_ALLOWED_WORKFLOWS`. O piloto THÁNOS usa `THANOS_PILOT_ENABLED`, `THANOS_PILOT_KILL_SWITCH`, `THANOS_PILOT_ORGANIZATION_IDS`, `THANOS_PILOT_USER_IDS` e `THANOS_PILOT_VERSION`. Estes nomes documentam controles, nunca valores.

Hermes e n8n iniciam desativados. Hermes só opera por caminho opt-in, timeout, retries limitados, circuit breaker e fallback local; n8n somente reconhece workflows allowlisted e não aceita URL, webhook ou carga arbitrária nesta versão.

Preferências administrativas por organização podem apenas restringir ou habilitar capacidades já allowlisted. Elas não podem criar providers, definir URLs, informar chaves, trocar modelos globais ou criar ferramentas arbitrárias.

O THÁNOS é um núcleo com registros fechados de workspace e skill. No workspace Pastoral, a skill de piloto opera apenas pelo canal `chat`, exige a capability `agent:read` e permite exclusivamente as leituras declaradas. A rota pública agora tem um roteador seletivo que só delega ao THÁNOS quando a configuração server-side autoriza tenant/usuário e a intenção pertencente à allowlist; caso contrário, usa o Agent Gateway compatível. Nenhuma ativação altera confirmações de escrita, histórico ou isolamento já vigentes.
