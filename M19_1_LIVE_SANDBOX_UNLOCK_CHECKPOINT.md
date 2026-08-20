# THÁNOS — M19.1 LIVE SANDBOX UNLOCK HARDENING

## Classificação final

> **M19.1 BLOQUEADO — DECISÃO HUMANA NECESSÁRIA**

A correção de fronteira e a preparação do workflow live foram concluídas. A prova real contra um Hermes sandbox externo não foi executada nesta sessão porque `HERMES_BASE_URL` e `HERMES_API_KEY` estavam ausentes localmente e o Environment GitHub `hermes-sandbox` não existe no repositório auditado. Nenhuma credencial foi inventada, reutilizada ou exposta. Por consequência, health real, generation real, métricas reais, falha externa controlada e rollback depois de uma chamada real permanecem não comprovados.

A classificação segue obrigatoriamente o critério do briefing M19.1: sem todas as provas live, o resultado não pode ser elevado a `M19 PRONTO PARA AUDITORIA EXTERNA`.

## Git e base exata

| Campo | Estado |
| --- | --- |
| Repositório | `REGINALDO-45/pastoral-agent-platform` |
| Base M19 | `agent/thanos-hermes-controlled-rollout` |
| SHA-base exato | `2949fabd9db8c64fd6ce8b7aa6bd3005930cb88e` |
| Branch M19.1 | `agent/thanos-hermes-live-sandbox-unlock` |
| Merge em `main` | Não realizado |
| Force push | Não realizado |
| Produção | Não acessada |
| M18/M19 | Não reabertos nem reescritos |
| Integrações adjacentes | n8n, Telegram, WhatsApp e Oracle desligados e fora do escopo |
| WRITE | Não habilitado |
| Credenciais | Nenhuma credencial commitada, impressa ou armazenada em artifact |

A branch M19.1 foi criada localmente apontando exatamente para o SHA M19 publicado. O push normal foi concluído e a branch remota aponta para `f27fd161487846d8f4d993c8c8b84798c1156086`; o working tree permanece limpo, exceto pelos artefatos de auditoria ainda preparados para o commit documental final.

## Correção da fronteira `invalid_request`

No estado M19, `hermesRequestSchema.parse(...)` estava dentro do mesmo `try/catch` que envolve transporte, timeout, resposta HTTP e parsing da response. Uma falha local de schema podia cair no catch genérico e ser classificada como `network_error`.

O M19.1 separa a validação local com `safeParse` antes de criar `AbortController`, timer, endpoint, headers ou chamada HTTP. Quando a validação falha, o cliente lança somente `HermesUnavailableError("invalid_request")`. Portanto, o comportamento é:

```text
request local inválido
→ invalid_request
→ fail closed
→ zero fetch
→ zero retry
→ sem mutação do circuito de transporte
→ fallback local seguro quando chamado pelo AgentGateway
→ classificação pública sanitizada
```

A taxonomia pública do gateway preserva `hermes_invalid_request` como fallbackReason sanitizado. O AgentGateway não devolve o erro Zod, valores de campos, headers, endpoint, API key ou stack trace.

Os testes cobrem explicitamente requestId vazio, requestId com 129 caracteres, model com 161 caracteres, system com 20.001 caracteres, user com 20.001 caracteres e fallback com 20.001 caracteres. Cada caso comprova erro `invalid_request`, zero fetch, zero tentativas observadas, ausência de detalhes brutos e ausência de segredo.

Foi acrescentado também um teste end-to-end do AgentGateway com model inválido. Ele comprova fallback determinístico, `hermes_invalid_request`, zero chamadas Hermes, requestId preservado na auditoria e auditoria sanitizada.

## Workflow live separado

O workflow estrutural/mock existente `.github/workflows/thanos-hermes-sandbox-on.yml` foi preservado byte a byte; os hashes do arquivo no working tree e no SHA M19 são iguais. Ele continua sendo a prova segura de transporte mockado e não foi convertido em workflow live.

Foi criado `.github/workflows/thanos-hermes-live-sandbox.yml` com as seguintes propriedades:

| Fronteira | Regra |
| --- | --- |
| Trigger | Somente `workflow_dispatch` |
| Permissões | `contents: read` |
| Ambiente | GitHub Environment dedicado `hermes-sandbox` |
| Base URL | Exclusivamente `secrets.HERMES_BASE_URL` |
| API key | Exclusivamente `secrets.HERMES_API_KEY` |
| Input textual de endpoint | Não existe |
| Allowlist | Exatamente a organização sintética `900001` |
| Hermes | `HERMES_ENABLED=true`, provider `hermes` |
| THÁNOS | `THANOS_PILOT_ENABLED=false` |
| Kill switch | `THANOS_PILOT_KILL_SWITCH=true` |
| Integrações | n8n, Telegram, WhatsApp e Oracle explicitamente `false` |
| WRITE | `WRITE_ENABLED=false` |
| Provider legado | `AGENT_PROVIDER=deterministic` |
| Host | HTTPS e hostname exigindo `sandbox`, `test`, `staging`, `stage`, `qa` ou `dev` |
| Produção | Hosts contendo `prod`, `production` ou `live`, além de denylist configurável, são rejeitados |
| Segredos em logs | Nunca impressos; apenas presença booleana é reportada |
| Artifact | Somente `live-proof.json`, saída sanitizada do runner, com retenção de 7 dias |

Antes de qualquer acesso Hermes, o workflow verifica presença não vazia das credenciais, flags de segurança, allowlist única, host não produtivo e ausência de paths de WRITE/integrações. A URL completa, host sensível e Authorization não são impressos pelo boundary check.

## Runner da prova real

O arquivo `scripts/hermes-live-sandbox.ts` executa a cadeia governada:

```text
context sintético
→ AgentGateway.testHermesConnection
→ HermesClient.probe
→ GET health
→ AgentGateway.generate
→ HermesClient.generate
→ POST respond
→ schema estrito
→ resultado sanitizado
→ auditoria
```

O runner utiliza apenas a organização sintética `900001`, usuário sintético, mensagens sintéticas e os tokens de teste `HERMES_SANDBOX_OK`/`HERMES_SANDBOX_FALLBACK`. Ele não abre banco real, não consulta tenant real, não envia áudio, transcrição, histórico, nomes reais, cookies, SQL, headers brutos, stack trace ou prompts privados.

Após a geração bem-sucedida, o runner executa uma falha sandbox controlada com transporte sintético indisponível e verifica fallback local, requestId preservado, exatamente `config.hermes.retries + 1` tentativas externas (atualmente duas com `HERMES_RETRIES=1`), zero execução funcional duplicada e zero WRITE. Em seguida, aplica rollback em uma nova instância governada com `HERMES_ENABLED=false` e provider `legacy`, executa nova request sintética e verifica zero novas chamadas Hermes.

O runner também faz uma verificação de sanitização dos registros de auditoria e emite somente JSON sem secrets, Authorization, URL base, cookies, tokens, SQL, stack trace, áudio ou transcrição.

## Prova executada nesta sessão

O runner foi executado localmente sem credenciais e falhou fechado, sem rede externa:

```json
{"ok":false,"failure":"hermes_base_url_missing"}
```

A ausência de `HERMES_BASE_URL` foi detectada antes de construir o cliente live. Nenhuma tentativa Hermes ocorreu. O workflow live não foi disparado porque as credenciais sandbox não estavam configuradas e o briefing proíbe avançar quando há dúvida sobre endpoint ou credencial.

## Métricas reais

Como a amostra live é zero, nenhuma métrica foi inventada.

| Métrica | Resultado |
| --- | --- |
| Chamadas Hermes reais | Não medido; amostras zero |
| Sucesso real | Não medido |
| Erro real | Não medido |
| Fallback real após falha externa | Não medido |
| Response inválida real | Não medido |
| Circuit open real | Não medido |
| Latência mínima | Não medido |
| Latência mediana | Não medido |
| Latência p95 | Não medido |
| Latência máxima | Não medido |
| Número de amostras | 0 |

O runner está preparado para emitir as métricas de health e generation quando executado com credencial exclusivamente sandbox. Uma amostra pequena deverá continuar sendo reportada como pequena; nenhum SLO novo foi fixado.

## Validações locais

| Fronteira | Resultado |
| --- | --- |
| Hermes client + AgentGateway focados | 21 testes aprovados |
| Contrato, operação, tenant e integração THÁNOS | 17 testes adicionais aprovados |
| Total focado M19.1 | 38 testes aprovados em 6 arquivos |
| Suíte local sem banco | 49 arquivos aprovados; o arquivo de integração não pode ser executado localmente porque Docker/MySQL não estão disponíveis |
| CI Hermes-OFF com MySQL 8.4 | **50 arquivos e 211 testes aprovados; run 32395892553 verde** |
| `pnpm check` | Aprovado localmente e no CI |
| `pnpm build` | Aprovado localmente e no CI; somente avisos preexistentes de analytics/chunks |
| `git diff --check` | Aprovado |
| Runner sem credenciais | Falha fechada esperada, sem chamada externa |
| Workflow mock Hermes-ON | Preservado sem alteração; dispatch não disponível no catálogo da branch default sem merge |
| Workflow live | Sintaxe e boundary revisados; não executado sem credenciais |

O workflow Hermes-OFF histórico foi disparado manualmente três vezes durante a correção. O run [`32332395116`](https://github.com/REGINALDO-45/pastoral-agent-platform/actions/runs/32332395116) revelou que o MySQL 8.4 estava saudável e que havia divergências reais de expectativa/estado nos testes do router; o run [`32395607815`](https://github.com/REGINALDO-45/pastoral-agent-platform/actions/runs/32395607815) reduziu o problema a uma única assertion de role; e o run final [`32395892553`](https://github.com/REGINALDO-45/pastoral-agent-platform/actions/runs/32395892553), no SHA `f27fd161`, terminou verde com MySQL 8.4, 50 arquivos e 211 testes aprovados.

O dispatch do workflow Hermes-ON mock foi tentado pelo nome do arquivo, mas a API do GitHub respondeu `404: workflow ... not found on the default branch`. A listagem do conteúdo confirma que o workflow existe na branch M19.1, porém não está registrado no catálogo da branch default. Como a regra do projeto proíbe merge apenas para habilitar execução, nenhum merge foi feito e o mock permanece não executado nesta sessão.

A suíte completa local permanece limitada pela ausência de Docker/MySQL no sandbox, mas essa limitação foi coberta pelo CI Hermes-OFF com MySQL 8.4 efêmero. Os testes de router foram corrigidos sem alterar `enforceHermesEligibility`: o provider persistido `hermes` continua sendo reconhecido, enquanto o provider efetivo de tenant não allowlisted permanece `legacy`, e cada mutação de membership é restaurada em `finally`. O CI final confirma a regressão verde.

## Segurança

Nenhum secret foi impresso. Nenhuma credencial foi commitada. Nenhuma produção foi tocada. Nenhum tenant real foi incluído. Nenhum WRITE foi habilitado. n8n, Telegram, WhatsApp e Oracle não foram executados. O Environment live não foi criado ou alterado automaticamente. A ausência de credenciais bloqueou a prova externa em vez de ser contornada com placeholder.

## Condição humana de desbloqueio

Para reclassificar M19.1 como `M19 PRONTO PARA AUDITORIA EXTERNA`, uma pessoa autorizada deve configurar o Environment GitHub `hermes-sandbox` com `HERMES_BASE_URL` e `HERMES_API_KEY` exclusivamente de sandbox, definir uma denylist de hosts produtivos quando aplicável e confirmar que o hostname satisfaz a política de sandbox. Depois deve revisar e disparar manualmente apenas `.github/workflows/thanos-hermes-live-sandbox.yml`.

A execução deve produzir health válido e generation válida pelo caminho `THÁNOS → AgentGateway → HermesClient → Hermes sandbox real → response válida → audit`, registrar métricas sanitizadas, demonstrar uma falha controlada com fallback e comprovar rollback por nova request com zero chamada Hermes. Se qualquer prova falhar ou o endpoint não for claramente sandbox, a classificação permanece bloqueada.

## Referências

[1]: https://github.com/REGINALDO-45/pastoral-agent-platform/tree/agent/thanos-hermes-live-sandbox-unlock "Branch M19.1 LIVE SANDBOX UNLOCK HARDENING"
[2]: https://github.com/REGINALDO-45/pastoral-agent-platform/blob/agent/thanos-hermes-live-sandbox-unlock/.github/workflows/thanos-hermes-sandbox-on.yml "Workflow Hermes-ON estrutural/mock preservado"
[3]: https://github.com/REGINALDO-45/pastoral-agent-platform/blob/agent/thanos-hermes-live-sandbox-unlock/.github/workflows/thanos-hermes-live-sandbox.yml "Workflow Hermes live sandbox governado"
[4]: https://github.com/REGINALDO-45/pastoral-agent-platform/tree/agent/thanos-hermes-controlled-rollout "Base M19 publicada"
[5]: https://github.com/REGINALDO-45/pastoral-agent-platform/actions/runs/32395892553 "CI Hermes-OFF verde no SHA f27fd161"
[6]: https://github.com/REGINALDO-45/pastoral-agent-platform/actions/runs/32395607815 "CI intermediário com uma assertion restante"
[7]: https://github.com/REGINALDO-45/pastoral-agent-platform/actions/runs/32332395116 "CI inicial auditado"
