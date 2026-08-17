import { describe, expect, it } from "vitest";
import { createThanosContext } from "./context";
import { toDomain, toTenantId, toWorkspaceKey } from "./contextIdentity";
import {
  assertChannelAllowed,
  createChannelEnvelope,
  createChannelPolicy,
  createChannelResponse,
  ThanosChannelPolicyError,
} from "./channels";

function context() {
  return createThanosContext({
    workspaceKey: toWorkspaceKey("synthetic-operations"),
    tenantId: toTenantId("tenant:channels"),
    domain: toDomain("synthetic-operations"),
    userId: 13,
    userName: "Channel Test",
    role: "reader",
    capabilities: ["agent:read"],
    channel: "chat",
    requestId: "channel-request-1",
  });
}

describe("THÁNOS channel contracts", () => {
  it("preserva requestId e identidades ao criar envelope e resposta", () => {
    const policy = createChannelPolicy({ allowedChannels: ["chat", "voice"], allowedPayloadKinds: ["text", "voice"] });
    const envelope = createChannelEnvelope({ context: context(), channel: "voice", payloadKind: "voice", content: "audio-ref" });
    const response = createChannelResponse({ context: context(), channel: "voice", content: "Resposta sanitizada" });

    assertChannelAllowed(policy, envelope);
    expect(envelope).toMatchObject({ channel: "voice", payloadKind: "voice", requestId: "channel-request-1", workspaceKey: "synthetic-operations", tenantId: "tenant:channels", actorId: 13 });
    expect(response).toEqual({ channel: "voice", requestId: "channel-request-1", workspaceKey: "synthetic-operations", tenantId: "tenant:channels", content: "Resposta sanitizada" });
  });

  it("recusa canal fora da allowlist e payload não autorizado", () => {
    const policy = createChannelPolicy({ allowedChannels: ["chat"], allowedPayloadKinds: ["text"] });
    const envelope = createChannelEnvelope({ context: context(), channel: "voice", payloadKind: "voice" });

    expect(() => assertChannelAllowed(policy, envelope)).toThrow("Canal não autorizado");
    expect(() => assertChannelAllowed(policy, { ...envelope, channel: "chat", payloadKind: "voice" })).toThrow("payload");
  });

  it("mantém policy READ-only incompatível com evento mutável", () => {
    const policy = createChannelPolicy({ allowedChannels: ["webhook"], allowedPayloadKinds: ["event"], readOnly: true });
    const envelope = createChannelEnvelope({ context: context(), channel: "webhook", payloadKind: "event" });

    expect(() => assertChannelAllowed(policy, envelope)).toThrow("READ-only");
  });

  it("rejeita policy desconhecida, identidade vazia e resposta vazia", () => {
    expect(() => createChannelPolicy({ allowedChannels: ["carrier-pigeon" as never] })).toThrow(ThanosChannelPolicyError);
    const policy = createChannelPolicy({ allowedChannels: ["chat"] });
    const envelope = createChannelEnvelope({ context: context(), channel: "chat", payloadKind: "text" });
    expect(() => assertChannelAllowed(policy, { ...envelope, requestId: "" })).toThrow("identidade");
    expect(() => createChannelResponse({ context: context(), channel: "chat", content: " " })).toThrow("conteúdo");
  });
});
