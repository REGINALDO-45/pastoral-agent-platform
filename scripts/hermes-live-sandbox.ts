import { AgentCore } from "../server/pastoral/agentCore";
import { AgentGateway } from "../server/pastoral/agentGateway";
import {
  getAgentGatewayRuntimeConfig,
  type AgentGatewayRuntimeConfig,
} from "../server/pastoral/gatewayConfig";
import {
  HermesClient,
  HermesUnavailableError,
} from "../server/pastoral/hermesClient";
import type { TenantGatewayConfig } from "../server/pastoral/tenantGatewayConfig";
import type {
  PastoralRepository,
  TenantContext,
  ToolResult,
} from "../server/pastoral/types";

const SYNTHETIC_ORGANIZATION_ID = 900001;
const SYNTHETIC_CONTEXT: TenantContext = {
  organizationId: SYNTHETIC_ORGANIZATION_ID,
  organizationName: "Hermes Sandbox Synthetic Organization",
  userId: 900001,
  userName: "Synthetic Operator",
  role: "pastor",
};
const GENERATION_REQUEST_ID = "thanos-hermes-live-synthetic-001";
const CONTROLLED_FAILURE_REQUEST_ID =
  "thanos-hermes-live-controlled-failure-001";
const ROLLBACK_REQUEST_ID = "thanos-hermes-live-rollback-001";
const FORBIDDEN_AUDIT_PATTERN =
  /api.?key|authorization|bearer|base.?url|secret|stack|sql|cookie|token|prompt|audio|transcri|chain.?of.?thought/i;

class LiveProofError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LiveProofError";
  }
}

type AuditRecord = Parameters<PastoralRepository["audit"]>[0];

class SyntheticRepository implements PastoralRepository {
  readonly audits: AuditRecord[] = [];
  queryCalls = 0;
  messageWrites = 0;
  writeCalls = 0;

  queryCells(_context: TenantContext) {
    this.queryCalls += 1;
    return Promise.resolve(this.result("consultar_celulas"));
  }
  queryReports(_context: TenantContext) {
    this.queryCalls += 1;
    return Promise.resolve(this.result("consultar_relatorios"));
  }
  queryAttendance(_context: TenantContext) {
    this.queryCalls += 1;
    return Promise.resolve(this.result("consultar_presenca"));
  }
  queryVisitors(_context: TenantContext) {
    this.queryCalls += 1;
    return Promise.resolve(this.result("consultar_visitantes"));
  }
  queryLeaders(_context: TenantContext) {
    this.queryCalls += 1;
    return Promise.resolve(this.result("consultar_lideres"));
  }
  findVisitor() {
    return Promise.resolve(null);
  }
  appendMessage() {
    this.messageWrites += 1;
    return Promise.resolve();
  }
  writeFollowup() {
    this.writeCalls += 1;
    return Promise.resolve({ created: false, visitorName: "synthetic" });
  }
  audit(input: AuditRecord) {
    this.audits.push(input);
    return Promise.resolve();
  }

  private result(tool: ToolResult["tool"]): ToolResult {
    return {
      tool,
      summary: "Synthetic sandbox evidence",
      data: { synthetic: true },
    };
  }
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new LiveProofError(`${name.toLowerCase()}_missing`);
  return value;
}

function assertBoundary() {
  const baseUrl = requireEnv("HERMES_BASE_URL");
  requireEnv("HERMES_API_KEY");
  if (process.env.HERMES_ENABLED !== "true")
    throw new LiveProofError("hermes_disabled");
  if (process.env.AGENT_GATEWAY_PROVIDER !== "hermes")
    throw new LiveProofError("provider_not_hermes");
  if (process.env.HERMES_ORGANIZATION_IDS !== String(SYNTHETIC_ORGANIZATION_ID))
    throw new LiveProofError("organization_allowlist_invalid");
  if (process.env.THANOS_PILOT_ENABLED !== "false")
    throw new LiveProofError("thanos_pilot_not_disabled");
  if (process.env.THANOS_PILOT_KILL_SWITCH !== "true")
    throw new LiveProofError("thanos_kill_switch_not_on");
  if (process.env.N8N_ENABLED !== "false")
    throw new LiveProofError("n8n_not_disabled");
  if (
    process.env.AGENT_PROVIDER &&
    process.env.AGENT_PROVIDER !== "deterministic"
  )
    throw new LiveProofError("legacy_provider_not_deterministic");

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (_error) {
    throw new LiveProofError("base_url_invalid");
  }
  const host = parsed.hostname.toLowerCase();
  const denylist = new Set(
    (process.env.HERMES_PRODUCTION_HOST_DENYLIST ?? "")
      .split(",")
      .map(item => item.trim().toLowerCase())
      .filter(Boolean)
  );
  if (parsed.protocol !== "https:")
    throw new LiveProofError("base_url_not_https");
  if (denylist.has(host) || /(^|[.-])(prod|production|live)([.-]|$)/.test(host))
    throw new LiveProofError("production_endpoint_denied");
  if (!/(sandbox|test|staging|stage|qa|dev)/.test(host))
    throw new LiveProofError("sandbox_hostname_required");
}

function liveConfig(): TenantGatewayConfig {
  const config = getAgentGatewayRuntimeConfig();
  if (
    !config.enabled ||
    config.provider !== "hermes" ||
    !config.hermes.enabled ||
    !config.hermes.configured
  ) {
    throw new LiveProofError("runtime_boundary_invalid");
  }
  if (
    config.hermesOrganizationIds.length !== 1 ||
    config.hermesOrganizationIds[0] !== SYNTHETIC_ORGANIZATION_ID
  ) {
    throw new LiveProofError("runtime_allowlist_invalid");
  }
  return { ...config, fallbackPolicy: "deterministic", source: "environment" };
}

function auditIsSanitized(repository: SyntheticRepository) {
  return !FORBIDDEN_AUDIT_PATTERN.test(JSON.stringify(repository.audits));
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(sorted.length * fraction) - 1)
    )
  ];
}

function auditByAction(repository: SyntheticRepository, action: string) {
  return [...repository.audits]
    .reverse()
    .find(audit => audit.action === action);
}

async function run() {
  assertBoundary();
  const baseUrl = requireEnv("HERMES_BASE_URL");
  const apiKey = requireEnv("HERMES_API_KEY");
  const config = liveConfig();
  const repository = new SyntheticRepository();
  let outboundCalls = 0;
  const liveClient = new HermesClient(
    async (input, init) => {
      outboundCalls += 1;
      return fetch(input, init);
    },
    Date.now,
    baseUrl,
    apiKey
  );
  const gateway = new AgentGateway(
    repository,
    new AgentCore(repository),
    async () => config,
    liveClient
  );

  const health = await gateway.testHermesConnection(SYNTHETIC_CONTEXT);
  const healthAudit = auditByAction(repository, "agent_gateway.hermes_probe");
  if (!health.connected)
    throw new LiveProofError(`health_${health.failure ?? "failed"}`);

  const generationStartedAt = performance.now();
  const generated = await gateway.generate({
    context: SYNTHETIC_CONTEXT,
    requestId: GENERATION_REQUEST_ID,
    system: "Você está respondendo a um teste sintético de sandbox.",
    user: "Responda apenas: HERMES_SANDBOX_OK",
    fallback: "HERMES_SANDBOX_FALLBACK",
  });
  const generationLatencyMs = Math.max(
    0,
    Math.round(performance.now() - generationStartedAt)
  );
  if (generated.gateway?.fallback)
    throw new LiveProofError(
      generated.gateway.fallbackReason ?? "generation_fallback"
    );
  if (generated.content !== "HERMES_SANDBOX_OK")
    throw new LiveProofError("invalid_response");

  const realLatencies = [health.latencyMs ?? 0, generationLatencyMs];
  const realMetrics = {
    calls: outboundCalls,
    success: 2,
    error: 0,
    fallback: 0,
    invalidResponse: 0,
    circuitOpen: 0,
    minMs: Math.min(...realLatencies),
    medianMs: percentile(realLatencies, 0.5),
    p95Ms: percentile(realLatencies, 0.95),
    maxMs: Math.max(...realLatencies),
    samples: realLatencies.length,
  };

  const failureRepository = new SyntheticRepository();
  let controlledFailureCalls = 0;
  const failingClient = new HermesClient(
    async () => {
      controlledFailureCalls += 1;
      throw new Error("synthetic controlled sandbox outage");
    },
    Date.now,
    baseUrl,
    apiKey
  );
  const failureGateway = new AgentGateway(
    failureRepository,
    new AgentCore(failureRepository),
    async () => config,
    failingClient
  );
  const controlledFailure = await failureGateway.generate({
    context: SYNTHETIC_CONTEXT,
    requestId: CONTROLLED_FAILURE_REQUEST_ID,
    system: "Você está respondendo a um teste sintético de falha controlada.",
    user: "Use o fallback seguro.",
    fallback: "HERMES_SANDBOX_FALLBACK",
  });
  const controlledFailureAudit = auditByAction(
    failureRepository,
    "agent_gateway.generate"
  );
  const controlledFailurePassed =
    controlledFailure.gateway?.fallback === true &&
    controlledFailure.gateway.fallbackReason === "hermes_unavailable" &&
    controlledFailureCalls === 1 &&
    controlledFailureAudit?.requestId === CONTROLLED_FAILURE_REQUEST_ID &&
    failureRepository.queryCalls === 0 &&
    failureRepository.messageWrites === 0 &&
    failureRepository.writeCalls === 0;
  if (!controlledFailurePassed)
    throw new LiveProofError("controlled_failure_not_governed");

  const callsBeforeRollback = outboundCalls;
  const rollbackRepository = new SyntheticRepository();
  const rollbackConfig: TenantGatewayConfig = {
    ...config,
    provider: "legacy",
    hermes: { ...config.hermes, enabled: false },
  };
  const rollbackGateway = new AgentGateway(
    rollbackRepository,
    new AgentCore(rollbackRepository),
    async () => rollbackConfig,
    liveClient
  );
  const rollback = await rollbackGateway.generate({
    context: SYNTHETIC_CONTEXT,
    requestId: ROLLBACK_REQUEST_ID,
    system: "Teste sintético de rollback.",
    user: "Responda pelo caminho local.",
    fallback: "LEGACY_ROLLBACK_OK",
  });
  const rollbackPassed =
    rollback.gateway?.provider === "legacy" &&
    rollbackRepository.queryCalls === 0 &&
    rollbackRepository.messageWrites === 0 &&
    rollbackRepository.writeCalls === 0 &&
    outboundCalls === callsBeforeRollback;
  if (!rollbackPassed) throw new LiveProofError("rollback_not_proven");

  const sanitized =
    auditIsSanitized(repository) &&
    auditIsSanitized(failureRepository) &&
    auditIsSanitized(rollbackRepository);
  if (!sanitized) throw new LiveProofError("audit_not_sanitized");

  console.log(
    JSON.stringify({
      ok: true,
      boundary: {
        hermesCredentialsPresent: true,
        hermesEnabled: true,
        provider: "hermes",
        allowlistedOrganizations: 1,
        thanosPilotEnabled: false,
        thanosPilotKillSwitch: true,
        n8nEnabled: false,
        productionEndpoint: false,
        syntheticContext: true,
      },
      health: {
        success: true,
        attempts: health.attempts,
        latencyMs: health.latencyMs,
        failure: health.failure,
        requestId: healthAudit?.requestId ?? null,
      },
      generation: {
        success: true,
        responseTokenMatched: true,
        requestId: GENERATION_REQUEST_ID,
        audit: true,
      },
      metrics: realMetrics,
      controlledFailure: {
        success: true,
        fallback: true,
        requestIdPreserved: true,
        externalAttempts: controlledFailureCalls,
        duplicateFunctionalExecution: false,
      },
      rollback: {
        hermesEnabled: false,
        provider: "legacy",
        thanosPilotKillSwitch: true,
        newHermesCalls: 0,
        success: true,
      },
      audit: { sanitized: true },
    })
  );
}

try {
  await run();
} catch (error) {
  const code =
    error instanceof HermesUnavailableError
      ? error.failure
      : error instanceof LiveProofError
        ? error.code
        : "controlled_live_proof_failure";
  console.log(JSON.stringify({ ok: false, failure: code }));
  process.exitCode = 1;
}
