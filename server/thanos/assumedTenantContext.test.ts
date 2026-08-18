import { describe, expect, it } from "vitest";
import { createThanosContext } from "./context";
import { assumeTenantContext, TenantAssumptionError, type AssumedTenantAuditEvent } from "./assumedTenantContext";
import { toDomain, toTenantId, toWorkspaceKey } from "./contextIdentity";

function createContext(withAssumeCapability = false) {
  return createThanosContext({
    workspaceKey: toWorkspaceKey("pastoral"),
    tenantId: toTenantId("org:original"),
    domain: toDomain("pastoral"),
    userId: 900,
    userName: "Platform Operator",
    role: "admin",
    capabilities: ["agent:read", "settings:manage"],
    platformRole: withAssumeCapability ? "superadmin" : "none",
    platformCapabilities: withAssumeCapability ? ["platform:tenant:assume"] : [],
    channel: "chat",
    requestId: "assume-request-1",
  });
}

function auditPort(events: AssumedTenantAuditEvent[]) {
  return { record: async (event: AssumedTenantAuditEvent) => void events.push(event) };
}

describe("contexto assumido governado", () => {
  it("nega tenant admin sem capability de plataforma e registra o ator real", async () => {
    const events: AssumedTenantAuditEvent[] = [];

    await expect(assumeTenantContext({
      context: createContext(),
      targetTenantId: toTenantId("org:target"),
      directory: { exists: async () => true },
      audit: auditPort(events),
    })).rejects.toThrow(TenantAssumptionError);

    expect(events).toEqual([expect.objectContaining({
      action: "thanos.tenant.assume",
      status: "denied",
      actorUserId: 900,
      originalTenantId: "org:original",
      targetTenantId: "org:target",
      requestId: "assume-request-1",
      reason: "platform_capability_missing",
    })]);
  });

  it("nega tenant inexistente mesmo com capability explícita", async () => {
    const events: AssumedTenantAuditEvent[] = [];

    await expect(assumeTenantContext({
      context: createContext(true),
      targetTenantId: toTenantId("org:missing"),
      directory: { exists: async () => false },
      audit: auditPort(events),
    })).rejects.toThrow("Tenant alvo não encontrado.");

    expect(events.at(-1)).toMatchObject({ status: "denied", reason: "tenant_not_found", context: "original" });
  });

  it("preserva requestId e contexto original, permite saída explícita e não altera membership", async () => {
    const events: AssumedTenantAuditEvent[] = [];
    const originalContext = createContext(true);
    const assumed = await assumeTenantContext({
      context: originalContext,
      targetTenantId: toTenantId("org:target"),
      directory: { exists: async tenantId => tenantId === "org:target" },
      audit: auditPort(events),
    });

    expect(assumed).toMatchObject({
      assumed: true,
      actorUserId: 900,
      targetTenantId: "org:target",
      requestId: "assume-request-1",
      platformCapability: "platform:tenant:assume",
    });
    expect(assumed.originalContext).toBe(originalContext);
    expect((assumed as { membership?: unknown }).membership).toBeUndefined();

    const restored = await assumed.exit();
    expect(restored).toBe(originalContext);
    await expect(assumed.exit()).resolves.toBe(originalContext);
    expect(events.map(event => `${event.action}:${event.status}`)).toEqual([
      "thanos.tenant.assume:success",
      "thanos.tenant.exit:success",
      "thanos.tenant.exit:denied",
    ]);
    expect(events.every(event => event.requestId === "assume-request-1" && event.actorUserId === 900)).toBe(true);
  });
});
