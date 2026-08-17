import { describe, expect, it } from "vitest";
import { assertThanosPlatformCapability, createThanosContext } from "./context";
import { toDomain, toTenantId, toWorkspaceKey } from "./contextIdentity";
import {
  assertPlatformCapability,
  createPlatformAccess,
  hasPlatformCapability,
  PlatformAuthorizationError,
} from "./platformAccess";

function createTenantContext(input: Readonly<{ role: string; capabilities: readonly string[] }>) {
  return createThanosContext({
    workspaceKey: toWorkspaceKey("pastoral"),
    tenantId: toTenantId("org:tenant-a"),
    domain: toDomain("pastoral"),
    userId: 7,
    userName: "Usuário Teste",
    role: input.role,
    capabilities: input.capabilities,
    channel: "chat",
    requestId: "platform-access-test",
  });
}

describe("platform access THÁNOS", () => {
  it("mantém tenant admin sem qualquer capability de plataforma", () => {
    const context = createTenantContext({ role: "admin", capabilities: ["agent:read", "settings:manage"] });

    expect(context.platformRole).toBe("none");
    expect(context.platformCapabilities).toEqual([]);
    expect(() => assertThanosPlatformCapability(context, "platform:tenant:list")).toThrow(PlatformAuthorizationError);
  });

  it("nega usuário comum e capability de tenant para operações de plataforma", () => {
    const context = createTenantContext({ role: "pastor", capabilities: ["agent:read", "dashboard:read"] });

    expect(() => assertThanosPlatformCapability(context, "platform:tenant:list")).toThrow(PlatformAuthorizationError);
    expect(context.capabilities).not.toContain("platform:tenant:list");
  });

  it("exige platform role explícito e capability específica, sem bypass por superadmin", () => {
    const access = createPlatformAccess({ role: "superadmin", capabilities: ["platform:tenant:list"] });

    expect(hasPlatformCapability(access, "platform:tenant:list")).toBe(true);
    expect(hasPlatformCapability(access, "platform:tenant:read")).toBe(false);
    expect(() => assertPlatformCapability(access, "platform:tenant:read")).toThrow(PlatformAuthorizationError);
  });

  it("rejeita capability desconhecida e capabilities globais sem platform role", () => {
    expect(() => createPlatformAccess({ role: "none", capabilities: ["platform:tenant:list"] })).toThrow(PlatformAuthorizationError);
    expect(() => createPlatformAccess({ role: "superadmin", capabilities: ["platform:unknown"] })).toThrow(PlatformAuthorizationError);
  });
});
