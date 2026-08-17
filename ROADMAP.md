# Roadmap de Evolução Segura

| Marco | Entrega | Ativação | Critério de saída |
|---|---|---|---|
| M1 | Contratos, configuração segura e Gateway em fallback. | **Concluído**; Hermes desligado por padrão. | Texto e voz preservados com regressão aprovada. |
| M2 | Tool Registry declarativo e ferramentas piloto. | **Concluído**; leitura e escrita confirmada. | Schemas, roles, tenant e auditoria testados. |
| M3 | Confirmação genérica e auditoria enriquecida. | **Concluído**. | Idempotência, expiração, vínculo e rastreabilidade testados. |
| M4 | Hermes resiliente e n8n preparado. | **Concluído**; ambos desativados por padrão. | Timeout, circuito, status sanitizado, allowlist e fallback cobertos. |
| M5 | Serviço e UI do Dashboard tradicional. | **Concluído** por tenant. | Métricas, vazios, tendências, pendências e mobile validados. |
| M6 | Camada inteligente e Configurações. | **Concluído**; insights somente leitura. | Fallback visual, permissões, controles allowlisted e auditoria aprovados. |
| M7 | Ciclo THÁNOS: núcleo genérico, workspace/skill declarativos e piloto READ multi-step. | **Concluído**; compatível. | Identidades segregadas, registros fechados, 2–3 passos READ, evidências compostas, auditoria e fallback testados. |
| M8 | Adoção controlada do THÁNOS pela rota pública de chat. | **Concluído**; desativada por padrão e limitada a texto READ elegível. | Flag, kill switch, audiência de tenant/usuário, telemetria sanitizada, fallback sem duplicação e rollback exercitado. |
| M9 | Prova de generalidade multi-workspace do núcleo THÁNOS. | **Concluído como prova sintética**; sem nova rota pública ou dado pastoral. | Segundo workspace registrado, skill READ-only, tenant/domain distintos, executor determinístico e negativa de capability testados. |
| M10 | Fundação de platform access com role/capabilities explícitos e deny-by-default. | **Concluído como contrato interno**; sem rota pública de superadmin ou assunção. | Separação tenant/platform, capabilities globais fechadas, negativos de role/capability e isolamento dos workspaces testados. |
| M11 | Contrato de contexto assumido governado. | **Concluído como contrato interno**; sem execução cross-tenant ou alteração de membership. | Capability `platform:tenant:assume`, diretório de existência, auditoria do ator/requestId, saída explícita e negativos testados. |
| M12 | Planner READ genérico com plano declarado e isolamento por passo. | **Concluído como contrato interno**; sem novas rotas ou ferramentas públicas. | Dois a cinco passos, preflight de capabilities, recusa de `WRITE`, contexto fresco por passo e fallback parcial testados. |
| M13 | Evidência generalizada com proveniência sanitizada. | **Concluído no planner interno**; conectores reais continuam bloqueados. | Fonte, workspace, tenant, requestId, ferramenta e etapa compostos sem prompt privado, áudio, transcrição ou segredo. |
| M14 | Confirmation Engine genérico e negativo. | **Concluído como contrato interno**; nenhuma nova operação pública ativada. | Máquina de estados, capability `agent:write`, confirmação explícita, escopo, store injetável, idempotência e concorrência testados. |
| M15 | Contratos channel-agnostic e `channelPolicy`. | **Concluído como contrato interno**; sem adaptadores externos ativos. | Envelopes e respostas com requestId/identidades, allowlist de canais/payloads e negativos READ-only testados. |
| M16 | Connector Registry governado com mocks. | **Concluído como contrato interno**, sem credenciais reais nesta branch. | Registry allowlisted, manifest, capability, channel policy, estado habilitado, auditoria sanitizada e negativa de WRITE sem confirmação testados. |
| M17 | Rollout controlado de provedor externo. | **Futuro**, requer aprovação operacional. | Contrato Hermes validado, métricas de erro/latência aceitáveis e rollback exercitado. |

## Rollback

O rollback operacional prioriza `THANOS_PILOT_KILL_SWITCH=true` para novas mensagens do piloto e, quando aplicável, `AGENT_GATEWAY_PROVIDER=legacy`, `HERMES_ENABLED=false` e `N8N_ENABLED=false`. Essa combinação retorna o comportamento ao Agent Core local e desativa saídas externas. Migrações são exclusivamente aditivas; dados de histórico, voz e auditoria não são removidos durante a evolução.
