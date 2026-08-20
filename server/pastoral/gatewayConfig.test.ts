import { describe, expect, it } from "vitest";
import { getAgentGatewayRuntimeConfig } from "./gatewayConfig";

describe("configuração do Agent Gateway", () => {
  it("produz configuração sanitizada sem expor URL ou chave Hermes", () => {
    const config = getAgentGatewayRuntimeConfig();
    expect(config).toEqual(expect.objectContaining({ enabled: expect.any(Boolean), provider: expect.any(String), model: expect.any(String), hermesOrganizationIds: expect.any(Array) }));
    expect(Object.keys(config.hermes)).toEqual(["enabled", "configured", "model", "timeoutMs", "retries", "circuitFailureThreshold", "circuitCooldownMs"]);
  });
});
