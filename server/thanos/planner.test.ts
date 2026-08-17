import { describe, expect, it, vi } from "vitest";
import { createThanosContext } from "./context";
import { toDomain, toTenantId, toWorkspaceKey } from "./contextIdentity";
import { ThanosReadPlanError, ThanosReadPlanner, type ThanosReadPlanStep } from "./planner";
import type { ThanosAuditPort, ThanosEvidence, ThanosGeneratorPort, ThanosReadTool } from "./orchestrator";

function createContext(capabilities: readonly string[] = ["agent:read", "dashboard:read"]) {
  return createThanosContext({
    workspaceKey: toWorkspaceKey("pastoral"),
    tenantId: toTenantId("org:planner"),
    domain: toDomain("pastoral"),
    userId: 42,
    userName: "Planner Test",
    role: "pastor",
    capabilities,
    channel: "chat",
    requestId: "planner-request-1",
  });
}

function createAudit(events: Array<Record<string, unknown>>): ThanosAuditPort {
  return { record: async event => void events.push(event) };
}

function createGenerator(content = "Resposta composta"): ThanosGeneratorPort {
  return {
    generate: vi.fn(async () => ({ content, provider: "test", model: "test-model" })),
  };
}

function createTool(
  name: string,
  requiredCapability: "agent:read" | "dashboard:read" = "agent:read",
  execute: (context: ReturnType<typeof createContext>) => Promise<ThanosEvidence> = async context => ({
    summary: `${name} para ${context.tenantId}`,
    data: { tool: name },
  }),
): ThanosReadTool {
  return { name, requiredCapability, execute };
}

function step(tool: ThanosReadTool, intent: "READ" | "WRITE" = "READ"): ThanosReadPlanStep {
  return { tool, capability: tool.requiredCapability, intent };
}

describe("ThanosReadPlanner", () => {
  it("executa plano READ declarado e entrega contexto fresco por etapa com requestId compartilhado", async () => {
    const events: Array<Record<string, unknown>> = [];
    const contexts: Array<ReturnType<typeof createContext>> = [];
    const first = createTool("consultar_celulas", "agent:read", async context => {
      contexts.push(context);
      return { summary: "Células disponíveis.", data: { cells: 3 } };
    });
    const second = createTool("consultar_presenca", "dashboard:read", async context => {
      contexts.push(context);
      return { summary: "Presença registrada.", data: { attendance: 12 } };
    });
    const generator = createGenerator();

    const result = await new ThanosReadPlanner(createAudit(events), () => 100).run({
      context: createContext(),
      plan: { planId: "plan-read-1", steps: [step(first), step(second)] },
      system: "system",
      user: "resuma",
      generator,
    });

    expect(result).toMatchObject({ planId: "plan-read-1", content: "Resposta composta", provider: "test", fallback: false, requestId: "planner-request-1", tools: ["consultar_celulas", "consultar_presenca"] });
    expect(result.evidence).toMatchObject({
      summary: "Células disponíveis. Presença registrada.",
      data: {
        steps: [
          { tool: "consultar_celulas", data: { cells: 3 }, provenance: { source: "tool", tool: "consultar_celulas", step: 1, workspaceKey: "pastoral", tenantId: "org:planner", requestId: "planner-request-1" } },
          { tool: "consultar_presenca", data: { attendance: 12 }, provenance: { source: "tool", tool: "consultar_presenca", step: 2, workspaceKey: "pastoral", tenantId: "org:planner", requestId: "planner-request-1" } },
        ],
      },
      provenance: { source: "composite", workspaceKey: "pastoral", tenantId: "org:planner", requestId: "planner-request-1" },
    });
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).not.toBe(contexts[1]);
    expect(contexts.every(context => context.requestId === "planner-request-1" && context.tenantId === "org:planner")).toBe(true);
    expect(generator.generate).toHaveBeenCalledOnce();
    expect(events.map(event => event.result)).toEqual(["plan_step_completed", "plan_step_completed", "plan_response_generated"]);
  });

  it("recusa plano fora do limite, passo WRITE e capability declarada divergente", async () => {
    const planner = new ThanosReadPlanner(createAudit([]));
    const tool = createTool("consultar_celulas");

    await expect(planner.run({ context: createContext(), plan: { planId: "", steps: [step(tool), step(tool)] }, system: "", user: "", generator: createGenerator() })).rejects.toThrow(ThanosReadPlanError);
    await expect(planner.run({ context: createContext(), plan: { planId: "plan-write", steps: [step(tool, "WRITE"), step(tool)] }, system: "", user: "", generator: createGenerator() })).rejects.toThrow("somente intenção READ");
    await expect(planner.run({ context: createContext(), plan: { planId: "plan-mismatch", steps: [{ tool, capability: "dashboard:read", intent: "READ" }, step(tool)] }, system: "", user: "", generator: createGenerator() })).rejects.toThrow("capability diferente");
  });

  it("faz preflight de capability sem executar nenhum passo não autorizado", async () => {
    const events: Array<Record<string, unknown>> = [];
    const execute = vi.fn(async () => ({ summary: "não deveria executar", data: {} }));
    const tool = createTool("consultar_presenca", "dashboard:read", execute);

    await expect(new ThanosReadPlanner(createAudit(events)).run({
      context: createContext(["agent:read"]),
      plan: { planId: "plan-denied", steps: [step(createTool("consultar_celulas")), step(tool)] },
      system: "",
      user: "",
      generator: createGenerator(),
    })).rejects.toThrow("Capability não autorizada");

    expect(execute).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ action: "thanos.read.denied", result: "plan_step_capability_not_authorized", step: 2 }));
  });

  it("retorna fallback parcial determinístico e não gera texto quando uma etapa falha", async () => {
    const events: Array<Record<string, unknown>> = [];
    const generator = createGenerator();
    const failing = createTool("consultar_presenca", "dashboard:read", async () => {
      throw new Error("falha sintética");
    });

    const result = await new ThanosReadPlanner(createAudit(events)).run({
      context: createContext(),
      plan: { planId: "plan-fallback", steps: [step(createTool("consultar_celulas")), step(failing)] },
      system: "",
      user: "",
      generator,
    });

    expect(result).toMatchObject({ planId: "plan-fallback", provider: "deterministic", model: "thanos-read-plan-fallback-v1", fallback: true, tools: ["consultar_celulas", "consultar_presenca"] });
    expect(result.content).toContain("consultar_celulas para org:planner");
    expect(generator.generate).not.toHaveBeenCalled();
    expect(events.map(event => event.result)).toEqual(["plan_step_completed", "plan_step_failed", "plan_partial_fallback"]);
  });
});
