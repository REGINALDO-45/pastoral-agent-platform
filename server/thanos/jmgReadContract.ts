import { z } from "zod";
export const JMG_WORKSPACE_KEY = "jmg" as const;
export const JMG_DOMAIN = "jmg" as const;
export const JMG_READ_TOOL = "jmg_resumo_propostas" as const;
export const JMG_READ_CATEGORY = "READ" as const;
export const JMG_READ_FEATURE_FLAG_ENV = "THANOS_JMG_READ_ENABLED" as const;
export const JMG_READ_ALLOWLIST = Object.freeze([JMG_READ_TOOL] as const);

const nonNegativeInteger = z.number().int().nonnegative();
const nonNegativeNumber = z.number().finite().nonnegative();

export const jmgReadInputSchema = z.object({}).strict();

export const jmgReadSummarySchema = z
  .object({
    totalAbertas: nonNegativeInteger,
    emNegociacao: nonNegativeInteger,
    aguardandoResposta: nonNegativeInteger,
    valorPipeline: nonNegativeNumber,
  })
  .strict();

export type JmgReadInput = z.infer<typeof jmgReadInputSchema>;
export type JmgReadSummary = z.infer<typeof jmgReadSummarySchema>;

export const JMG_READ_TOOL_CONTRACT = Object.freeze({
  tool: JMG_READ_TOOL,
  category: JMG_READ_CATEGORY,
  workspace: JMG_WORKSPACE_KEY,
  confirmation: false,
  sideEffects: "none",
  input: "empty-object-strict",
  output: Object.freeze([
    "totalAbertas",
    "emNegociacao",
    "aguardandoResposta",
    "valorPipeline",
  ] as const),
  authorization: "server-side",
});

export type JmgReadTrustedContext = Readonly<{
  source: "server";
  requestId: string;
}>;

export type JmgReadServerContext = Readonly<{
  workspaceKey: typeof JMG_WORKSPACE_KEY;
  domain: typeof JMG_DOMAIN;
  requestId: string;
  capabilities: readonly ["agent:read"];
}>;

export type JmgReadAdapterInput = Readonly<{
  context: JmgReadServerContext;
  requestId: string;
  input: JmgReadInput;
}>;

export type JmgReadAdapter = Readonly<{
  key: typeof JMG_READ_TOOL;
  execute(input: JmgReadAdapterInput): Promise<unknown>;
}>;

export class JmgReadAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JmgReadAdapterError";
  }
}

export class JmgReadAdapterRegistry {
  private readonly adapters = new Map<string, JmgReadAdapter>();

  register(adapter: JmgReadAdapter): void {
    if (!JMG_READ_ALLOWLIST.includes(adapter.key)) {
      throw new JmgReadAdapterError("Adapter JMG não está na allowlist.");
    }
    if (this.adapters.has(adapter.key)) {
      throw new JmgReadAdapterError("Adapter JMG já registrado.");
    }
    this.adapters.set(adapter.key, adapter);
  }

  get(tool: string): JmgReadAdapter | undefined {
    return this.adapters.get(tool);
  }
}

export class InMemoryJmgReadAdapter implements JmgReadAdapter {
  readonly key = JMG_READ_TOOL;

  constructor(private readonly response: unknown) {}

  async execute(_input: JmgReadAdapterInput): Promise<unknown> {
    return this.response;
  }
}

export type JmgReadAuditStatus = "success" | "denied" | "failure";
export type JmgReadAuditActor = "thanos-server-context" | "thanos-policy";
export type JmgReadAuditReason =
  | "feature-disabled"
  | "workspace-denied"
  | "tool-denied"
  | "trusted-context-denied"
  | "capability-denied"
  | "adapter-not-registered"
  | "invalid-input"
  | "invalid-response"
  | "adapter-failed";

export type JmgReadAuditEvent = Readonly<{
  requestId: string;
  workspace: typeof JMG_WORKSPACE_KEY;
  tool: typeof JMG_READ_TOOL;
  status: JmgReadAuditStatus;
  durationMs: number;
  timestamp: string;
  actor: JmgReadAuditActor;
  reason?: JmgReadAuditReason;
  errorCategory?: "policy" | "contract" | "adapter";
}>;

export type JmgReadAuditPort = Readonly<{
  record(event: JmgReadAuditEvent): void | Promise<void>;
}>;

export type JmgReadEvidence = Readonly<{
  workspace: typeof JMG_WORKSPACE_KEY;
  tool: typeof JMG_READ_TOOL;
  status: "success";
  requestId: string;
  timestamp: string;
  summary: string;
  metrics: JmgReadSummary;
}>;

export type JmgReadExecutionResult = Readonly<{
  workspace: typeof JMG_WORKSPACE_KEY;
  tool: typeof JMG_READ_TOOL;
  status: "success";
  sideEffects: "none";
  summary: JmgReadSummary;
  evidence: JmgReadEvidence;
  audit: JmgReadAuditEvent;
}>;

export type JmgReadExecutionInput = Readonly<{
  context: JmgReadServerContext;
  trustedContext?: JmgReadTrustedContext;
  requestId: string;
  requestedWorkspace: string;
  requestedTool: string;
  input?: unknown;
  featureEnabled: boolean;
  adapters: JmgReadAdapterRegistry;
  audit: JmgReadAuditPort;
  now?: () => number;
}>;

export type JmgReadErrorCode =
  | "feature-disabled"
  | "workspace-denied"
  | "tool-denied"
  | "trusted-context-denied"
  | "capability-denied"
  | "adapter-not-registered"
  | "invalid-input"
  | "invalid-response"
  | "adapter-failed";

export class JmgReadContractError extends Error {
  constructor(
    readonly code: JmgReadErrorCode,
    message: string
  ) {
    super(message);
    this.name = "JmgReadContractError";
  }
}

export function resolveJmgReadFeatureFlag(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return env[JMG_READ_FEATURE_FLAG_ENV] === "true";
}

export function parseJmgReadInput(input: unknown): JmgReadInput {
  return jmgReadInputSchema.parse(input ?? {});
}

export function parseJmgReadSummary(input: unknown): JmgReadSummary {
  return jmgReadSummarySchema.parse(input);
}

function createAuditEvent(
  input: Readonly<{
    requestId: string;
    status: JmgReadAuditStatus;
    durationMs: number;
    timestamp: string;
    actor: JmgReadAuditActor;
    reason?: JmgReadAuditReason;
    errorCategory?: "policy" | "contract" | "adapter";
  }>
): JmgReadAuditEvent {
  return Object.freeze({
    requestId: input.requestId,
    workspace: JMG_WORKSPACE_KEY,
    tool: JMG_READ_TOOL,
    status: input.status,
    durationMs: input.durationMs,
    timestamp: input.timestamp,
    actor: input.actor,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.errorCategory === undefined
      ? {}
      : { errorCategory: input.errorCategory }),
  });
}

async function recordAudit(
  audit: JmgReadAuditPort,
  event: JmgReadAuditEvent
): Promise<void> {
  await audit.record(event);
}

function policyError(code: JmgReadErrorCode): JmgReadContractError {
  const messages: Record<JmgReadErrorCode, string> = {
    "feature-disabled": "Integração JMG READ desabilitada.",
    "workspace-denied": "Workspace JMG não autorizado.",
    "tool-denied": "Tool JMG não autorizada.",
    "trusted-context-denied": "Contexto trusted JMG ausente ou inválido.",
    "capability-denied": "Capability READ não autorizada para JMG.",
    "adapter-not-registered": "Adapter JMG não registrado.",
    "invalid-input": "Input JMG inválido.",
    "invalid-response": "Resposta JMG inválida.",
    "adapter-failed": "Adapter JMG indisponível.",
  };
  return new JmgReadContractError(code, messages[code]);
}

function assertJmgReadPolicy(input: JmgReadExecutionInput): void {
  if (!input.featureEnabled) throw policyError("feature-disabled");
  if (
    input.requestedTool !== JMG_READ_TOOL ||
    !JMG_READ_ALLOWLIST.includes(input.requestedTool as typeof JMG_READ_TOOL)
  ) {
    throw policyError("tool-denied");
  }
  if (
    input.requestedWorkspace !== JMG_WORKSPACE_KEY ||
    input.context.workspaceKey !== JMG_WORKSPACE_KEY ||
    input.context.domain !== JMG_DOMAIN
  ) {
    throw policyError("workspace-denied");
  }
  if (
    input.trustedContext?.source !== "server" ||
    input.trustedContext.requestId !== input.requestId ||
    input.context.requestId !== input.requestId
  ) {
    throw policyError("trusted-context-denied");
  }
  if (
    input.context.capabilities.length !== 1 ||
    input.context.capabilities[0] !== "agent:read"
  ) {
    throw policyError("capability-denied");
  }
}

export async function executeJmgRead(
  input: JmgReadExecutionInput
): Promise<JmgReadExecutionResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const timestamp = new Date(startedAt).toISOString();
  let auditStatus: JmgReadAuditStatus = "denied";
  let auditActor: JmgReadAuditActor = "thanos-policy";
  let auditReason: JmgReadAuditReason | undefined;
  let auditCategory: "policy" | "contract" | "adapter" | undefined;

  try {
    try {
      assertJmgReadPolicy(input);
      parseJmgReadInput(input.input);
    } catch (error) {
      if (error instanceof JmgReadContractError) {
        auditReason = error.code;
        auditCategory = "policy";
        throw error;
      }
      auditReason = "invalid-input";
      auditCategory = "contract";
      throw policyError("invalid-input");
    }

    const adapter = input.adapters.get(JMG_READ_TOOL);
    if (!adapter) {
      auditReason = "adapter-not-registered";
      auditCategory = "policy";
      throw policyError("adapter-not-registered");
    }

    let rawResponse: unknown;
    try {
      rawResponse = await adapter.execute({
        context: input.context,
        requestId: input.requestId,
        input: parseJmgReadInput(input.input),
      });
    } catch {
      auditStatus = "failure";
      auditReason = "adapter-failed";
      auditCategory = "adapter";
      throw policyError("adapter-failed");
    }

    let summary: JmgReadSummary;
    try {
      summary = parseJmgReadSummary(rawResponse);
    } catch {
      auditStatus = "failure";
      auditReason = "invalid-response";
      auditCategory = "contract";
      throw policyError("invalid-response");
    }

    auditStatus = "success";
    auditActor = "thanos-server-context";
    const audit = createAuditEvent({
      requestId: input.requestId,
      status: auditStatus,
      durationMs: Math.max(0, now() - startedAt),
      timestamp,
      actor: auditActor,
    });
    const sanitizedEvidence = Object.freeze({
      workspace: JMG_WORKSPACE_KEY,
      tool: JMG_READ_TOOL,
      status: "success" as const,
      requestId: input.requestId,
      timestamp,
      summary: "sanitized-jmg-proposal-summary",
      metrics: summary,
    });
    await recordAudit(input.audit, audit);
    return Object.freeze({
      workspace: JMG_WORKSPACE_KEY,
      tool: JMG_READ_TOOL,
      status: "success" as const,
      sideEffects: "none" as const,
      summary,
      evidence: sanitizedEvidence,
      audit,
    });
  } catch (error) {
    if (error instanceof JmgReadContractError) {
      const event = createAuditEvent({
        requestId: input.requestId,
        status: auditStatus,
        durationMs: Math.max(0, now() - startedAt),
        timestamp,
        actor: auditActor,
        ...(auditReason === undefined ? {} : { reason: auditReason }),
        ...(auditCategory === undefined
          ? {}
          : { errorCategory: auditCategory }),
      });
      await recordAudit(input.audit, event);
      throw error;
    }

    const event = createAuditEvent({
      requestId: input.requestId,
      status: "failure",
      durationMs: Math.max(0, now() - startedAt),
      timestamp,
      actor: "thanos-server-context",
      reason: "adapter-failed",
      errorCategory: "adapter",
    });
    await recordAudit(input.audit, event);
    throw policyError("adapter-failed");
  }
}
