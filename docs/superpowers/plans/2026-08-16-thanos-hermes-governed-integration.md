# THÁNOS → Hermes Governed Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conectar o caminho público THÁNOS ao Hermes opt-in do tenant após tools READ locais, com fallback determinístico e correlação única.

**Architecture:** `AgentGateway` passa a expor uma porta de geração que resolve a configuração do tenant e reutiliza seu único `HermesClient`. A `PastoralThanosFacade` recebe essa porta na composição de `server/routers.ts`; as tools continuam locais e allowlisted, e apenas o prompt controlado com evidência autorizada chega ao provider.

**Tech Stack:** TypeScript 5.9, Vitest, tRPC, Drizzle, pnpm.

**Spec:** `docs/stories/1.1-thanos-hermes-governed-integration.md`

## Global Constraints

- Piloto e Hermes continuam desativados por padrão.
- Nenhuma alteração de produção, credencial, WRITE, SENSITIVE, voz ou n8n.
- Tenant somente do backend; tools somente READ e allowlisted.
- Mesmo `requestId` em rota, tools, provider e auditoria.
- Falhas externas nunca expõem erro bruto, URL, chave, prompt ou evidência em auditoria/status/resposta.

---

### Task 1: Prova integrada do caminho público

**Files:**
- Create: `server/pastoral/thanosHermes.integration.test.ts`
- Modify: nenhum arquivo de produção nesta tarefa

**Interfaces:**
- Consumes: `ThanosPilotRouter`, `PastoralThanosFacade`, `AgentGateway`, `HermesClient`.
- Produces: teste que exige `route=thanos`, três tools, `provider=hermes`, `fallback=false` e um único `requestId`.

- [x] Escrever o teste com repository em memória e transporte Hermes controlado.
- [x] Executar o teste e confirmar falha porque `PastoralThanosFacade` ainda não alcança `AgentGateway.generate`.

### Task 2: Porta governada de geração

**Files:**
- Modify: `server/pastoral/modelRouter.ts`
- Modify: `server/pastoral/agentGateway.ts`
- Test: `server/pastoral/agentGateway.test.ts`

**Interfaces:**
- Consumes: `ModelGenerationInput`, `TenantGatewayConfig`, `HermesClient.generate()`.
- Produces: `AgentGateway.generate({ context, requestId, system, user, fallback })` com metadados sanitizados de gateway.

- [x] Adicionar testes falhando de sucesso, fallback e isolamento por tenant.
- [x] Implementar a menor porta que resolve configuração, tenta Hermes e retorna fallback determinístico para falhas conhecidas.
- [x] Auditar tentativas somente com código sanitizado e `requestId`.
- [x] Rodar os testes focalizados até ficarem verdes.

### Task 3: Composição THÁNOS

**Files:**
- Modify: `server/workspaces/pastoral/thanosFacade.ts`
- Modify: `server/pastoral/thanosPilotRouter.ts`
- Modify: `server/routers.ts`
- Test: `server/pastoral/thanosHermes.integration.test.ts`
- Test: `server/workspaces/pastoral/thanosFacade.test.ts`
- Test: `server/pastoral/thanosPilotRouter.test.ts`

**Interfaces:**
- Consumes: gerador governado injetado e adapters READ existentes.
- Produces: resposta `AgentResponse` com provider/model reais, metadado de fallback e correlação preservada.

- [x] Injetar a mesma instância de `AgentGateway` na fachada.
- [x] Propagar contexto/requestId à geração sem acoplar o core THÁNOS ao domínio Pastoral.
- [x] Marcar fallback governado sem trocar a rota nem repetir tools/mensagens.
- [x] Rodar a prova integrada até ficar verde.

### Task 4: Resiliência e segurança

**Files:**
- Modify: `server/pastoral/hermesClient.test.ts`
- Test: `server/pastoral/thanosHermes.integration.test.ts`

**Interfaces:**
- Consumes: contrato oficial OpenAI-compatible `POST /v1/chat/completions` (o contrato histórico `/v1/agent/respond` foi substituído na reconciliação M19.2).
- Produces: cobertura de timeout, rede, resposta inválida, circuito e ausência de secrets.

- [x] Adicionar testes falhando para cada código de falha relevante.
- [x] Corrigir somente comportamentos não cobertos confirmados pelos testes.
- [x] Reexecutar testes focalizados.

### Task 5: Verificação e checkpoint

**Files:**
- Modify: `docs/stories/1.1-thanos-hermes-governed-integration.md`
- Modify: `docs/superpowers/plans/2026-08-16-thanos-hermes-governed-integration.md`

**Interfaces:**
- Consumes: scripts reais `test`, `check` e `build` do `package.json`.
- Produces: evidência local atual e File List final.

- [x] Rodar testes focalizados.
- [x] Rodar `pnpm test`: 138 testes aprovados em 37 arquivos no sandbox MySQL 8.4.
- [x] Rodar `pnpm check`: aprovado.
- [x] Rodar `pnpm build`: aprovado.
- [x] Aplicar migrations no MySQL 8.4 efêmero e isolado: aprovado.
- [x] Comprovar isolamento entre proprietário, outro usuário da mesma organização e usuário de outra organização.
- [x] Auditar `git diff --check`, `git diff --stat`, diff completo e `git status`.
- [x] Atualizar checkboxes e registrar riscos residuais sem publicar ou fazer rollout.
- [x] Registrar que a prova contra o Hermes remoto permanece pendente; nenhuma credencial Hermes foi utilizada, e piloto e Hermes continuam desativados.
