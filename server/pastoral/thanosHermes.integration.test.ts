import { describe, expect, it, vi } from "vitest";
import { AgentCore } from "./agentCore";
import { AgentGateway } from "./agentGateway";
import { HermesClient } from "./hermesClient";
import { resolveThanosPilotRuntimeConfig } from "./thanosPilotConfig";
import { ThanosPilotRouter } from "./thanosPilotRouter";
import { pastoralToolCatalog } from "./toolCatalog";
import type { PastoralRepository, TenantContext, ToolResult } from "./types";
import { PastoralThanosFacade } from "../workspaces/pastoral/thanosFacade";

const tenantA: TenantContext = {
  organizationId: 1,
  organizationName: "Igreja A",
  userId: 10,
  userName: "Ana",
  role: "pastor",
};

const tenantB: TenantContext = {
  organizationId: 2,
  organizationName: "Igreja B",
  userId: 20,
  userName: "Bruno",
  role: "pastor",
};

class GovernedIntegrationRepository implements PastoralRepository {
  readonly messages: Array<{ context: TenantContext; role: "user" | "assistant"; content: string }> = [];
  readonly audits: Array<{
    context: TenantContext;
    action: string;
    model?: string;
    provider?: string;
    requestId?: string;
    result?: string;
    metadata?: Record<string, unknown>;
  }> = [];
  readonly queryCells = vi.fn(async (context: TenantContext) => this.result("consultar_celulas", "Há 2 células ativas.", context));
  readonly queryAttendance = vi.fn(async (context: TenantContext) => this.result("consultar_presenca", "2 células realizaram reunião.", context));
  readonly queryReports = vi.fn(async (context: TenantContext) => this.result("consultar_relatorios", "Há 1 relatório pendente.", context));
  readonly failAuditActions = new Set<string>();

  queryVisitors(context: TenantContext) { return Promise.resolve(this.result("consultar_visitantes", "Sem visitantes.", context)); }
  queryLeaders(context: TenantContext) { return Promise.resolve(this.result("consultar_lideres", "Sem alertas.", context)); }
  findVisitor() { return Promise.resolve(null); }
  appendMessage(input: { context: TenantContext; role: "user" | "assistant"; content: string }) {
    this.messages.push(input);
    return Promise.resolve();
  }
  writeFollowup() { return Promise.resolve({ created: true, visitorName: "Pessoa" }); }
  audit(input: GovernedIntegrationRepository["audits"][number]) {
    if (this.failAuditActions.has(input.action)) return Promise.reject(new Error("private audit detail"));
    this.audits.push(input);
    return Promise.resolve();
  }

  private result(tool: ToolResult["tool"], summary: string, context: TenantContext): ToolResult {
    return { tool, summary, data: { aggregate: true, tenant: context.organizationId } };
  }
}

function pilotConfig() {
  return resolveThanosPilotRuntimeConfig({
    enabled: "true",
    killSwitch: "false",
    organizationIds: "1",
    userIds: "10",
    version: "thanos-hermes-test-v1",
  });
}

function tenantGatewayConfig(overrides: Readonly<{ model?: string; timeoutMs?: number; circuitFailureThreshold?: number }> = {}) {
  return {
    enabled: true,
    provider: "hermes" as const,
    model: overrides.model ?? "hermes-tenant-a",
    hermesOrganizationIds: [1, 2],
    hermes: {
      enabled: true,
      configured: true,
      model: "hermes-tenant-a",
      timeoutMs: overrides.timeoutMs ?? 25,
      retries: 0,
      circuitFailureThreshold: overrides.circuitFailureThreshold ?? 2,
      circuitCooldownMs: 100,
    },
    fallbackPolicy: "deterministic" as const,
    source: "organization" as const,
  };
}

function chatCompletion(content: string, model = "hermes-tenant-a") {
  return { model, choices: [{ message: { role: "assistant", content } }] };
}

function createGovernedRouter(
  repository: GovernedIntegrationRepository,
  hermes: HermesClient,
  config = tenantGatewayConfig(),
) {
  const gateway = new AgentGateway(repository, new AgentCore(repository), async () => config, hermes);
  const thanos = new PastoralThanosFacade(repository, gateway, async () => pastoralToolCatalog);
  return new ThanosPilotRouter(repository, gateway, thanos, pilotConfig, () => 100);
}

describe("integração governada THÁNOS → Hermes", () => {
  it("gera pelo Hermes depois de três tools READ no mesmo request THÁNOS", async () => {
    const repository = new GovernedIntegrationRepository();
    const requests: Array<{ body: unknown; idempotencyKey: string | null }> = [];
    const hermes = new HermesClient(async (_url, init) => {
      requests.push({ body: JSON.parse(String(init?.body)), idempotencyKey: new Headers(init?.headers).get("Idempotency-Key") });
      return new Response(JSON.stringify(chatCompletion("Resposta Hermes composta.")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }, () => 100, "https://hermes.internal/", "secret-never-returned");
    const router = createGovernedRouter(repository, hermes);

    const response = await router.respond({
      context: tenantA,
      conversationId: 41,
      message: "Mostre um resumo de células, presença e relatórios",
      requestId: "thanos-hermes-success",
    });

    expect(response).toMatchObject({
      content: "Resposta Hermes composta.",
      provider: "hermes",
      model: "hermes-tenant-a",
      requestId: "thanos-hermes-success",
      gateway: { provider: "hermes", fallback: false },
      thanos: {
        mode: "multi_read",
        tools: ["consultar_celulas", "consultar_presenca", "consultar_relatorios"],
        fallback: false,
      },
    });
    expect(repository.queryCells).toHaveBeenCalledTimes(1);
    expect(repository.queryAttendance).toHaveBeenCalledTimes(1);
    expect(repository.queryReports).toHaveBeenCalledTimes(1);
    expect(repository.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(requests).toEqual([{ body: {
      model: "hermes-tenant-a",
      messages: [expect.objectContaining({ role: "system" }), expect.objectContaining({ role: "user" })],
      stream: false,
    }, idempotencyKey: "thanos-hermes-success" }]);
    expect(JSON.stringify(requests)).not.toMatch(/Igreja A|Ana|"tenant"|"aggregate"/i);
    expect(JSON.stringify(requests)).not.toMatch(/isolationKey|organization:|fallback/i);

    const correlated = repository.audits.filter(event => [
      "agent.tool.execute",
      "agent.respond",
      "agent_gateway.hermes_attempt",
      "thanos.route",
    ].includes(event.action));
    expect(correlated.length).toBeGreaterThanOrEqual(5);
    expect(correlated.every(event => event.requestId === "thanos-hermes-success")).toBe(true);
    expect(repository.audits).toContainEqual(expect.objectContaining({
      action: "thanos.route",
      provider: "hermes",
      requestId: "thanos-hermes-success",
      metadata: expect.objectContaining({
        route: "thanos",
        mode: "multi_read",
        toolCount: 3,
        tools: "consultar_celulas,consultar_presenca,consultar_relatorios",
        fallback: false,
      }),
    }));
    expect(JSON.stringify({ response, audits: repository.audits })).not.toMatch(/secret-never-returned|hermes\.internal|api.?key|token/i);
  });

  it("mantém route=thanos e usa fallback determinístico sem repetir tools ou mensagens quando Hermes falha", async () => {
    const repository = new GovernedIntegrationRepository();
    const hermes = new HermesClient(async () => {
      throw new Error("network detail must stay private");
    }, () => 100, "https://hermes.internal/", "secret-never-returned");
    const router = createGovernedRouter(repository, hermes);

    const response = await router.respond({
      context: tenantA,
      conversationId: 42,
      message: "Mostre um resumo de células, presença e relatórios",
      requestId: "thanos-hermes-fallback",
    });

    expect(response).toMatchObject({
      provider: "deterministic",
      requestId: "thanos-hermes-fallback",
      gateway: { provider: "hermes", fallback: true, fallbackReason: "hermes_unavailable" },
      thanos: { mode: "multi_read", fallback: true },
    });
    expect(repository.queryCells).toHaveBeenCalledTimes(1);
    expect(repository.queryAttendance).toHaveBeenCalledTimes(1);
    expect(repository.queryReports).toHaveBeenCalledTimes(1);
    expect(repository.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(repository.audits).toContainEqual(expect.objectContaining({
      action: "thanos.route",
      provider: "deterministic",
      requestId: "thanos-hermes-fallback",
      result: "thanos_deterministic_fallback",
      metadata: expect.objectContaining({ route: "thanos", fallback: true }),
    }));
    expect(JSON.stringify({ response, audits: repository.audits })).not.toMatch(/network detail|secret-never-returned|hermes\.internal/i);
  });

  it("mantém fallback único no route=thanos para response_error", async () => {
    const repository = new GovernedIntegrationRepository();
    const hermes = new HermesClient(async () => new Response("upstream private body", { status: 503 }), () => 100, "https://hermes.internal/", "secret-never-returned");
    const router = createGovernedRouter(repository, hermes);

    const response = await router.respond({
      context: tenantA,
      conversationId: 43,
      message: "Mostre um resumo de células, presença e relatórios",
      requestId: "thanos-hermes-response-error",
    });

    expect(response).toMatchObject({ provider: "deterministic", gateway: { provider: "hermes", fallback: true, fallbackReason: "hermes_unavailable" }, thanos: { fallback: true } });
    expect(repository.queryCells).toHaveBeenCalledTimes(1);
    expect(repository.queryAttendance).toHaveBeenCalledTimes(1);
    expect(repository.queryReports).toHaveBeenCalledTimes(1);
    expect(repository.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "agent_gateway.hermes_attempt", requestId: "thanos-hermes-response-error", result: "hermes_attempt_response_error" }));
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "thanos.route", requestId: "thanos-hermes-response-error", metadata: expect.objectContaining({ route: "thanos", fallback: true }) }));
  });

  it("mantém fallback único no route=thanos para timeout", async () => {
    const repository = new GovernedIntegrationRepository();
    const hermes = new HermesClient((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("private timeout detail", "AbortError")), { once: true });
    }), Date.now, "https://hermes.internal/", "secret-never-returned");
    const router = createGovernedRouter(repository, hermes, tenantGatewayConfig({ timeoutMs: 5 }));

    const response = await router.respond({
      context: tenantA,
      conversationId: 44,
      message: "Mostre um resumo de células, presença e relatórios",
      requestId: "thanos-hermes-timeout",
    });

    expect(response).toMatchObject({ provider: "deterministic", gateway: { provider: "hermes", fallback: true, fallbackReason: "hermes_unavailable" }, thanos: { fallback: true } });
    expect(repository.queryCells).toHaveBeenCalledTimes(1);
    expect(repository.queryAttendance).toHaveBeenCalledTimes(1);
    expect(repository.queryReports).toHaveBeenCalledTimes(1);
    expect(repository.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "agent_gateway.hermes_attempt", requestId: "thanos-hermes-timeout", result: "hermes_attempt_timeout" }));
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "thanos.route", requestId: "thanos-hermes-timeout", metadata: expect.objectContaining({ route: "thanos", fallback: true }) }));
  });

  it("mantém fallback único no route=thanos quando o circuito já está aberto", async () => {
    const repository = new GovernedIntegrationRepository();
    let hermesCalls = 0;
    const hermes = new HermesClient(async () => {
      hermesCalls += 1;
      throw new Error("private network detail");
    }, () => 100, "https://hermes.internal/", "secret-never-returned");
    const router = createGovernedRouter(repository, hermes, tenantGatewayConfig({ circuitFailureThreshold: 1 }));

    await router.respond({ context: tenantA, conversationId: 45, message: "Quais células temos?", requestId: "thanos-opens-circuit" });
    const response = await router.respond({ context: tenantA, conversationId: 46, message: "Quais células temos?", requestId: "thanos-circuit-open" });

    expect(response).toMatchObject({ provider: "deterministic", gateway: { provider: "hermes", fallback: true, fallbackReason: "hermes_circuit_open" }, thanos: { fallback: true } });
    expect(hermesCalls).toBe(1);
    expect(repository.queryCells).toHaveBeenCalledTimes(2);
    expect(repository.messages.map(message => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "thanos.route", requestId: "thanos-circuit-open", metadata: expect.objectContaining({ route: "thanos", fallback: true }) }));
    expect(repository.audits.filter(event => event.requestId === "thanos-circuit-open").every(event => event.context.organizationId === tenantA.organizationId)).toBe(true);
  });

  it("resolve provider por tenant sem enviar o tenant legacy ao Hermes", async () => {
    const repository = new GovernedIntegrationRepository();
    let hermesCalls = 0;
    const hermes = new HermesClient(async () => {
      hermesCalls += 1;
      return new Response(JSON.stringify(chatCompletion("Resposta Hermes tenant A.")), { status: 200 });
    }, () => 100, "https://hermes.internal/", "secret-never-returned");
    const gateway = new AgentGateway(
      repository,
      new AgentCore(repository),
      async context => context.organizationId === 1
        ? tenantGatewayConfig()
        : { ...tenantGatewayConfig(), provider: "legacy" as const, model: "legacy-tenant-b" },
      hermes,
    );
    const facade = new PastoralThanosFacade(repository, gateway, async () => pastoralToolCatalog);
    const router = new ThanosPilotRouter(repository, gateway, facade, () => resolveThanosPilotRuntimeConfig({
      enabled: "true",
      killSwitch: "false",
      organizationIds: "1,2",
      userIds: "",
      version: "thanos-hermes-tenants-v1",
    }));

    const responseA = await router.respond({ context: tenantA, conversationId: 51, message: "Quais células temos?", requestId: "tenant-a-hermes" });
    const responseB = await router.respond({ context: tenantB, conversationId: 52, message: "Quais células temos?", requestId: "tenant-b-legacy" });

    expect(responseA).toMatchObject({ provider: "hermes", gateway: { provider: "hermes", fallback: false }, thanos: { fallback: false } });
    expect(responseB).toMatchObject({ provider: "deterministic", gateway: { provider: "legacy", fallback: false }, thanos: { fallback: false } });
    expect(hermesCalls).toBe(1);
    expect(repository.queryCells).toHaveBeenNthCalledWith(1, tenantA);
    expect(repository.queryCells).toHaveBeenNthCalledWith(2, tenantB);
    expect(repository.audits.filter(event => event.requestId === "tenant-a-hermes").every(event => event.context.organizationId === 1)).toBe(true);
    expect(repository.audits.filter(event => event.requestId === "tenant-b-legacy").every(event => event.context.organizationId === 2)).toBe(true);
  });

  it("não converte indisponibilidade da auditoria em retry, fallback ou duplicação", async () => {
    const repository = new GovernedIntegrationRepository();
    repository.failAuditActions.add("agent_gateway.hermes_attempt");
    repository.failAuditActions.add("agent_gateway.generate");
    let hermesCalls = 0;
    const hermes = new HermesClient(async () => {
      hermesCalls += 1;
      return new Response(JSON.stringify(chatCompletion("Resposta preservada apesar da telemetria.")), { status: 200 });
    }, () => 100, "https://hermes.internal/", "secret-never-returned");
    const router = createGovernedRouter(repository, hermes);

    const response = await router.respond({
      context: tenantA,
      conversationId: 61,
      message: "Mostre um resumo de células, presença e relatórios",
      requestId: "thanos-audit-outage",
    });

    expect(response).toMatchObject({ provider: "hermes", content: "Resposta preservada apesar da telemetria.", thanos: { fallback: false } });
    expect(hermesCalls).toBe(1);
    expect(repository.queryCells).toHaveBeenCalledTimes(1);
    expect(repository.queryAttendance).toHaveBeenCalledTimes(1);
    expect(repository.queryReports).toHaveBeenCalledTimes(1);
    expect(repository.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(repository.audits).toContainEqual(expect.objectContaining({
      action: "thanos.route",
      requestId: "thanos-audit-outage",
      metadata: expect.objectContaining({ route: "thanos", fallback: false }),
    }));
  });

  it("não converte falha da auditoria de tools THÁNOS em fallback ou repetição", async () => {
    const repository = new GovernedIntegrationRepository();
    repository.failAuditActions.add("agent.tool.execute");
    let hermesCalls = 0;
    const hermes = new HermesClient(async () => {
      hermesCalls += 1;
      return new Response(JSON.stringify(chatCompletion("Resposta preservada após auditoria de tools.")), { status: 200 });
    }, () => 100, "https://hermes.internal/", "secret-never-returned");
    const router = createGovernedRouter(repository, hermes);

    const response = await router.respond({
      context: tenantA,
      conversationId: 62,
      message: "Mostre um resumo de células, presença e relatórios",
      requestId: "thanos-tool-audit-outage",
    });

    expect(response).toMatchObject({ provider: "hermes", content: "Resposta preservada após auditoria de tools.", thanos: { mode: "multi_read", fallback: false } });
    expect(hermesCalls).toBe(1);
    expect(repository.queryCells).toHaveBeenCalledTimes(1);
    expect(repository.queryAttendance).toHaveBeenCalledTimes(1);
    expect(repository.queryReports).toHaveBeenCalledTimes(1);
    expect(repository.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "thanos.route", requestId: "thanos-tool-audit-outage", metadata: expect.objectContaining({ route: "thanos", fallback: false }) }));
  });

  it("não converte falha da auditoria de resposta THÁNOS em fallback ou repetição", async () => {
    const repository = new GovernedIntegrationRepository();
    repository.failAuditActions.add("agent.respond");
    let hermesCalls = 0;
    const hermes = new HermesClient(async () => {
      hermesCalls += 1;
      return new Response(JSON.stringify(chatCompletion("Resposta preservada após auditoria final.")), { status: 200 });
    }, () => 100, "https://hermes.internal/", "secret-never-returned");
    const router = createGovernedRouter(repository, hermes);

    const response = await router.respond({
      context: tenantA,
      conversationId: 63,
      message: "Mostre um resumo de células, presença e relatórios",
      requestId: "thanos-response-audit-outage",
    });

    expect(response).toMatchObject({ provider: "hermes", content: "Resposta preservada após auditoria final.", thanos: { mode: "multi_read", fallback: false } });
    expect(hermesCalls).toBe(1);
    expect(repository.queryCells).toHaveBeenCalledTimes(1);
    expect(repository.queryAttendance).toHaveBeenCalledTimes(1);
    expect(repository.queryReports).toHaveBeenCalledTimes(1);
    expect(repository.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "thanos.route", requestId: "thanos-response-audit-outage", metadata: expect.objectContaining({ route: "thanos", fallback: false }) }));
  });

  it("isola o circuit breaker entre dois tenants Hermes", async () => {
    const repository = new GovernedIntegrationRepository();
    let hermesCalls = 0;
    const hermes = new HermesClient(async (_url, init) => {
      hermesCalls += 1;
      if (new Headers(init?.headers).get("Idempotency-Key") === "tenant-a-opens-circuit") throw new Error("tenant A offline");
      return new Response(JSON.stringify(chatCompletion("Tenant B continua disponível.", "hermes-tenant-b")), { status: 200 });
    }, () => 100, "https://hermes.internal/", "secret-never-returned");
    const gateway = new AgentGateway(
      repository,
      new AgentCore(repository),
      async context => tenantGatewayConfig({ model: context.organizationId === 1 ? "hermes-tenant-a" : "hermes-tenant-b", circuitFailureThreshold: 1 }),
      hermes,
    );
    const facade = new PastoralThanosFacade(repository, gateway, async () => pastoralToolCatalog);
    const router = new ThanosPilotRouter(repository, gateway, facade, () => resolveThanosPilotRuntimeConfig({
      enabled: "true",
      killSwitch: "false",
      organizationIds: "1,2",
      userIds: "",
      version: "thanos-hermes-circuit-isolation-v1",
    }));

    const responseA = await router.respond({ context: tenantA, conversationId: 71, message: "Quais células temos?", requestId: "tenant-a-opens-circuit" });
    const responseB = await router.respond({ context: tenantB, conversationId: 72, message: "Quais células temos?", requestId: "tenant-b-after-a-failure" });

    expect(responseA).toMatchObject({ provider: "deterministic", gateway: { provider: "hermes", fallback: true }, thanos: { fallback: true } });
    expect(responseB).toMatchObject({ provider: "hermes", content: "Tenant B continua disponível.", gateway: { provider: "hermes", fallback: false }, thanos: { fallback: false } });
    expect(hermesCalls).toBe(2);
    expect(repository.audits).toContainEqual(expect.objectContaining({
      action: "agent_gateway.hermes_attempt",
      requestId: "tenant-b-after-a-failure",
      model: "hermes-tenant-b",
    }));
  });
});
