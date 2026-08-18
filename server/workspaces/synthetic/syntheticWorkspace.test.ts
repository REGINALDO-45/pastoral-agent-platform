import { describe, expect, it } from "vitest";
import { createThanosContext } from "../../thanos/context";
import { toTenantId } from "../../thanos/contextIdentity";
import { ThanosReadOrchestrator } from "../../thanos/orchestrator";
import { SkillRegistry } from "../../thanos/skillRegistry";
import { WorkspaceRegistry } from "../../thanos/workspaceRegistry";
import { syntheticPendingReadTool } from "./readTool";
import { syntheticSkillDefinition, syntheticWorkspaceDefinition } from "./workspaceDefinition";

const tenantId = toTenantId("synthetic-tenant-a");

function resolveSyntheticContext() {
  return syntheticWorkspaceDefinition.resolveContext({
    tenantId,
    userId: 42,
    userName: "Usuário Sintético",
    role: "reader",
    channel: "chat",
    conversationId: 77,
    requestId: "synthetic-request-1",
  });
}

describe("workspace sintético READ-only", () => {
  it("prova que o core resolve um segundo workspace sem importar conceitos pastorais", async () => {
    const workspaceRegistry = new WorkspaceRegistry([syntheticWorkspaceDefinition]);
    const skillRegistry = new SkillRegistry([syntheticSkillDefinition]);
    const workspace = workspaceRegistry.get("synthetic-operations");
    const context = resolveSyntheticContext();
    const skill = skillRegistry.getForWorkspace(context.workspaceKey, "synthetic-operations-readonly");
    const events: Array<{ action: string; status: string; tool: string }> = [];

    const result = await new ThanosReadOrchestrator({
      record: async event => {
        events.push({ action: event.action, status: event.status, tool: event.tool });
      },
    }).run({
      context,
      tool: syntheticPendingReadTool,
      system: "Responda somente com a evidência sintética.",
      user: "Quais pendências existem?",
      generator: {
        generate: async input => ({
          content: `${input.context.workspaceKey}: ${input.evidence.data.pending} pendências.`,
          provider: "deterministic",
          model: "synthetic-rules-v1",
        }),
      },
    });

    expect(workspace).toMatchObject({ workspaceKey: "synthetic-operations", domain: "synthetic-operations" });
    expect(skill).toMatchObject({ key: "synthetic-operations-readonly", readOnly: true, allowedChannels: ["chat"], requiredCapabilities: ["agent:read"] });
    expect(context).toMatchObject({ workspaceKey: "synthetic-operations", tenantId, domain: "synthetic-operations", channel: "chat", requestId: "synthetic-request-1" });
    expect(result).toMatchObject({ provider: "deterministic", model: "synthetic-rules-v1", tool: "listar_pendencias_sinteticas", requestId: "synthetic-request-1" });
    expect(result.evidence.data).toMatchObject({ pending: 2, workspaceKey: "synthetic-operations", tenantId: "synthetic-tenant-a", domain: "synthetic-operations" });
    expect(events).toContainEqual({ action: "thanos.read", status: "success", tool: "listar_pendencias_sinteticas" });
  });

  it("nega execução sintética sem agent:read antes de executar a ferramenta", async () => {
    const context = createThanosContext({
      workspaceKey: syntheticWorkspaceDefinition.workspaceKey,
      tenantId,
      domain: syntheticWorkspaceDefinition.domain,
      userId: 42,
      userName: "Usuário Sintético",
      role: "reader",
      capabilities: [],
      channel: "chat",
      requestId: "synthetic-request-denied",
    });
    let executed = false;

    await expect(new ThanosReadOrchestrator({ record: async () => undefined }).run({
      context,
      tool: {
        ...syntheticPendingReadTool,
        execute: async () => {
          executed = true;
          return { summary: "não deveria executar", data: {} };
        },
      },
      system: "",
      user: "",
      generator: { generate: async () => ({ content: "", provider: "deterministic", model: "synthetic-rules-v1" }) },
    })).rejects.toThrow("Capability não autorizada para o contexto THÁNOS.");

    expect(executed).toBe(false);
  });
});
