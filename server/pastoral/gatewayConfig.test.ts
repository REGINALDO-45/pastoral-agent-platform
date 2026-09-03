import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentGatewayRuntimeConfig } from "./gatewayConfig";

const hermesEnvironment = ["HERMES_BASE_URL", "HERMES_API_KEY", "HERMES_PRODUCTION_HOST_DENYLIST"] as const;
const originalHermesEnvironment = Object.fromEntries(hermesEnvironment.map(key => [key, process.env[key]])) as Record<(typeof hermesEnvironment)[number], string | undefined>;

afterEach(() => {
  for (const key of hermesEnvironment) {
    const value = originalHermesEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe("configuração do Agent Gateway", () => {
  it("produz configuração sanitizada sem expor URL ou chave Hermes", () => {
    const config = getAgentGatewayRuntimeConfig();
    expect(config).toEqual(expect.objectContaining({ enabled: expect.any(Boolean), provider: expect.any(String), model: expect.any(String), hermesOrganizationIds: expect.any(Array) }));
    expect(Object.keys(config.hermes)).toEqual(["enabled", "configured", "model", "timeoutMs", "retries", "circuitFailureThreshold", "circuitCooldownMs"]);
  });

  it.each(["http://hermes.example", "ftp://hermes.example", "ws://hermes.example", "https://hermes-prod.example"])("trata base Hermes insegura como não configurada: %s", async baseUrl => {
    process.env.HERMES_BASE_URL = baseUrl;
    process.env.HERMES_API_KEY = "configured-secret";
    vi.resetModules();
    const { getAgentGatewayRuntimeConfig: getFreshConfig } = await import("./gatewayConfig");
    expect(getFreshConfig().hermes.configured).toBe(false);
  });

  it("aceita a URL HTTPS definitiva do Hermes sem expô-la no status", async () => {
    process.env.HERMES_BASE_URL = "https://hermes-thanos-163-176-174-128.sslip.io";
    process.env.HERMES_API_KEY = "configured-secret";
    vi.resetModules();
    const { getAgentGatewayRuntimeConfig: getFreshConfig } = await import("./gatewayConfig");
    const config = getFreshConfig();
    expect(config.hermes.configured).toBe(true);
    expect(JSON.stringify(config)).not.toContain("sslip.io");
    expect(JSON.stringify(config)).not.toContain("configured-secret");
  });
});
