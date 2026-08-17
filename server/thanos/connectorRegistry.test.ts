import { describe, expect, it, vi } from "vitest";
import { createThanosContext } from "./context";
import { toDomain, toTenantId, toWorkspaceKey } from "./contextIdentity";
import { createChannelPolicy } from "./channels";
import { normalizeThanosEvidence, type ThanosEvidence } from "./evidence";
import {
  ThanosConnectorError,
  ThanosConnectorRegistry,
  type ThanosConnector,
  type ThanosConnectorAuditPort,
} from "./connectorRegistry";

function context(capabilities: readonly string[] = ["agent:read", "connector:execute"]) {
  return createThanosContext({
    workspaceKey: toWorkspaceKey("synthetic-operations"),
    tenantId: toTenantId("tenant:connectors"),
    domain: toDomain("synthetic-operations"),
    userId: 14,
    userName: "Connector Test",
    role: "reader",
    capabilities,
    channel: "chat",
    requestId: "connector-request-1",
  });
}

function audit(events: Array<Record<string, unknown>>): ThanosConnectorAuditPort {
  return { record: async event => void events.push(event) };
}

function readConnector(execute = vi.fn(async ({ context: value, requestId }): Promise<{ status: "success"; evidence: ThanosEvidence }> => ({
  status: "success",
  evidence: normalizeThanosEvidence({ summary: "Mock READ concluído", data: { ok: true } }, value, { source: "connector", tool: "mock:read" }),
}))) : ThanosConnector {
  return {
    manifest: {
      key: "mock:read",
      displayName: "Mock READ",
      intent: "READ",
      requiredCapability: "connector:execute",
      allowedChannels: ["chat"],
      allowedPayloadKinds: ["text"],
      enabled: true,
    },
    execute,
  };
}

function writeConnector(execute = vi.fn(async ({ context: value }): Promise<{ status: "success"; evidence: ThanosEvidence }> => ({
  status: "success",
  evidence: normalizeThanosEvidence({ summary: "Mock WRITE concluído", data: { created: true } }, value, { source: "connector", tool: "mock:write" }),
}))) : ThanosConnector {
  return {
    manifest: {
      key: "mock:write",
      displayName: "Mock WRITE",
      intent: "WRITE",
      requiredCapability: "connector:execute",
      allowedChannels: ["chat"],
      allowedPayloadKinds: ["text"],
      enabled: true,
    },
    execute,
  };
}

describe("ThanosConnectorRegistry", () => {
  it("executa mock READ somente após allowlist, policy e capability", async () => {
    const events: Array<Record<string, unknown>> = [];
    const execute = vi.fn(async ({ context: value }: { context: ReturnType<typeof context> }) => ({
      status: "success" as const,
      evidence: normalizeThanosEvidence({ summary: "Mock READ concluído", data: { ok: true } }, value, { source: "connector", tool: "mock:read" }),
    }));
    const registry = new ThanosConnectorRegistry(["mock:read"], createChannelPolicy({ allowedChannels: ["chat"], allowedPayloadKinds: ["text"] }), audit(events));
    registry.register(readConnector(execute));

    const result = await registry.execute({ context: context(), connectorKey: "mock:read", requestId: "connector-request-1", channel: "chat", payloadKind: "text", values: { query: "sanitized" } });

    expect(registry.list()).toEqual([expect.objectContaining({ key: "mock:read", intent: "READ" })]);
    expect(result).toMatchObject({ status: "success", evidence: { summary: "Mock READ concluído", provenance: { source: "connector", requestId: "connector-request-1" } } });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0].input).toEqual({ query: "sanitized" });
    expect(events).toContainEqual(expect.objectContaining({ action: "thanos.connector.execute", result: "connector_executed" }));
  });

  it("recusa connector fora da allowlist ou desabilitado", async () => {
    const events: Array<Record<string, unknown>> = [];
    const registry = new ThanosConnectorRegistry(["mock:read"], createChannelPolicy({ allowedChannels: ["chat"] }), audit(events));
    expect(() => registry.register(writeConnector())).toThrow("allowlist");
    registry.register(readConnector());

    await expect(registry.execute({ context: context(), connectorKey: "not-registered", requestId: "connector-request-1", channel: "chat", payloadKind: "text" })).rejects.toThrow("não registrado");
    expect(events).toContainEqual(expect.objectContaining({ result: "connector_not_registered" }));
  });

  it("recusa capability ausente, requestId divergente e canal fora da policy", async () => {
    const events: Array<Record<string, unknown>> = [];
    const execute = vi.fn();
    const registry = new ThanosConnectorRegistry(["mock:read"], createChannelPolicy({ allowedChannels: ["chat"], allowedPayloadKinds: ["text"] }), audit(events));
    registry.register(readConnector(execute));

    await expect(registry.execute({ context: context(["agent:read"]), connectorKey: "mock:read", requestId: "connector-request-1", channel: "chat", payloadKind: "text" })).rejects.toThrow("Capability não autorizada");
    await expect(registry.execute({ context: context(), connectorKey: "mock:read", requestId: "other-request", channel: "chat", payloadKind: "text" })).rejects.toThrow("requestId");
    await expect(registry.execute({ context: context(), connectorKey: "mock:read", requestId: "connector-request-1", channel: "voice", payloadKind: "voice" })).rejects.toThrow("Canal ou payload");
    expect(execute).not.toHaveBeenCalled();
    expect(events.filter(event => event.action === "thanos.connector.denied")).toHaveLength(3);
  });

  it("exige confirmação explícita para connector WRITE", async () => {
    const events: Array<Record<string, unknown>> = [];
    const execute = vi.fn();
    const registry = new ThanosConnectorRegistry(["mock:write"], createChannelPolicy({ allowedChannels: ["chat"] }), audit(events));
    registry.register(writeConnector(execute));

    await expect(registry.execute({ context: context(), connectorKey: "mock:write", requestId: "connector-request-1", channel: "chat", payloadKind: "text" })).rejects.toThrow("confirmação");
    expect(execute).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ result: "confirmation_required" }));
  });

  it("rejeita manifestos com capability incompatível", () => {
    const registry = new ThanosConnectorRegistry(["bad"], createChannelPolicy({ allowedChannels: ["chat"] }), audit([]));
    const invalid: ThanosConnector = {
      manifest: {
        key: "bad",
        displayName: "Bad",
        intent: "WRITE",
        requiredCapability: "agent:read",
        allowedChannels: ["chat"],
        allowedPayloadKinds: ["text"],
        enabled: true,
      },
      execute: async () => { throw new ThanosConnectorError("should not execute"); },
    };
    expect(() => registry.register(invalid)).toThrow("capability de escrita");
  });
});
