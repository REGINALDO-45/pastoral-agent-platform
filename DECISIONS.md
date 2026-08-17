# Registro de Decisões de Arquitetura

| ID | Decisão | Estado | Consequência |
|---|---|---|---|
| ADR-001 | Introduzir `AgentGateway` como porta única depois da autenticação e resolução do tenant. | Aprovada | Texto e voz recebem a mesma política, auditoria e fallback. |
| ADR-002 | Preservar o `AgentCore` atual como fallback local obrigatório. | Aprovada | Hermes não se torna dependência operacional do MVP. |
| ADR-003 | Aceitar planos de provider apenas quando passarem por schema, allowlist, policy e executor confiável. | Aprovada | Texto livre do provider nunca executa efeito. |
| ADR-004 | Manter Dashboard tradicional separado da Camada inteligente. | Aprovada | Métricas factuais continuam disponíveis mesmo sem IA. |
| ADR-005 | Persistir confirmações como entidade genérica e idempotente. | Aprovada | Escritas piloto compartilham TTL, estado e vínculo a usuário/conversa/tenant. |
| ADR-006 | Preparar Hermes e n8n com opt-in, diagnóstico sanitizado e desativação por padrão. | Aprovada | Não há saída externa arbitrária ou segredo exposto. |
| ADR-007 | Configurações administrativas serão declarativas e allowlisted. | Aprovada | Admin não cria tools, modelos, URLs ou workflows arbitrários. |
| ADR-008 | Auditoria registra decisão e resultado, não conteúdos privados ou raciocínio interno. | Aprovada | Operabilidade sem ampliar superfície de dados sensíveis. |
| ADR-009 | Tratar habilitações de ferramentas como overrides por organização somente para catálogo conhecido. | Aprovada | Administração ajusta escopo permitido sem criar código executável ou ferramentas novas. |
| ADR-010 | Propagar `requestId` e estado de confirmação na resposta e na auditoria. | Aprovada | Uma operação pode ser correlacionada sem confundir rastreio com chave de idempotência. |
| ADR-011 | Calcular Dashboard no servidor com escopo temporal ou operacional declarado por indicador. | Aprovada | Métricas e pendências não dependem de interpretações ocultas do cliente. |
| ADR-012 | Restringir Configurações à leitura sanitizada e a mutações allowlisted para administradores. | Aprovada | A interface não se torna um console de segredos, URLs ou automação arbitrária. |
| ADR-013 | Modelar `workspaceKey`, `tenantId` e `domain` como identificadores contextuais separados no núcleo THÁNOS. | Aprovada | Um workspace não pode ser confundido com a organização autenticada nem com o domínio de negócio. |
| ADR-014 | Resolver workspaces e skills por registros fechados e adaptar as ferramentas no limite do workspace. | Aprovada | O núcleo não importa o domínio Pastoral e o catálogo/política existentes continuam a ser a fonte de autorização. |
| ADR-015 | Restringir o piloto multi-step a duas ou três leituras declaradas, com auditoria por etapa e fallback determinístico. | Aprovada | O piloto não habilita escrita, ferramenta arbitrária, falha bruta ou troca de tenant entre etapas. |
| ADR-016 | Manter o piloto THÁNOS fora da rota pública até a aprovação formal de adoção do Gateway. | Substituída por ADR-017 | A caracterização, testes e rollback controlado foram concluídos antes da ativação seletiva. |
| ADR-017 | Adotar THÁNOS no chat público somente por elegibilidade server-side READ, audiência explícita e kill switch. | Aprovada | A rota ativa permanece legada por padrão; só consultas fechadas de células, presença e relatórios podem seguir ao núcleo, com fallback legado sem duplicar a mensagem. |
| ADR-018 | Encaminhar a resposta de voz transcrita pelo `AgentGateway`, mantendo a skill do piloto THÁNOS limitada ao canal `chat`. | Aprovada | Voz compartilha política, fallback, auditoria e `requestId` com o caminho governado sem ampliar audiência, intenções ou capacidades do piloto. |
| ADR-019 | Registrar uma definição sintética READ-only no catálogo fechado para provar generalidade multi-workspace sem expor uma rota pública. | Aprovada | O núcleo demonstra isolamento de identidades, skill e capability em um segundo domínio; a entrada não acessa dados pastorais nem altera a adoção do piloto. |
| ADR-020 | Separar `platformRole`/`platformCapabilities` de `role`/capabilities do tenant no `ThanosContext`, com validação explícita e deny-by-default. | Aprovada | Admin de tenant e usuário comum não recebem authority global; mesmo `superadmin` precisa de capability específica. Não há rota pública de assunção ou listagem nesta etapa. |
| ADR-021 | Modelar contexto assumido como contrato interno com capability `platform:tenant:assume`, tenant alvo existente, ator original, `requestId`, auditoria e saída explícita. | Aprovada | A implementação não altera membership, não cria acesso invisível, não cria `ThanosContext` cross-tenant executável e permanece desconectada das rotas públicas até existir resolvedor seguro de papel/capabilities no tenant alvo. |
| ADR-022 | Adicionar planner READ genérico com plano declarado de 2–5 passos, preflight de capabilities, recusa de `WRITE`, contexto fresco por passo e fallback parcial determinístico. | Aprovada | O planner é uma porta interna independente do piloto de chat; ferramentas, capabilities, intenção e `requestId` são correlacionados por etapa, sem permitir tool arbitrária ou execução de escrita. |
| ADR-023 | Generalizar evidência THÁNOS com proveniência de fonte, workspace, tenant, requestId, ferramenta e etapa, compondo somente dados sanitizados. | Aprovada | Planner e ferramentas READ podem produzir evidência auditável e agregada; o modelo não registra prompt privado, áudio, transcrição ou segredo de connector. |
| ADR-024 | Modelar Confirmation Engine como máquina de estados interna: `pending`, `confirmed`, `duplicate`, `denied` e `failed`, com capability WRITE, confirmação explícita, escopo de tenant/workspace e idempotência. | Aprovada | A operação de escrita nunca é inferida pelo planner READ; a engine exige chave de idempotência e store injetável, deduplica concorrência e não cria nova rota pública nesta etapa. |
| ADR-025 | Generalizar canais por envelopes, respostas e `channelPolicy` allowlisted, com correlação de requestId e identidades. | Aprovada | O contrato aceita canais futuros sem habilitá-los; payloads incompatíveis com a policy são recusados, e não há conexão com WhatsApp, Slack, email, webhook ou credenciais externas. |
| ADR-026 | Implementar Connector Registry fechado com manifest, key allowlisted, capability, channel policy, estado habilitado explícito, execução injetável e auditoria sanitizada. | Aprovada | Mocks determinísticos provam a porta READ; WRITE exige confirmação e toda execução externa permanece desabilitada até existir configuração, segredo e aprovação operacional próprios. |

## Decisões pendentes

| Tema | Decisão necessária antes de ativar em produção |
|---|---|
| Contrato HTTP Hermes | Confirmar endpoint, método, headers permitidos, formato de resposta estruturada e política de dados antes de ativar em produção. |
| Papéis administrativos | Formalizar a semântica de `superadmin` e a matriz completa de permissões. |
| Tendências do Dashboard | Definir período padrão, timezone de negócio e base mínima para comparação. |
| n8n | Aprovar eventos, destino, assinatura e política de retentativa antes de habilitar qualquer workflow. |
| Ampliação do piloto THÁNOS | Avaliar novos planos READ somente após evidência de compatibilidade, telemetria e rollback; escrita, voz e ferramentas sensíveis ficam fora da rota. |
