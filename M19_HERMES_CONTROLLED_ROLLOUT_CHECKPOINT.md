# THÁNOS — M19 Hermes Controlled Sandbox Rollout

> Nota de reconciliação (2026-09-02): o contrato histórico `/v1/agent/respond` descrito abaixo foi substituído pelo endpoint oficial `/v1/chat/completions`. O estado atual está em `M19_HERMES_REAL_API_RECONCILIATION.md`.

## Classificação final

> **M19 BLOQUEADO — DECISÃO HUMANA NECESSÁRIA**

A implementação do contrato Hermes controlado foi concluída no branch empilhado e passou pelas validações locais disponíveis. O M19, porém, não pode ser classificado como pronto para auditoria externa porque esta execução não realizou uma chamada real ao Hermes sandbox, não produziu amostras reais de latência e não exercitou rollback após uma chamada real. O ambiente atual não expõe `HERMES_BASE_URL` nem `HERMES_API_KEY`; os testes locais e o workflow manual utilizam transporte mockado e endpoint sandbox inválido por desenho.

Essa classificação é deliberadamente conservadora e segue o critério do briefing M19: mocks comprovam regressão e fronteiras de segurança, mas não substituem a prova operacional `THÁNOS → AgentGateway → Hermes sandbox → resposta válida → auditoria`.

## Git e base histórica

| Campo | Estado |
| --- | --- |
| Repositório | `REGINALDO-45/pastoral-agent-platform` |
| Branch-base | `agent/thanos-experience-interface` |
| SHA-base exato | `f57da3199ea6e1e88bfa323d5a295d22cd96c44b` |
| Branch M19 | `agent/thanos-hermes-controlled-rollout` |
| Estado antes do commit | Base M18 preservada; alterações M19 pendentes no working tree |
| Merge em `main` | Não realizado |
| Force push | Não realizado |
| Produção | Não acessada nem alterada |
| Integrações adjacentes | n8n, Telegram, WhatsApp e Oracle permaneceram fora do ciclo |
| WRITE real | Não habilitado |

O M19 parte diretamente do SHA M18 auditado. Nenhuma alteração reescreve o marco histórico M1–M18. O SHA final do branch será registrado na entrega após o commit e o push normal.

## Escopo implementado

A mudança introduz uma fronteira server-side explícita entre elegibilidade do provedor Hermes e elegibilidade do piloto THÁNOS. A allowlist `HERMES_ORGANIZATION_IDS` é fail-closed e não é derivada automaticamente da audiência do piloto. Sem a configuração correspondente, o gateway permanece no provider legado e o Agent Core local continua sendo o fallback.

Os arquivos funcionais do M19 são `server/_core/env.ts`, `server/pastoral/gatewayConfig.ts`, `server/pastoral/agentGateway.ts`, `server/pastoral/hermesClient.ts` e `server/pastoral/hermesContract.ts`. Os arquivos de teste cobrem contrato, transporte, fallback, circuito, audiência e integração THÁNOS–Hermes. O workflow histórico Hermes-OFF foi preservado; o workflow adicional `.github/workflows/thanos-hermes-sandbox-on.yml` é manual, possui permissões somente de leitura, usa endpoint sandbox inválido e mantém o piloto THÁNOS desligado.

## Contrato Hermes

| Fronteira | Regra efetiva |
| --- | --- |
| Endpoint de geração | Histórico/supersedido: `v1/agent/respond`; atual: `v1/chat/completions` |
| Endpoint de saúde | URL-base server-side configurada + caminho relativo fixo `health` |
| Método de geração | `POST` |
| Método de saúde | `GET` |
| Headers permitidos | `Content-Type` e `Authorization` construídos no cliente server-side |
| Headers/cookies do usuário | Nunca encaminhados |
| Request | Schema estrito com `version`, `requestId`, `model`, `system`, `user` e `fallback` |
| Limites | `requestId` até 128 caracteres; `model` até 160; textos até 20.000 caracteres |
| Response | Schema estrito com `content` obrigatório e `model` opcional |
| Limites de response | `content` não vazio até 4.000 caracteres; `model` até 160 |
| Campos extras | Rejeitados pelo schema estrito |
| Timeout | Configurável server-side, limitado a 15.000 ms; default 4.500 ms |
| Retries | Limitados a no máximo dois retries efetivos, com default conservador de uma tentativa total |
| Circuit breaker | Estado isolado por organização; threshold e cooldown limitados server-side |
| Fallback | Agent Core/roteador local; resposta classificada como fallback sanitizado |
| Default | `HERMES_ENABLED=false` e provider `legacy` |

O Hermes recebe somente o payload fechado pelo contrato. O provider não escolhe tenant, workspace, papel, capability, tool, connector, grant, confirmação ou política. O provider não recebe acesso ao banco nem objetos arbitrários do servidor.

## Política de dados

O request permite somente identificador de correlação, modelo configurado, instruções aprovadas, conteúdo necessário à geração e fallback sanitizado. A implementação não cria passthrough genérico de objetos.

A superfície de produção do contrato não contém campos de secret, API key, SQL, stack trace, prompt privado completo, áudio, transcrição privada ou dados cross-tenant. Os testes usam strings como `apiKey`, `promptPrivate` e `stackTrace` apenas para provar que esses campos extras são rejeitados; esses valores não fazem parte de requests válidos.

## Testes e validações

| Fronteira | Resultado |
| --- | --- |
| Testes focados Hermes, contrato, gateway, configuração, tenant e integração | Aprovados após correções pontuais dos fixtures de audiência multi-tenant |
| Schema de request | Campos extras rejeitados; request fechado validado |
| Schema de response | JSON inválido, campos extras, conteúdo ausente/vazio e tipos incompatíveis caem em falha governada |
| Timeout | Coberto por transporte mockado com fallback |
| HTTP 5xx | Coberto com retry limitado e fallback |
| Network error | Coberto com fallback |
| Invalid JSON | Coberto com fallback |
| Invalid schema | Coberto com fallback |
| Circuit open | Coberto com bloqueio de chamada externa e fallback |
| Hermes disabled/unconfigured | Coberto com fail-closed e caminho local |
| Audiência autorizada/não autorizada | Coberta por allowlist independente do piloto |
| Check TypeScript | Aprovado |
| Build | Aprovado |
| Formatação dos arquivos M19 | Aprovada após reverter reflow legado e manter diff mínimo |
| `git diff --check` | Aprovado |
| Regressão sem dependência de banco | 49 arquivos verdes; as falhas restantes pertencem ao teste que exige MySQL de teste indisponível no ambiente local |
| Workflow histórico Hermes-OFF | Preservado intacto |
| Workflow manual Hermes-ON | Criado com `workflow_dispatch`, permissões read-only e transport boundary controlado |

O teste completo que depende de MySQL não foi reinterpretado como regressão Hermes. As falhas foram isoladas como indisponibilidade da dependência de banco de teste; não foram observadas falhas funcionais M19 nos testes focados, check ou build.

## Sandbox controlado

O workflow adicional executa somente por `workflow_dispatch`. Ele configura `HERMES_ENABLED=true`, provider `hermes`, uma única organização allowlisted, endpoint `https://hermes.sandbox.invalid`, piloto THÁNOS desligado e kill switch ativado. O endpoint `.invalid` é intencional: garante que a fronteira CI não possa alcançar produção por engano. A etapa de boundary check confirma o conjunto de variáveis e a etapa final confirma ausência de WRITE e ausência de endpoint produtivo.

Esta configuração comprova a segurança estrutural do workflow, mas não é a prova real Hermes exigida pelo M19. Nenhuma credencial real foi commitada, impressa ou colocada em artefato.

## Prova real e métricas

A prova real permanece pendente. No ambiente desta execução, `HERMES_BASE_URL` e `HERMES_API_KEY` não estavam disponíveis; portanto, não foi executada chamada externa ao sandbox Hermes. Consequentemente, não há amostra honesta para total de chamadas reais, sucesso real, erro real, fallback real, resposta inválida real, circuito aberto real ou distribuição de latência.

| Métrica real Hermes | Resultado |
| --- | --- |
| Total de chamadas reais | Não medido |
| Sucesso real | Não medido |
| Erro real | Não medido |
| Fallback após falha real | Não medido |
| Response inválida real | Não medido |
| Circuit open real | Não medido |
| Latência mínima/mediana/p95/máxima | Não medido |
| Amostras | 0 |

Não foram inventados números. As suítes mockadas comprovam classificação e isolamento, mas não podem ser apresentadas como latência ou conectividade Hermes real.

## Rollback

A implementação mantém rollback por configuração: `HERMES_ENABLED=false`, `AGENT_GATEWAY_PROVIDER=legacy` e, quando o piloto estiver envolvido, `THANOS_PILOT_KILL_SWITCH=true`. O teste operacional comprova default OFF, allowlist controlada e restauração de módulos/ambiente de teste. O rollback após uma chamada Hermes real não foi exercitado porque a chamada real não ocorreu; essa é uma pendência operacional explícita, não uma lacuna ocultada por mock.

## Segurança e exclusões

Não houve acesso ou alteração de produção, variáveis produtivas, dados pastorais reais, n8n, Telegram, WhatsApp, Oracle, WRITE real ou branches experimentais adjacentes. O workflow Hermes-OFF anterior continua sendo a fronteira segura de regressão. O workflow Hermes-ON é manual, não global e não habilita o piloto THÁNOS.

A auditoria estática dos arquivos de produção novos não encontrou ocorrências de `secret`, `apiKey`, `stackTrace`, `promptPrivate`, `crossTenant`, áudio/transcrição bruta ou SQL no contrato de transporte. As ocorrências equivalentes nos testes são fixtures negativos usados para comprovar rejeição estrutural.

## THÁNOS agora consegue

O branch M19 prova que o AgentGateway pode decidir Hermes exclusivamente server-side para uma audiência de organizações explicitamente allowlisted, construir requests com schema estrito, validar responses estritamente, manter timeout/retry/circuit breaker limitados, preservar isolamento de estado por organização e cair para o caminho local diante das classes de falha mockadas. Também prova que o default permanece seguro e que o workflow Hermes-ON é manual e não produtivo.

## THÁNOS ainda não consegue

Este checkpoint não prova Hermes global em produção, chamada real a um Hermes sandbox externo, métricas reais, rollback operacional depois de uma chamada externa, n8n real, WhatsApp, Telegram, Oracle, WRITE real, Developer Agent ou qualquer integração não coberta pelos testes e pelo workflow deste branch.

## Próxima condição de desbloqueio

Para mudar a classificação para `M19 PRONTO PARA AUDITORIA EXTERNA`, é necessária uma execução humana/controlada do workflow com credencial exclusivamente de sandbox, endpoint Hermes real de sandbox e conteúdo sintético. Essa execução deve demonstrar uma resposta válida pelo caminho THÁNOS → AgentGateway → HermesClient, registrar métricas sanitizadas, exercitar timeout ou falha governada com fallback e executar rollback para `HERMES_ENABLED=false`/`legacy` sem nova chamada Hermes. Até que essa evidência exista, a decisão correta permanece **M19 BLOQUEADO — DECISÃO HUMANA NECESSÁRIA**.

## Referências

[1]: https://github.com/REGINALDO-45/pastoral-agent-platform/tree/agent/thanos-hermes-controlled-rollout "Branch M19 Hermes Controlled Rollout"
[2]: https://github.com/REGINALDO-45/pastoral-agent-platform/blob/agent/thanos-hermes-controlled-rollout/.github/workflows/thanos-hermes-sandbox.yml "Workflow histórico Hermes-OFF"
[3]: https://github.com/REGINALDO-45/pastoral-agent-platform/blob/agent/thanos-hermes-controlled-rollout/.github/workflows/thanos-hermes-sandbox-on.yml "Workflow manual Hermes-ON controlado"
