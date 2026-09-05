# THÁNOS — M19.2 Reconciliação com a API real do Hermes

## Resultado

O cliente THÁNOS foi reconciliado com a API oficial do Hermes `v0.21.0`: a geração agora usa `POST /v1/chat/completions`, Bearer auth e o formato OpenAI-compatible. O contrato proprietário anterior `/v1/agent/respond` deixou de ser usado pelo código executável.

Em 2026-09-05, o gate controlado percorreu com sucesso `THÁNOS → HTTPS → Hermes real → OpenRouter` usando exclusivamente contexto sintético e sem dados pastorais.

O body externo contém somente:

- `model` configurado server-side;
- uma mensagem `system` sanitizada;
- uma mensagem `user` com a pergunta e a evidência READ autorizada;
- `stream: false`.

`requestId` segue no THÁNOS e é enviado como `Idempotency-Key` para deduplicar retries. Fallback, tenant, workspace, capabilities, isolation key e objetos internos não são enviados no body. A resposta aceita o envelope oficial e extrai somente `choices[0].message.content` e `model`.

## Fronteiras preservadas

- HTTPS obrigatório; HTTP, FTP, WS/WSS, credenciais na URL, query e fragmento são recusados.
- Hosts `prod`, `production`, `live` e a denylist explícita são recusados.
- Bearer auth permanece server-side.
- Timeout, retries limitados, circuit breaker isolado por organização e fallback determinístico permanecem ativos.
- Tenant, workspace, skill, tools e capabilities continuam decididos pelo THÁNOS.
- Nenhum caminho WRITE/SENSITIVE, n8n, Telegram, WhatsApp ou produção foi habilitado.

## Gate de segurança do Hermes

Na versão oficial auditada (`1cb3ab617363ffab9e55239a7d2ab0d6f9c10473`), a plataforma `api_server` pode expor toolsets próprios do Hermes. Como Hermes deve atuar apenas como motor de resposta nesta integração, o script do gate real consulta `GET /v1/toolsets` e falha fechado se qualquer toolset estiver habilitado. O host também precisa coincidir exatamente com `HERMES_EXPECTED_HOST`.

Na prova real, a superfície `api_server` foi restringida a zero toolsets. O alias exato `hermes-live-sandbox` foi mapeado server-side para `openrouter/free`, mantendo `direct_model_requests=false`; assim, a integração não habilita escolha arbitrária de modelo nem altera o modelo global do Hermes.

## Validação executada

- Testes focados: 7 arquivos, 48 testes aprovados.
- Typecheck: aprovado.
- Build: aprovado.
- `git diff --check`: aprovado.
- Suíte ampla sem banco: 211 testes aprovados; 9 testes de integração recusaram execução porque o MySQL de teste não está disponível neste ambiente. Essa limitação não pertence ao contrato Hermes.

## Prova operacional real

| Fronteira | Evidência sanitizada |
| --- | --- |
| Boundary | Credencial presente, Hermes habilitado, provider `hermes`, 1 organização autorizada, piloto desligado, kill switch ligado, n8n desligado, 0 toolsets Hermes, endpoint não produtivo e contexto sintético |
| Health | Sucesso na primeira tentativa; 145 ms |
| Geração | Sucesso; token sintético esperado confirmado; auditoria presente |
| Métricas | 2 chamadas, 2 sucessos, 0 erros, 0 fallbacks, 0 respostas inválidas e circuito fechado; p95 de 2.408 ms |
| Falha controlada | Fallback executado, `requestId` preservado, 1 tentativa externa e nenhuma execução funcional duplicada |
| Rollback | Hermes desabilitado, provider legado restaurado, kill switch ligado e 0 novas chamadas Hermes |
| Auditoria | Saída sanitizada |

Durante o gate, o script de prova revelou que consultava propriedades antigas do status de saúde (`connected`/`failure`). A correção usa o contrato vigente (`connection`/`lastFailure`) e foi validada pelo typecheck, pelos testes focados e pela execução real acima.

## n8n

Não existe bridge n8n versionada neste baseline. O único artefato encontrado é o conector governado preparatório `server/pastoral/n8nConnector.ts`, desativado por padrão e sem execução externa; ele foi preservado. Qualquer bridge temporária existente apenas no servidor/n8n deverá ser identificada e removida em ação operacional separada, após o cliente direto passar no gate real.

## Classificação final

> **M19 PRONTO PARA AUDITORIA EXTERNA**

O gate real, a falha controlada, o rollback e a auditoria sanitizada foram aprovados. Isso não autoriza rollout produtivo: piloto, n8n, WRITE/SENSITIVE e integrações adjacentes continuam desligados.

Não houve persistência de credenciais no repositório, configuração de GitHub secrets, merge ou deploy. O limite de créditos do modelo global `anthropic/claude-opus-4.6` permanece uma restrição operacional separada; o gate usou somente o alias controlado descrito acima.
