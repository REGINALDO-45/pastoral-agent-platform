import { describe, expect, it } from "vitest";
import { AgentCore } from "./agentCore";
import { AgentGateway } from "./agentGateway";
import { HermesClient } from "./hermesClient";
import type { PastoralRepository, TenantContext, ToolResult } from "./types";

const context: TenantContext = { organizationId: 1, organizationName: "Igreja A", userId: 1, userName: "Pastor", role: "pastor" };

class GatewayRepository implements PastoralRepository {
  audits: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  messages: Array<{ role: "user" | "assistant" }> = [];
  queryVisitorsCalls = 0;
  failAuditActions = new Set<string>();
  queryCells() { return Promise.resolve(this.summary("consultar_celulas")); }
  queryReports() { return Promise.resolve(this.summary("consultar_relatorios")); }
  queryAttendance() { return Promise.resolve(this.summary("consultar_presenca")); }
  queryVisitors() { this.queryVisitorsCalls += 1; return Promise.resolve(this.summary("consultar_visitantes")); }
  queryLeaders() { return Promise.resolve(this.summary("consultar_lideres")); }
  findVisitor() { return Promise.resolve(null); }
  appendMessage(input: { role: "user" | "assistant" }) { this.messages.push(input); return Promise.resolve(); }
  writeFollowup() { return Promise.resolve({ created: true, visitorName: "Ana" }); }
  audit(input: { action: string; metadata?: Record<string, unknown> }) {
    if (this.failAuditActions.has(input.action)) return Promise.reject(new Error("private audit detail"));
    this.audits.push(input);
    return Promise.resolve();
  }
  private summary(tool: ToolResult["tool"]): ToolResult { return { tool, summary: "Resumo seguro", data: { organizationId: 1 } }; }
}

function chatCompletion(content: string, model = "hermes-pilot") {
  return { model, choices: [{ message: { role: "assistant", content } }] };
}

describe("Agent Gateway", () => {
  it("mantém o Agent Core como fallback seguro e audita requestId", async () => {
    const repository = new GatewayRepository();
    const gateway = new AgentGateway(repository, new AgentCore(repository), async () => ({
      enabled: true,
      provider: "hermes",
      model: "hermes-pilot",
      hermesOrganizationIds: [1, 2],
      hermes: { enabled: true, configured: false, model: "hermes-pilot", timeoutMs: 4_500, retries: 1, circuitFailureThreshold: 3, circuitCooldownMs: 30_000 },
      fallbackPolicy: "deterministic",
      source: "organization",
    }));

    const response = await gateway.respond({ context, conversationId: 5, message: "Quais visitantes chegaram recentemente?", requestId: "request-pilot-1" });

    expect(response.gateway).toEqual({ version: "v1", provider: "hermes", fallback: true, fallbackReason: "hermes_unavailable" });
    expect(response.requestId).toBe("request-pilot-1");
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "agent_gateway.respond", metadata: expect.objectContaining({ requestId: "request-pilot-1", fallback: true }) }));
  });

  it("classifica invalid_request, faz fallback local e audita sem detalhes brutos", async () => {
    const repository = new GatewayRepository();
    let hermesCalls = 0;
    const hermes = new HermesClient(async () => {
      hermesCalls += 1;
      return new Response(JSON.stringify(chatCompletion("unexpected")), { status: 200 });
    }, () => 100, "https://hermes.example/", "secret-not-returned");
    const gateway = new AgentGateway(repository, new AgentCore(repository), async () => ({
      enabled: true,
      provider: "hermes",
      model: "x".repeat(161),
      hermesOrganizationIds: [1, 2],
      hermes: { enabled: true, configured: true, model: "hermes-pilot", timeoutMs: 4_500, retries: 2, circuitFailureThreshold: 3, circuitCooldownMs: 30_000 },
      fallbackPolicy: "deterministic",
      source: "organization",
    }), hermes);

    const response = await gateway.generate({
      context,
      requestId: "request-invalid-model",
      system: "Sistema sintético",
      user: "Responda somente com fallback local",
      fallback: "Fallback local seguro",
    });

    expect(response).toMatchObject({
      content: "Fallback local seguro",
      provider: "deterministic",
      gateway: { provider: "hermes", fallback: true, fallbackReason: "hermes_invalid_request" },
    });
    expect(hermesCalls).toBe(0);
    expect(repository.audits).toContainEqual(expect.objectContaining({
      action: "agent_gateway.generate",
      requestId: "request-invalid-model",
      result: "hermes_fallback",
      metadata: expect.objectContaining({ requestId: "request-invalid-model", fallback: true, fallbackReason: "hermes_invalid_request" }),
    }));
    expect(JSON.stringify(repository.audits)).not.toMatch(/secret-not-returned|hermes\.example|zod|stack/i);
  });

  it("audita teste Hermes sem incluir configurações internas", async () => {
    const repository = new GatewayRepository();
    const gateway = new AgentGateway(repository, new AgentCore(repository), async () => ({
      enabled: true,
      provider: "hermes",
      model: "hermes-pilot",
      hermesOrganizationIds: [1, 2],
      hermes: { enabled: true, configured: false, model: "hermes-pilot", timeoutMs: 4_500, retries: 1, circuitFailureThreshold: 3, circuitCooldownMs: 30_000 },
      fallbackPolicy: "deterministic",
      source: "organization",
    }));

    const result = await gateway.testHermesConnection(context);

    expect(result).toMatchObject({ connection: "unconfigured", lastFailure: "unconfigured", attempts: 0 });
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "agent_gateway.hermes_probe", metadata: expect.objectContaining({ attempts: 0, failure: "unconfigured" }) }));
    expect(JSON.stringify(repository.audits)).not.toMatch(/api.?key|base.?url|token/i);
  });

  it("usa Hermes como gerador opt-in sobre a evidência local e audita a tentativa correlacionada", async () => {
    const repository = new GatewayRepository();
    const hermes = new HermesClient(
      async input => {
        expect(String(input)).toContain("v1/chat/completions");
        return new Response(JSON.stringify(chatCompletion("Resposta Hermes baseada na evidência local.")), { status: 200, headers: { "Content-Type": "application/json" } });
      },
      () => 100,
      "https://hermes.example/",
      "secret-not-returned",
    );
    const gateway = new AgentGateway(repository, new AgentCore(repository), async () => ({
      enabled: true,
      provider: "hermes",
      model: "hermes-pilot",
      hermesOrganizationIds: [1, 2],
      hermes: { enabled: true, configured: true, model: "hermes-pilot", timeoutMs: 4_500, retries: 0, circuitFailureThreshold: 3, circuitCooldownMs: 30_000 },
      fallbackPolicy: "deterministic",
      source: "organization",
    }), hermes);

    const response = await gateway.respond({ context, conversationId: 5, message: "Quais visitantes chegaram recentemente?", requestId: "request-hermes-1" });

    expect(response).toMatchObject({ provider: "hermes", model: "hermes-pilot", content: "Resposta Hermes baseada na evidência local.", gateway: { provider: "hermes", fallback: false } });
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "agent_gateway.hermes_attempt", requestId: "request-hermes-1", metadata: expect.objectContaining({ attempt: 1 }) }));
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "agent_gateway.respond", result: "hermes_response" }));
    expect(JSON.stringify(repository.audits)).not.toMatch(/secret-not-returned|hermes\.example/i);
  });

  it("preserva a resposta legada já persistida quando a auditoria final falha", async () => {
    const repository = new GatewayRepository();
    repository.failAuditActions.add("agent_gateway.respond");
    let hermesCalls = 0;
    const hermes = new HermesClient(async () => {
      hermesCalls += 1;
      return new Response(JSON.stringify(chatCompletion("Resposta Hermes preservada.")), { status: 200 });
    }, () => 100, "https://hermes.example/", "secret-not-returned");
    const gateway = new AgentGateway(repository, new AgentCore(repository), async () => ({
      enabled: true,
      provider: "hermes",
      model: "hermes-pilot",
      hermesOrganizationIds: [1, 2],
      hermes: { enabled: true, configured: true, model: "hermes-pilot", timeoutMs: 4_500, retries: 0, circuitFailureThreshold: 1, circuitCooldownMs: 30_000 },
      fallbackPolicy: "deterministic",
      source: "organization",
    }), hermes);

    const response = await gateway.respond({ context, conversationId: 5, message: "Quais visitantes chegaram recentemente?", requestId: "request-audit-outage" });

    expect(response).toMatchObject({ provider: "hermes", content: "Resposta Hermes preservada.", gateway: { fallback: false } });
    expect(hermesCalls).toBe(1);
    expect(repository.queryVisitorsCalls).toBe(1);
    expect(repository.messages.map(message => message.role)).toEqual(["user", "assistant"]);
  });

  it("isola o circuit breaker Hermes entre tenants também no fluxo legado", async () => {
    const repository = new GatewayRepository();
    let hermesCalls = 0;
    const tenantB: TenantContext = { ...context, organizationId: 2, organizationName: "Igreja B", userId: 2 };
    const hermes = new HermesClient(async () => {
      hermesCalls += 1;
      if (hermesCalls === 1) throw new Error("tenant A offline");
      return new Response(JSON.stringify(chatCompletion("Tenant B continua disponível.")), { status: 200 });
    }, () => 100, "https://hermes.example/", "secret-not-returned");
    const gateway = new AgentGateway(repository, new AgentCore(repository), async () => ({
      enabled: true,
      provider: "hermes",
      model: "hermes-pilot",
      hermesOrganizationIds: [1, 2],
      hermes: { enabled: true, configured: true, model: "hermes-pilot", timeoutMs: 4_500, retries: 0, circuitFailureThreshold: 1, circuitCooldownMs: 30_000 },
      fallbackPolicy: "deterministic",
      source: "organization",
    }), hermes);

    await gateway.respond({ context, conversationId: 5, message: "Quais visitantes chegaram recentemente?", requestId: "legacy-tenant-a-failure" });
    const responseB = await gateway.respond({ context: tenantB, conversationId: 6, message: "Quais visitantes chegaram recentemente?", requestId: "legacy-tenant-b-success" });

    expect(responseB).toMatchObject({ provider: "hermes", content: "Tenant B continua disponível.", gateway: { fallback: false } });
    expect(hermesCalls).toBe(2);
  });
});
