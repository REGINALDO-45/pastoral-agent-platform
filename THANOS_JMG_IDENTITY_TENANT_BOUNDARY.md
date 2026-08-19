# THÁNOS M22 — JMG Identity & Tenant Boundary

**Status:** M22 — BLOQUEIO ARQUITETURAL/HUMANO REAL  
**Data da decisão:** 2026-08-19  
**Branch:** `agent/thanos-jmg-identity-boundary`  
**Base congelada:** `d73a0453a085579e3727b3de3410e842503670fc`  
**Escopo:** decisão de identidade, tenant e boundary. Nenhum transporte ou integração real.

## 1. Problema

O M21 deixou congelada a fundação business-only de `jmg_resumo_propostas`: contrato READ, `JmgReadAdapter`, `InMemoryJmgReadAdapter`, input vazio estrito e output limitado a `totalAbertas`, `emNegociacao`, `aguardandoResposta` e `valorPipeline`. O M22 precisa responder, antes de qualquer composição operacional, em nome de quem o THÁNOS agirá ao consultar o JMG e qual escopo confiável limitará essa execução.

A pergunta não pode ser resolvida atribuindo um valor conveniente a `tenantId`, reaproveitando `workspaceKey`, aceitando role do cliente/modelo/canal ou tratando a existência da tabela `empresas` como prova suficiente de multi-tenancy. O core do THÁNOS exige um `ThanosContext` trusted completo; por isso a decisão deve ser semântica, não apenas algo que compile.

## 2. Decisão resumida

**Não existe, nas evidências versionadas inspecionadas, uma identidade operacional de integração e um tenant/boundary JMG semanticamente equivalentes aos conceitos exigidos pelo THÁNOS.** Portanto, o M22 termina em **BLOQUEIO ARQUITETURAL/HUMANO REAL**.

A decisão correta neste ciclo é não criar `ThanosContext` operacional para JMG, não registrar JMG nos registries default, não escolher `empresas` como tenant por conveniência e não alterar o core para tornar `tenantId` opcional. A fundação M21 permanece business-only e intacta.

O bloqueio é deliberado: falta uma decisão real do domínio JMG sobre como usuários autenticados se vinculam a uma empresa/conta/escopo comercial, ou sobre a criação de um service principal de integração com escopo explícito. Sem essa decisão e sua implementação persistida/RLS, qualquer autorização seria uma simulação.

## 3. Evidências do THÁNOS

| Conceito | Evidência | Significado operacional |
|---|---|---|
| `workspaceKey` | `server/thanos/contextIdentity.ts`, `contracts.ts` e registries | Identidade do produto/workspace; não identifica tenant nem usuário. |
| `tenantId` | `ThanosContextIdentity`; `tenantIdFromOrganizationId()` | Boundary de isolamento confiável. No Pastoral deriva de `organizationId` real; no Synthetic é fornecido como tenant explícito. |
| `domain` | `contextIdentity.ts` e definições de workspace | Domínio semântico do workspace; não substitui tenant. |
| `userId`/`userName` | `ThanosContext` e `context.ts` | Identidade humana confiável, resolvida server-side. |
| `role`/`capabilities` | `context.ts`, `workspaceDefinition.ts` e policy | Autoridade derivada de fonte trusted; não pode vir do prompt, modelo, cliente ou canal. |
| `platformRole`/`platformCapabilities` | `createPlatformAccess()` e contexto | Autoridade de plataforma, deny-by-default e separada do domínio/tenant. |
| `channel` | Source de cada workspace e `ThanosContext` | Metadata de transporte/contexto; não é identidade nem autorização por si só. |
| `requestId` | Gerado ou aceito somente na composição server-side | Metadata de correlação; não é identidade ou tenant. |
| Governança | `governedActionRuntime.ts`, `connectorRegistry.ts`, `evidence.ts` | Execução verifica contexto trusted, workspace, tenant, domain, skill, capabilities, connector allowlist e request. |

No workspace Pastoral, `tenantId` é derivado de `tenantContext.organizationId`, enquanto `userId`, `userName` e `role` vêm do `TenantContext` trusted e as capabilities são calculadas pelo role. No workspace Synthetic, `tenantId` é uma entrada explícita do source trusted. Ambos demonstram que o core não possui um modo sem tenant para uma execução operacional normal.

## 4. Evidências do JMG

A inspeção foi feita na cópia auditável `REGINALDO-45/jmgengenharia`, branch `agent/jmg-thanos-read-foundation`, SHA `5738278661dcf3823b7fa4a5f5294939eb1269ba`, sem consulta ao banco remoto e sem inicializar o aplicativo.

### 4.1 Actor humano atual

`src/integrations/supabase/auth-middleware.ts` exige um Bearer token, chama `supabase.auth.getUser(token)` e injeta server-side `userId` como `auth.users.id`, além do cliente Supabase autenticado. O `profiles.id` referencia `auth.users(id)`. A tabela `user_roles` referencia o mesmo usuário e persiste um `app_role` com unicidade por usuário/role.

A migration fundacional define `has_role()` como função `SECURITY DEFINER`, permite ao usuário consultar seus próprios roles e reserva aos administradores a gestão dos roles. Os roles versionados incluem `admin`, `gerente`, `vendedor`, `financeiro`, `estoque`, `cliente`, `estoquista`, `super_admin` e `suporte` no schema gerado.

Assim, o único actor humano comprovado hoje é o usuário JMG autenticado, identificado server-side por `auth.users.id`, com role derivado de `user_roles`/RLS. Não foi comprovado um vínculo THÁNOS↔usuário JMG nem um actor de integração dedicado.

### 4.2 Empresa e ausência de tenant comprovado

A tabela `public.empresas` contém `id`, `nome`, `cnpj`, `slug`, `plano`, `ativa` e timestamps. Ela não possui `user_id`, `organization_id`, `account_id`, `company_id`, membership ou outra relação visível com `profiles`, `user_roles` ou as linhas de `propostas`. A tabela `propostas` também não possui `empresa_id`, `organization_id`, `account_id` ou equivalente; seus vínculos comerciais visíveis são `cliente_id`, `lead_id` e `vendedor_id`.

A migration de criação descreve `empresas` como base multiempresa e semeia uma linha de perfil da JMG. Porém, a migration corretiva posterior remove a policy SELECT ampla e deixa a leitura de `empresas` para `admin`/`super_admin`. O teste RLS versionado confirma: `cliente` e `vendedor` devem ver zero linhas, enquanto `admin` pode ler. A evidência caracteriza `empresas` como metadata administrativa/singleton de perfil da empresa, não como boundary de tenant per-user comprovada.

O caminho READ existente `dashboardPropostas` autentica o usuário, consulta `propostas` com `deleted_at IS NULL`, agrega status/valor e consulta `profiles` para ranking. Não há no caminho lido um filtro por empresa/conta/tenant ligado ao usuário autenticado.

### 4.3 Foundation M21

A foundation JMG atual define `JMG_READ_TOOL = jmg_resumo_propostas`, categoria `READ`, workspace declarativo `jmg`, input `{}`, `confirmation = false`, `sideEffects = none` e o output comercial mínimo. Ela usa autenticação Supabase em uma Server Function própria no repositório JMG, mas ainda não prova que a identidade humana, o role ou o escopo comercial estejam vinculados a um tenant JMG real para o THÁNOS.

No THÁNOS, M21 permanece fora dos `defaultRegistries`, com adapter e fake business-only. Isso é uma proteção correta e deve ser preservado.

## 5. Respostas obrigatórias

### 5.1 Quem é o actor JMG?

O actor humano comprovado é o usuário JMG autenticado pelo Supabase: `auth.users.id`, exposto ao servidor como `userId`, com roles consultados em `user_roles`. Esse actor ainda não equivale automaticamente a um actor de integração THÁNOS.

Não há evidência suficiente de um mapeamento THÁNOS↔JMG server-side, de um service principal JMG real ou de uma integração server-side com identidade e escopo próprios. Portanto, a identidade do actor de integração permanece **não resolvida**.

### 5.2 Existe tenant JMG real?

**JMG atualmente não possui tenant semanticamente equivalente ao TenantId do THÁNOS.**

`empresas` existe, mas não há vínculo persistido demonstrado entre empresa, usuário e rows comerciais nem uma policy de isolamento por empresa. A simples existência da tabela e de uma linha JMG não satisfaz a boundary exigida.

### 5.3 Qual é o workspace?

`workspaceKey = jmg` é somente identidade do sistema/workspace. Ele não é `tenantId`, `domain`, `organizationId` ou identidade humana. Nenhum desses conceitos deve ser substituído por `jmg`.

### 5.4 Qual é o boundary real de autorização?

O boundary real para `jmg_resumo_propostas` **ainda não está provado**. O único componente confiável atualmente demonstrado é a autenticação do usuário JMG e a leitura server-side de seu role. Role sozinho não delimita quais propostas pertencem a qual empresa/conta.

Para futura autorização segura, o JMG precisa persistir e aplicar server-side uma relação de escopo comercial — por exemplo, usuário/membership → empresa/conta → propostas — ou um service principal real com scopes e RLS equivalentes. A autorização deve ser resolvida pelo servidor e não aceitar `tenant`, `role`, `capabilities`, allowlist ou scope vindos de prompt, modelo, client, request body, Telegram, WhatsApp ou connector externo.

## 6. Matriz de alternativas

| Alternativa | Evidência atual | Vantagem | Risco/impacto | Multi-workspace / multi-tenant | Recomendação |
|---|---|---|---|---|---|
| A. Tenant JMG já existente | Nenhum campo/membership tenant comprovado | Não exigiria mudança conceitual | Integraria sobre uma ausência; risco crítico de isolamento | Fraca nos dois eixos | Rejeitada por falta de evidência |
| B. `empresas` como tenant | Tabela existe, mas sem vínculo por usuário ou propostas | Conceito nominal já disponível | Singleton administrativo; RLS atual não é boundary comercial | Não comprovada | Rejeitada neste marco |
| C. Mapping THÁNOS↔JMG | `userId` JMG existe; mapping não | Preservaria actor humano | Sem tabela/regra de mapping e sem scope comercial | Potencial, mas não implementável com segurança agora | Decisão futura após especificação |
| D. Service principal real | Nenhum principal/scopes comprovado | Separaria integração de usuário humano | Criar identidade sem desenho de ownership/escopo seria inventar autoridade | Potencial | Requer decisão de segurança e provisionamento no JMG |
| E. Ausência legítima de tenant | É a conclusão sustentada pelo schema/RLS atual | Evita integração insegura e preserva core | Mantém `jmg_resumo_propostas` sem execução operacional | Compatível com isolamento atual | **Escolhida agora** |
| F. Core workspace sem tenant | Não existe no core atual | Poderia suportar workspaces não-tenanted | Mudança ampla; pode enfraquecer invariantes e governança | Risco de regressão | Rejeitada neste marco; ADR futuro somente se houver caso geral |
| G. Criar conceito real de tenant/account no JMG | Não existe atualmente | Produziria boundary explícita e auditável | Migração, memberships, RLS, ownership e decisões de produto | Melhor caminho para futuro multi-tenant | **Recomendação futura principal** |

## 7. Implicações

Nenhum `ThanosContext` JMG operacional deve ser criado neste M22. Não se deve preencher `tenantId` com `jmg`, `tenant:jmg`, `org:jmg`, `company:jmg`, `default`, `single-tenant`, `1`, `0` ou variação equivalente. Também não se deve tornar `tenantId` opcional nem relaxar policy, capabilities, tenant isolation, Trusted Context, registries, `GovernedActionRuntime` ou `ConnectorRegistry`.

O adapter M21 continua útil como contrato business-only e fake determinístico. Ele não autoriza, autentica, resolve tenant, produz autoridade ou executa transporte. O JMG permanece fora dos registries default.

A decisão não autoriza HTTP, Supabase real a partir do THÁNOS, fetch, webhook, RPC, polling, Telegram, Hermes, n8n, WhatsApp, Oracle, WRITE, deploy ou qualquer secret.

## 8. Próximo trabalho necessário

Primeiro, o domínio JMG deve decidir se a empresa é realmente o boundary comercial e, se for, criar uma relação persistida e testável entre usuário/membership e empresa/conta, além de acrescentar escopo comercial às tabelas relevantes ou encapsular a leitura em uma view/function/RLS que preserve esse isolamento. A coluna e o nome da entidade não devem ser inventados pelo THÁNOS.

Segundo, deve ser definida a identidade de integração: usuário JMG autenticado com mapping server-side explicitamente governado, ou service principal real com ownership, rotação, scopes e trilha de auditoria. O cliente do THÁNOS não poderá escolher o actor.

Terceiro, somente após esses fatos existirem deve ser desenhado o `JmgWorkspaceSource` que forneça ao core um `tenantId` derivado de uma identidade real, um `userId`/actor trusted, role/capabilities server-side e requestId gerado no servidor. O workspace permanecerá `jmg`, separado do tenant e do domain.

Quarto, deverão ser adicionados testes de RLS/membership negativos, testes de cross-tenant, testes de actor mismatch, testes de ausência de scope e uma composição THÁNOS específica. Até lá, qualquer adapter real é proibido.

## 9. Invariantes de segurança

A relação permanece `workspaceKey != tenantId != domain`. Identidade humana, identidade de tenant, identidade de workspace, identidade de integração, authority e request metadata são conceitos distintos. Nenhuma entrada do prompt, modelo, client, body não confiável ou connector externo pode definir diretamente tenant, role, capabilities, platformRole, platformCapabilities ou allowlist.

A autorização deve ser fail-closed quando actor, tenant, membership, role, capability, workspace/domain ou scope estiver ausente, ambíguo ou inconsistente. Os dados retornados devem continuar limitados ao contrato READ M21, sem dados brutos de propostas, PII, tokens, IDs externos ou metadata desnecessária.

## 10. Rollback

Este M22 altera somente documentação no repositório THÁNOS. O rollback é um revert normal do commit que adiciona este ADR, sem `--force`, sem alterar o SHA congelado e sem tocar em M21. Como não há runtime JMG composto nem integração real, não existe desligamento operacional adicional.

## 11. Classificação final

**M22 — BLOQUEIO ARQUITETURAL/HUMANO REAL**

O bloqueio é a ausência de uma identidade de integração e de um boundary/tenant JMG semanticamente comprovados. A recomendação é não inventar esses conceitos e preparar um marco futuro de decisão/implementação no próprio JMG antes de qualquer composição operacional no THÁNOS.
