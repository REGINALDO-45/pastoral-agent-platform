import { describe, expect, it } from "vitest";
import { resolveTenantGatewaySettings, toSanitizedTenantGatewayStatus } from "./tenantGatewayConfig";

const base = {
  enabled: true,
  provider: "legacy" as const,
  model: "legacy-router",
  hermesOrganizationIds: [],
  hermes: { enabled: false, configured: false, model: "hermes-default", timeoutMs: 4_500, retries: 1, circuitFailureThreshold: 3, circuitCooldownMs: 30_000 },
};

describe("configuração do Gateway por organização", () => {
  it("resolve preferências diferentes sem compartilhar provider ou modelo entre organizações", () => {
    const churchA = resolveTenantGatewaySettings(base, { enabled: true, provider: "hermes", model: "hermes-a", fallbackPolicy: "deterministic" });
    const churchB = resolveTenantGatewaySettings(base, { enabled: false, provider: "legacy", model: "legacy-b", fallbackPolicy: "deterministic" });

    expect(churchA).toMatchObject({ source: "organization", provider: "hermes", model: "hermes-a", enabled: true });
    expect(churchB).toMatchObject({ source: "organization", provider: "legacy", model: "legacy-b", enabled: false });
    expect(churchA.model).not.toBe(churchB.model);
  });

  it("expõe somente estado sanitizado e nunca inclui URL ou chave de provider", () => {
    const status = toSanitizedTenantGatewayStatus(resolveTenantGatewaySettings(base));
    expect(JSON.stringify(status)).not.toMatch(/api.?key|base.?url|token/i);
    expect(status).toMatchObject({ source: "environment", fallbackPolicy: "deterministic" });
  });
});
