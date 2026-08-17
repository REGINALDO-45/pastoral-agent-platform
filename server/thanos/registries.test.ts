import { describe, expect, it } from "vitest";
import { thanosSkillRegistry, thanosWorkspaceRegistry } from "./defaultRegistries";
import { toTenantId, toWorkspaceKey } from "./contextIdentity";
import { SkillNotRegisteredError } from "./skillRegistry";
import { WorkspaceNotRegisteredError } from "./workspaceRegistry";

const tenantContext = {
  organizationId: 42,
  organizationName: "Igreja Teste",
  userId: 7,
  userName: "Pessoa Teste",
  role: "pastor" as const,
};

describe("registros fechados do THÁNOS", () => {
  it("resolve o contexto Pastoral somente a partir da identidade server-side", () => {
    const workspace = thanosWorkspaceRegistry.get("pastoral");
    const context = workspace.resolveContext({
      tenantContext,
      channel: "chat",
      conversationId: 15,
      serverRequestId: "request-servidor-42",
      workspaceKey: "outro-workspace",
      tenantId: "org:999",
      domain: "outro-dominio",
    } as unknown as Parameters<typeof workspace.resolveContext>[0]);

    expect(context).toMatchObject({
      workspaceKey: "pastoral",
      tenantId: "org:42",
      domain: "pastoral",
      requestId: "request-servidor-42",
      channel: "chat",
      conversationId: 15,
    });
    expect(context.capabilities).toEqual(["agent:read", "agent:write", "dashboard:read"]);
  });

  it("nega workspaces e skills não registrados", () => {
    expect(() => thanosWorkspaceRegistry.get("financeiro")).toThrow(WorkspaceNotRegisteredError);
    expect(() => thanosSkillRegistry.getForWorkspace(toWorkspaceKey("pastoral"), "financeiro-assistant")).toThrow(SkillNotRegisteredError);
  });

  it("limita a skill pastoral ao workspace registrado e declara suas ferramentas", () => {
    const skill = thanosSkillRegistry.getForWorkspace(toWorkspaceKey("pastoral"), "pastoral-assistant");
    expect(skill.domain).toBe("pastoral");
    expect(skill.allowedTools).toContain("consultar_celulas");
    expect(skill.allowedTools).not.toContain("consultar_visitantes");
    expect(skill.allowedTools).not.toContain("registrar_acompanhamento_visitante");
    expect(skill.allowedChannels).toEqual(["chat"]);
    expect(skill.requiredCapabilities).toEqual(["agent:read"]);
    expect(skill.readOnly).toBe(true);
    expect(thanosWorkspaceRegistry.list()).toHaveLength(2);
  });

  it("registra um segundo workspace sintético como skill READ-only sem importar o domínio Pastoral", () => {
    const workspace = thanosWorkspaceRegistry.get("synthetic-operations");
    const context = workspace.resolveContext({
      tenantId: toTenantId("synthetic-tenant-a"),
      userId: 42,
      userName: "Usuário Sintético",
      role: "reader",
      channel: "chat",
      requestId: "synthetic-bootstrap-1",
    });
    const skill = thanosSkillRegistry.getForWorkspace(context.workspaceKey, "synthetic-operations-readonly");

    expect(context).toMatchObject({ workspaceKey: "synthetic-operations", tenantId: "synthetic-tenant-a", domain: "synthetic-operations", requestId: "synthetic-bootstrap-1" });
    expect(skill).toMatchObject({ domain: "synthetic-operations", allowedTools: ["listar_pendencias_sinteticas"], allowedChannels: ["chat"], requiredCapabilities: ["agent:read"], readOnly: true });
  });
});
