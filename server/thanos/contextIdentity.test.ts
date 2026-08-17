import { describe, expect, it } from "vitest";
import {
  createThanosContextIdentity,
  tenantIdFromOrganizationId,
  toDomain,
  toTenantId,
  toWorkspaceKey,
} from "./contextIdentity";

describe("identidade contextual THÁNOS", () => {
  it("mantém workspace, tenant e domínio como conceitos separados mesmo quando os textos coincidem", () => {
    const identity = createThanosContextIdentity({
      workspaceKey: toWorkspaceKey("pastoral"),
      tenantId: tenantIdFromOrganizationId(41),
      domain: toDomain("pastoral"),
    });

    expect(identity).toEqual({ workspaceKey: "pastoral", tenantId: "org:41", domain: "pastoral" });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(identity.workspaceKey).not.toBe(identity.tenantId);
    expect(identity.tenantId).not.toBe(identity.domain);
  });

  it("deriva tenant apenas de um identificador organizacional server-side válido", () => {
    expect(tenantIdFromOrganizationId(1)).toBe("org:1");
    expect(() => tenantIdFromOrganizationId(0)).toThrow("organizationId");
    expect(() => tenantIdFromOrganizationId(1.5)).toThrow("organizationId");
  });

  it("aceita tenantId textual para workspaces não acoplados a organizationId", () => {
    expect(toTenantId("synthetic-tenant-a")).toBe("synthetic-tenant-a");
    expect(() => toTenantId("  ")).toThrow("tenantId");
  });

  it("rejeita chaves e domínios vazios antes de compor contexto", () => {
    expect(() => toWorkspaceKey("  ")).toThrow("workspaceKey");
    expect(() => toDomain("  ")).toThrow("domain");
  });
});
