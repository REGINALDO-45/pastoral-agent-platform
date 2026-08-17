import { describe, expect, it, vi } from "vitest";
import { createThanosContext } from "./context";
import { toDomain, toTenantId, toWorkspaceKey } from "./contextIdentity";
import {
  fingerprintThanosPayload,
  ThanosConfirmationEngine,
  ThanosConfirmationError,
  type ThanosConfirmationOperation,
  type ThanosConfirmationRecord,
  type ThanosConfirmationStore,
  type ThanosConfirmationAuditPort,
} from "./confirmation";

function createContext(input: Readonly<{
  capabilities?: readonly string[];
  tenantId?: string;
  workspaceKey?: string;
  userId?: number;
  conversationId?: number;
  requestId?: string;
}> = {}) {
  return createThanosContext({
    workspaceKey: toWorkspaceKey(input.workspaceKey ?? "synthetic-operations"),
    tenantId: toTenantId(input.tenantId ?? "tenant:one"),
    domain: toDomain("synthetic-operations"),
    userId: input.userId ?? 7,
    userName: "Confirmation Test",
    role: "reader",
    capabilities: input.capabilities ?? ["agent:write"],
    channel: "chat",
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    requestId: input.requestId ?? "confirmation-request-1",
  });
}

class MemoryStore implements ThanosConfirmationStore<{ label: string }, { id: string }> {
  records = new Map<string, ThanosConfirmationRecord<{ label: string }>>();

  async get(idempotencyKey: string) {
    return this.records.get(idempotencyKey);
  }

  async save(record: ThanosConfirmationRecord<{ label: string }>) {
    this.records.set(record.idempotencyKey, record);
  }

  async update(record: ThanosConfirmationRecord<{ label: string }>) {
    this.records.set(record.idempotencyKey, record);
  }
}

function createAudit(events: Array<Record<string, unknown>>): ThanosConfirmationAuditPort {
  return { record: async event => void events.push(event) };
}

function createOperation(execute = vi.fn(async () => ({ created: true, result: { id: "write-1" } }))): ThanosConfirmationOperation<{ label: string }, { label: string }, { id: string }> {
  return {
    name: "synthetic.write",
    connectorKey: "mock:write",
    intent: "WRITE",
    requiredCapability: "agent:write",
    fingerprint: fingerprintThanosPayload,
    prepare: vi.fn(async (_context, input) => ({ label: input.label })),
    execute,
  };
}

describe("ThanosConfirmationEngine", () => {
  it("emite grant verificável e executa uma operação WRITE uma única vez", async () => {
    const store = new MemoryStore();
    const events: Array<Record<string, unknown>> = [];
    const execute = vi.fn(async () => ({ created: true, result: { id: "write-1" } }));
    const operation = createOperation(execute);
    const engine = new ThanosConfirmationEngine(store, createAudit(events), () => "confirmation-1", () => "grant-1", () => 1_000, 5_000);
    const context = createContext({ conversationId: 42 });
    const value = { label: "item" };

    const pending = await engine.prepare({ context, operation, value, idempotencyKey: "idem-1", requestId: "prepare-1" });
    const confirmed = await engine.confirm({ context: createContext({ conversationId: 42, requestId: "confirm-1" }), operation, confirmationId: pending.confirmationId, idempotencyKey: "idem-1", requestId: "confirm-1" });
    const executed = await engine.executeWithGrant({ context: createContext({ conversationId: 42, requestId: "execute-1" }), operation, value, grant: confirmed.grant!, requestId: "execute-1" });

    expect(pending).toMatchObject({ confirmationId: "confirmation-1", idempotencyKey: "idem-1", operation: "synthetic.write", connectorKey: "mock:write", status: "pending", createdAt: 1_000, expiresAt: 6_000, payloadFingerprint: fingerprintThanosPayload(value) });
    expect(confirmed).toMatchObject({ confirmationId: "confirmation-1", idempotencyKey: "idem-1", status: "confirmed", grant: { grantId: "grant-1", operation: "synthetic.write", connectorKey: "mock:write", payloadFingerprint: fingerprintThanosPayload(value), userId: 7, conversationId: 42, tenantId: "tenant:one", workspaceKey: "synthetic-operations", issuedAt: 1_000, expiresAt: 6_000 } });
    expect(executed).toMatchObject({ status: "confirmed", grant: { grantId: "grant-1" } });
    expect(execute).toHaveBeenCalledOnce();
    expect(store.records.get("idem-1")?.grantConsumedAt).toBe(1_000);
    expect(events.map(event => event.result)).toEqual(["confirmation_pending", "confirmation_grant_issued", "confirmation_grant_consumed", "write_executed"]);
  });

  it("recusa prepare sem capability de escrita e não executa a operação", async () => {
    const store = new MemoryStore();
    const events: Array<Record<string, unknown>> = [];
    const operation = createOperation();

    await expect(new ThanosConfirmationEngine(store, createAudit(events), () => "confirmation-denied").prepare({
      context: createContext({ capabilities: ["agent:read"] }),
      operation,
      value: { label: "item" },
      idempotencyKey: "idem-denied",
      requestId: "prepare-denied",
    })).rejects.toThrow("Capability não autorizada");

    expect(operation.prepare).not.toHaveBeenCalled();
    expect(operation.execute).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ action: "thanos.confirm.denied", result: "capability_not_authorized" }));
  });

  it("recusa confirmação expirada e mantém o grant não executável", async () => {
    const store = new MemoryStore();
    const events: Array<Record<string, unknown>> = [];
    let now = 1_000;
    const operation = createOperation();
    const engine = new ThanosConfirmationEngine(store, createAudit(events), () => "confirmation-expired", () => "grant-expired", () => now, 100);
    const context = createContext({ conversationId: 42 });
    const pending = await engine.prepare({ context, operation, value: { label: "item" }, idempotencyKey: "idem-expired", requestId: "prepare-expired" });
    now = 1_100;

    await expect(engine.confirm({ context: createContext({ conversationId: 42 }), operation, confirmationId: pending.confirmationId, idempotencyKey: "idem-expired", requestId: "confirm-expired" })).rejects.toThrow("expirada");
    expect(store.records.get("idem-expired")?.grant).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({ result: "confirmation_expired" }));
  });

  it("recusa usuário diferente, conversa diferente, tenant diferente e workspace diferente", async () => {
    const store = new MemoryStore();
    const events: Array<Record<string, unknown>> = [];
    const operation = createOperation();
    const engine = new ThanosConfirmationEngine(store, createAudit(events), () => "confirmation-scope", () => "grant-scope", () => 1_000, 5_000);
    const context = createContext({ conversationId: 42 });
    const pending = await engine.prepare({ context, operation, value: { label: "item" }, idempotencyKey: "idem-scope", requestId: "prepare-scope" });

    await expect(engine.confirm({ context: createContext({ conversationId: 42, userId: 8 }), operation, confirmationId: pending.confirmationId, idempotencyKey: "idem-scope", requestId: "confirm-user" })).rejects.toThrow("outro usuário");
    await expect(engine.confirm({ context: createContext({ conversationId: 43 }), operation, confirmationId: pending.confirmationId, idempotencyKey: "idem-scope", requestId: "confirm-conversation" })).rejects.toThrow("outra conversa");
    await expect(engine.confirm({ context: createContext({ conversationId: 42, tenantId: "tenant:two" }), operation, confirmationId: pending.confirmationId, idempotencyKey: "idem-scope", requestId: "confirm-tenant" })).rejects.toThrow("fora do escopo");
    await expect(engine.confirm({ context: createContext({ conversationId: 42, workspaceKey: "other-workspace" }), operation, confirmationId: pending.confirmationId, idempotencyKey: "idem-scope", requestId: "confirm-workspace" })).rejects.toThrow("fora do escopo");
    expect(operation.execute).not.toHaveBeenCalled();
    expect(events.filter(event => String(event.result).includes("mismatch"))).toHaveLength(4);
  });

  it("recusa reuso da mesma idempotencyKey para outro payload e connector", async () => {
    const store = new MemoryStore();
    const operation = createOperation();
    const otherOperation = { ...operation, connectorKey: "mock:other", name: "other.write" };
    const engine = new ThanosConfirmationEngine(store, createAudit([]), () => "confirmation-binding", () => "grant-binding", () => 1_000, 5_000);
    const context = createContext({ conversationId: 42 });
    await engine.prepare({ context, operation, value: { label: "item-a" }, idempotencyKey: "idem-binding", requestId: "prepare-binding" });

    await expect(engine.prepare({ context, operation, value: { label: "item-b" }, idempotencyKey: "idem-binding", requestId: "prepare-binding-2" })).rejects.toThrow("payload");
    await expect(engine.prepare({ context, operation: otherOperation, value: { label: "item-a" }, idempotencyKey: "idem-binding", requestId: "prepare-binding-3" })).rejects.toThrow("operação");
  });

  it("impede grant adulterado e replay após consumo", async () => {
    const store = new MemoryStore();
    const events: Array<Record<string, unknown>> = [];
    const execute = vi.fn(async () => ({ created: true, result: { id: "write-replay" } }));
    const operation = createOperation(execute);
    const engine = new ThanosConfirmationEngine(store, createAudit(events), () => "confirmation-replay", () => "grant-replay", () => 1_000, 5_000);
    const context = createContext({ conversationId: 42 });
    const value = { label: "item" };
    const pending = await engine.prepare({ context, operation, value, idempotencyKey: "idem-replay", requestId: "prepare-replay" });
    const confirmed = await engine.confirm({ context, operation, confirmationId: pending.confirmationId, idempotencyKey: "idem-replay", requestId: "confirm-replay" });

    await expect(engine.consumeGrant({ context, operation: operation.name, connectorKey: "mock:other", payloadFingerprint: confirmed.grant!.payloadFingerprint, grant: confirmed.grant!, requestId: "consume-wrong-connector" })).rejects.toThrow("operação, connector ou payload");
    await expect(engine.consumeGrant({ context, operation: operation.name, connectorKey: operation.connectorKey, payloadFingerprint: fingerprintThanosPayload({ label: "tampered" }), grant: confirmed.grant!, requestId: "consume-wrong-payload" })).rejects.toThrow("operação, connector ou payload");

    await engine.executeWithGrant({ context, operation, value, grant: confirmed.grant!, requestId: "execute-replay-1" });
    await expect(engine.executeWithGrant({ context, operation, value, grant: confirmed.grant!, requestId: "execute-replay-2" })).rejects.toThrow("já foi consumido");
    expect(execute).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ action: "thanos.confirm.replay_denied", result: "confirmation_grant_replayed" }));
  });

  it("deduplica confirmações concorrentes por identidade e idempotencyKey", async () => {
    const store = new MemoryStore();
    const events: Array<Record<string, unknown>> = [];
    const operation = createOperation();
    const engine = new ThanosConfirmationEngine(store, createAudit(events), () => "confirmation-concurrent", () => "grant-concurrent", () => 1_000, 5_000);
    const context = createContext({ conversationId: 42 });
    const pending = await engine.prepare({ context, operation, value: { label: "item" }, idempotencyKey: "idem-concurrent", requestId: "prepare-concurrent" });

    const first = engine.confirm({ context, operation, confirmationId: pending.confirmationId, idempotencyKey: "idem-concurrent", requestId: "confirm-a" });
    const second = engine.confirm({ context, operation, confirmationId: pending.confirmationId, idempotencyKey: "idem-concurrent", requestId: "confirm-b" });
    const [resultA, resultB] = await Promise.all([first, second]);

    expect(resultA).toEqual(resultB);
    expect(resultA.grant).toMatchObject({ grantId: "grant-concurrent" });
  });
});
