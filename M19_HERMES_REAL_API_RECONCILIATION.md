# THÁNOS — M19.2 Reconciliação com a API real do Hermes

## Resultado local

O cliente THÁNOS foi reconciliado com a API oficial do Hermes `v0.21.0`: a geração agora usa `POST /v1/chat/completions`, Bearer auth e o formato OpenAI-compatible. O contrato proprietário anterior `/v1/agent/respond` deixou de ser usado pelo código executável.

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

## Validação executada

- Testes focados: 7 arquivos, 48 testes aprovados.
- Typecheck: aprovado.
- Build: aprovado.
- `git diff --check`: aprovado.
- Suíte ampla sem banco: 211 testes aprovados; 9 testes de integração recusaram execução porque o MySQL de teste não está disponível neste ambiente. Essa limitação não pertence ao contrato Hermes.

## n8n

Não existe bridge n8n versionada neste baseline. O único artefato encontrado é o conector governado preparatório `server/pastoral/n8nConnector.ts`, desativado por padrão e sem execução externa; ele foi preservado. Qualquer bridge temporária existente apenas no servidor/n8n deverá ser identificada e removida em ação operacional separada, após o cliente direto passar no gate real.

## Pendência honesta

Este ambiente não possui `HERMES_BASE_URL` nem `HERMES_API_KEY`, portanto a chamada real não foi executada aqui. O próximo gate continua sendo:

`THÁNOS → HTTPS → Hermes real → OpenRouter`

Não houve configuração de GitHub secrets, push, merge, deploy ou alteração de produção/VM.
