import { randomUUID } from "node:crypto";
import { AgentCore } from "./agentCore";
import { getTenantGatewayConfig, type TenantGatewayConfig } from "./tenantGatewayConfig";
import { HermesClient, HermesUnavailableError, type HermesAttempt } from "./hermesClient";
import { ModelRouter, type ModelGenerationInput, type ModelGenerationResult } from "./modelRouter";
import { toSanitizedTenantGatewayStatus } from "./tenantGatewayConfig";
import { enforceHermesEligibility } from "./gatewayConfig";
import type { AgentResponse, PastoralRepository, TenantContext } from "./types";

const GATEWAY_NAME = "agent-gateway-v1";

type RespondInput = {
  context: TenantContext;
  conversationId: number;
  message: string;
  persistUserMessage?: boolean;
  requestId?: string;
};

export type GovernedModelGenerationInput = ModelGenerationInput & {
  context: TenantContext;
  requestId: string;
};

export class AgentGateway {
  constructor(
    private readonly repository: PastoralRepository,
    private readonly legacyAgent: AgentCore,
    private readonly config: (context: TenantContext) => Promise<TenantGatewayConfig> = getTenantGatewayConfig,
    private readonly hermes = new HermesClient(),
    private readonly modelRouter = new ModelRouter(),
  ) {}

  /** Porta de geração compartilhada pelo THÁNOS sem expor tools, repositório ou tenant ao provider. */
  async generate(input: GovernedModelGenerationInput): Promise<ModelGenerationResult> {
    const config = enforceHermesEligibility(await this.config(input.context), input.context.organizationId);
    let result: ModelGenerationResult;

    if (config.enabled && config.provider === "hermes") {
      try {
        const generated = await this.hermes.generate(
          config,
          { requestId: input.requestId, system: input.system, user: input.user, fallback: input.fallback, isolationKey: this.hermesIsolationKey(input.context) },
          attempt => this.auditHermesAttempt(input.context, config, input.requestId, attempt),
        );
        result = {
          ...generated,
          gateway: { version: "v1", provider: "hermes", fallback: false },
        };
      } catch (error) {
        if (!(error instanceof HermesUnavailableError)) throw error;
        result = {
          content: input.fallback,
          provider: "deterministic",
          model: "pastoral-rules-v1",
          gateway: {
            version: "v1",
            provider: "hermes",
            fallback: true,
            fallbackReason: error.failure === "circuit_open" ? "hermes_circuit_open" : "hermes_unavailable",
          },
        };
      }
    } else {
      const generated = await this.modelRouter.generate(input);
      result = {
        ...generated,
        gateway: {
          version: "v1",
          provider: config.provider,
          fallback: !config.enabled,
          ...(!config.enabled ? { fallbackReason: "gateway_disabled" as const } : {}),
        },
      };
    }

    await this.auditGenerationSafely(input, config, result);
    return result;
  }

  async getStatus(context: TenantContext) {
    const config = enforceHermesEligibility(await this.config(context), context.organizationId);
    return toSanitizedTenantGatewayStatus(config, this.hermes.getStatus(config, this.hermesIsolationKey(context)));
  }

  async testHermesConnection(context: TenantContext) {
    const config = enforceHermesEligibility(await this.config(context), context.organizationId);
    const requestId = randomUUID();
    const isolationKey = this.hermesIsolationKey(context);
    const probe = await this.hermes.probe(config, attempt => this.auditHermesAttempt(context, config, requestId, attempt), isolationKey);
    const status = this.hermes.getStatus(config, isolationKey);
    await this.repository.audit({
      context,
      action: "agent_gateway.hermes_probe",
      agent: GATEWAY_NAME,
      model: config.hermes.model,
      provider: "hermes",
      requestId,
      result: probe.connected ? "hermes_connected" : `hermes_${probe.failure ?? "unavailable"}`,
      confirmationStatus: "not_required",
      status: probe.connected ? "success" : "failure",
      metadata: { requestId, attempts: probe.attempts, latencyMs: probe.latencyMs, failure: probe.failure },
    });
    return { ...status, attempts: probe.attempts };
  }

  async respond(input: RespondInput): Promise<AgentResponse> {
    const requestId = input.requestId ?? randomUUID();
    const config = enforceHermesEligibility(await this.config(input.context), input.context.organizationId);
    let fallback = !config.enabled;
    let fallbackReason: "gateway_disabled" | "hermes_unavailable" | "hermes_circuit_open" | undefined = !config.enabled ? "gateway_disabled" : undefined;
    let response: AgentResponse;

    if (config.enabled && config.provider === "hermes") {
      try {
        response = await this.legacyAgent.respond({
          ...input,
          requestId,
          modelGenerator: {
            generate: generation => this.hermes.generate(
              config,
              { ...generation, requestId, isolationKey: this.hermesIsolationKey(input.context) },
              attempt => this.auditHermesAttempt(input.context, config, requestId, attempt),
            ),
          },
        });
      } catch (error) {
        if (!(error instanceof HermesUnavailableError)) throw error;
        fallback = true;
        fallbackReason = error.failure === "circuit_open" ? "hermes_circuit_open" : "hermes_unavailable";
        response = await this.legacyAgent.respond({ ...input, requestId, persistUserMessage: false });
      }
    } else {
      response = await this.legacyAgent.respond({ ...input, requestId });
    }

    await this.auditResponseSafely(input, requestId, config, response, fallback, fallbackReason);

    return {
      ...response,
      requestId,
      gateway: { version: "v1", provider: config.provider, fallback, fallbackReason: fallback ? fallbackReason : undefined },
    };
  }

  private async auditHermesAttempt(context: TenantContext, config: TenantGatewayConfig, requestId: string, attempt: HermesAttempt) {
    try {
      await this.repository.audit({
        context,
        action: "agent_gateway.hermes_attempt",
        agent: GATEWAY_NAME,
        model: config.model,
        provider: "hermes",
        requestId,
        result: attempt.success ? "hermes_attempt_success" : `hermes_attempt_${attempt.failure ?? "failure"}`,
        confirmationStatus: "not_required",
        status: attempt.success ? "success" : "failure",
        metadata: { requestId, attempt: attempt.attempt, latencyMs: attempt.latencyMs, failure: attempt.failure },
      });
    } catch (_error) {
      console.error(`[AgentGateway] Hermes telemetry failure requestId=${requestId}`);
    }
  }

  private async auditGenerationSafely(input: GovernedModelGenerationInput, config: TenantGatewayConfig, result: ModelGenerationResult) {
    try {
      await this.repository.audit({
        context: input.context,
        action: "agent_gateway.generate",
        agent: GATEWAY_NAME,
        model: result.model,
        provider: config.provider,
        requestId: input.requestId,
        result: config.provider === "hermes"
          ? (result.gateway?.fallback ? "hermes_fallback" : "hermes_response")
          : "gateway_response",
        confirmationStatus: "not_required",
        status: "success",
        metadata: {
          requestId: input.requestId,
          provider: config.provider,
          configuredModel: config.model,
          fallback: result.gateway?.fallback ?? false,
          fallbackReason: result.gateway?.fallbackReason,
          version: "v1",
        },
      });
    } catch (_error) {
      console.error(`[AgentGateway] generation telemetry failure requestId=${input.requestId}`);
    }
  }

  private async auditResponseSafely(
    input: RespondInput,
    requestId: string,
    config: TenantGatewayConfig,
    response: AgentResponse,
    fallback: boolean,
    fallbackReason: "gateway_disabled" | "hermes_unavailable" | "hermes_circuit_open" | undefined,
  ) {
    try {
      await this.repository.audit({
        context: input.context,
        action: "agent_gateway.respond",
        agent: GATEWAY_NAME,
        model: response.model,
        provider: config.provider,
        tool: response.tool,
        requestId,
        result: config.provider === "hermes" ? (fallback ? "hermes_fallback" : "hermes_response") : "gateway_response",
        confirmationStatus: response.confirmationStatus ?? "not_required",
        status: "success",
        metadata: {
          requestId,
          provider: config.provider,
          configuredModel: config.model,
          fallback,
          fallbackReason: fallback ? fallbackReason : undefined,
          version: "v1",
        },
      });
    } catch (_error) {
      console.error(`[AgentGateway] response telemetry failure requestId=${requestId}`);
    }
  }

  private hermesIsolationKey(context: TenantContext) {
    return `organization:${context.organizationId}`;
  }

  async confirmFollowup(input: { context: TenantContext; conversationId: number; visitorId: number; note: string; idempotencyKey: string; requestId?: string }) {
    const requestId = input.requestId ?? randomUUID();
    const response = await this.legacyAgent.confirmFollowup({ ...input, requestId });
    await this.repository.audit({
      context: input.context,
      action: "agent_gateway.confirm",
      agent: GATEWAY_NAME,
      model: response.model,
      provider: "legacy",
      tool: response.tool,
      requestId,
      result: "gateway_confirmation",
      confirmationStatus: response.confirmationStatus ?? "confirmed",
      status: "success",
      metadata: { requestId, fallback: true, version: "v1" },
    });
    return { ...response, requestId, gateway: { version: "v1", provider: "legacy" as const, fallback: true, fallbackReason: "local_confirmation" as const } };
  }
}
