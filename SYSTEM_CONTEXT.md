# Contexto Operacional e de Segurança

## Modelo de acesso

O sistema opera por organização. A sessão identifica o usuário; a membership ativa resolve o tenant e o papel efetivo. O servidor aplica a autorização antes de qualquer consulta, ferramenta, confirmação, configuração ou auditoria.

| Papel | Acesso operacional previsto |
|---|---|
| Usuário com membership | Dashboard e Assistente dentro da igreja atual, conforme a política de ferramentas. |
| Líder/Pastor | Consultas e ações pastorais permitidas pela matriz de risco do tenant. |
| Admin do tenant | Configurações permitidas da própria organização, status sanitizado e auditoria local. |
| Superadmin | Capacidade futura, explícita e verificada no servidor; nunca inferida pelo cliente. |

## Dados e privacidade

| Dado | Tratamento |
|---|---|
| Áudio enviado | Armazenamento privado de curta finalidade para transcrição autorizada. |
| Roteamento de voz | Após a transcrição privada, a resposta entra pelo `AgentGateway` com o mesmo `requestId`, política e fallback local; isso não amplia o piloto THÁNOS, que continua restrito a `chat`. |
| Transcrição de áudio | Processamento interno; não aparece no histórico nem no audit log. |
| Mensagem de voz | Marcador estruturado no histórico, sem conteúdo reconhecido. |
| Métricas do Dashboard | Agregadas no servidor e sempre delimitadas ao tenant atual. |
| Insights | Dados agregados e sanitizados; sem nomes pessoais, áudio, chaves ou dados de outras organizações. |
| Auditoria | Metadados operacionais mínimos, sem segredos, transcrição ou chain-of-thought. |
| Contexto THÁNOS | `workspaceKey` identifica o workspace, `tenantId` a organização autenticada e `domain` o domínio de negócio. |
| Piloto multi-step | Duas ou três etapas READ — células, presença e relatórios — usam o mesmo contexto autenticado; evidências aprovadas são compostas e falhas operacionais usam fallback determinístico. |
| Roteamento THÁNOS | Flag, allowlists de organização/usuário e intenção fechada são avaliadas somente no servidor; o kill switch vence qualquer elegibilidade. |

## Variáveis e configuração

Configuração de provedores é exclusivamente server-side. O Gateway usa `AGENT_GATEWAY_ENABLED`, `AGENT_GATEWAY_PROVIDER` e `AGENT_GATEWAY_MODEL`; Hermes usa `HERMES_ENABLED`, `HERMES_MODEL`, `HERMES_BASE_URL`, `HERMES_API_KEY`, `HERMES_TIMEOUT_MS`, `HERMES_RETRIES`, `HERMES_CIRCUIT_FAILURE_THRESHOLD` e `HERMES_CIRCUIT_COOLDOWN_MS`. O n8n é controlado por `N8N_ENABLED` e `N8N_ALLOWED_WORKFLOWS`. O piloto THÁNOS usa `THANOS_PILOT_ENABLED`, `THANOS_PILOT_KILL_SWITCH`, `THANOS_PILOT_ORGANIZATION_IDS`, `THANOS_PILOT_USER_IDS` e `THANOS_PILOT_VERSION`. Estes nomes documentam controles, nunca valores.

Hermes e n8n iniciam desativados. Hermes só opera por caminho opt-in, timeout, retries limitados, circuit breaker e fallback local; n8n somente reconhece workflows allowlisted e não aceita URL, webhook ou carga arbitrária nesta versão.

Preferências administrativas por organização podem apenas restringir ou habilitar capacidades já allowlisted. Elas não podem criar providers, definir URLs, informar chaves, trocar modelos globais ou criar ferramentas arbitrárias.

O THÁNOS é um núcleo com registros fechados de workspace e skill. No workspace Pastoral, a skill de piloto opera apenas pelo canal `chat`, exige a capability `agent:read` e permite exclusivamente as leituras declaradas. A rota pública agora tem um roteador seletivo que só delega ao THÁNOS quando a configuração server-side autoriza tenant/usuário e a intenção pertencente à allowlist; caso contrário, usa o Agent Gateway compatível. Nenhuma ativação altera confirmações de escrita, histórico ou isolamento já vigentes.
