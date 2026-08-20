import { afterEach, describe, expect, it, vi } from "vitest";

const envKeys = [
  "HERMES_ENABLED",
  "AGENT_GATEWAY_PROVIDER",
  "HERMES_ORGANIZATION_IDS",
] as const;
const originalEnvironment = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]])
) as Record<(typeof envKeys)[number], string | undefined>;

function restoreEnvironment() {
  for (const key of envKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
}

afterEach(() => restoreEnvironment());

describe("rollout operacional Hermes M19", () => {
  it("permanece OFF por default e falha fechado sem audiência explícita", async () => {
    delete process.env.HERMES_ENABLED;
    delete process.env.AGENT_GATEWAY_PROVIDER;
    delete process.env.HERMES_ORGANIZATION_IDS;
    vi.resetModules();

    const { getAgentGatewayRuntimeConfig, enforceHermesEligibility } =
      await import("./gatewayConfig");
    const config = getAgentGatewayRuntimeConfig();

    expect(config).toMatchObject({
      provider: "legacy",
      hermesOrganizationIds: [],
      hermes: { enabled: false },
    });
    expect(enforceHermesEligibility(config, 1)).toMatchObject({
      provider: "legacy",
      hermes: { enabled: false },
    });
  });

  it("atende somente a organização Hermes allowlisted e mantém as demais no AgentCore local", async () => {
    process.env.HERMES_ENABLED = "true";
    process.env.AGENT_GATEWAY_PROVIDER = "hermes";
    process.env.HERMES_ORGANIZATION_IDS = "1";
    vi.resetModules();

    const { getAgentGatewayRuntimeConfig, enforceHermesEligibility } =
      await import("./gatewayConfig");
    const config = getAgentGatewayRuntimeConfig();
    const allowed = enforceHermesEligibility(config, 1);
    const denied = enforceHermesEligibility(config, 2);

    expect(config).toMatchObject({
      provider: "hermes",
      hermesOrganizationIds: [1],
      hermes: { enabled: true },
    });
    expect(allowed).toMatchObject({
      provider: "hermes",
      hermes: { enabled: true },
    });
    expect(denied).toMatchObject({
      provider: "legacy",
      hermes: { enabled: false },
    });
  });
});
