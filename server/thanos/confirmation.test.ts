import { describe, expect, it, vi } from "vitest";
import { createThanosContext } from "./context";
import { toDomain, toTenantId, toWorkspaceKey } from "./contextIdentity";
import {
  ThanosConfirmationEngine,
  ThanosConfirmationError,
  type ThanosConfirmationOperation,
  type ThanosConfirmationRecord,
  type ThanosConfirmationStore,
} from "./confirmation";
import type { ThanosConfirmationAuditPort } from "./confirmation";

function createContext(capabilities: readonly string[] = ["agent:write"], tenantId = "tenant:one") {
  return createThanosContext({
    workspaceKey: toWorkspaceKey("synthetic-operations"),
    tenantId: toTenantId(tenantId),
    domain: toDomain("synthetic-operations"),
    userId: 7,
    userName: "Confirmation Test",
    role: "reader",
    capabilities,
    channel: "chat",
    requestId: "confirmation-request-1",
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
    intent: "WRITE",
    requiredCapability: "agent:write",
    prepare: vi.fn(async (_context, input) => ({ label: input.label })),
    execute,
  };
}

describe("ThanosConfirmationEngine", () => {
  it("prepara e confirma uma operação WRITE uma única vez", async () => {
    const store = new MemoryStore();
    const events: Array<Record<string, unknown>> = [];
    const execute = vi.fn(async () => ({ created: true, result: { id: "write-1" } }));
    const operation = createOperation(execute);
    const engine = new ThanosConfirmationEngine(store, createAudit(events), () => "confirmation-1");

    const pending = await engine.prepare({ context: createContext(), operation, value: { label: "item" }, idempotencyKey: "idem-1", requestId: "prepare-1" });
    const confirmed = await engine.confirm({ context: createContext(), operation, confirmationId: pending.confirmationId, idempotencyKey: "idem-1", requestId: "confirm-1" });
    const duplicate = await engine.confirm({ context: createContext(), operation, confirmationId: pending.confirmationId, idempotencyKey: "idem-1", requestId: "confirm-retry" });

    expect(pending).toMatchObject({ confirmationId: "confirmation-1", idempotencyKey: "idem-1", operation: "synthetic.write", status: "pending" });
    expect(confirmed).toMatchObject({ confirmationId: "confirmation-1", idempotencyKey: "idem-1", status: "confirmed", result: { id: "write-1" } });
    expect(duplicate).toMatchObject({ confirmationId: "confirmation-1", idempotencyKey: "idem-1", status: "duplicate", requestId: "confirm-retry" });
    expect(execute).toHaveBeenCalledOnce();
    expect(events.map(event => event.result)).toEqual(["confirmation_pending", "write_executed", "confirmation_already_executed"]);
  });

  it("recusa prepare sem capability de escrita e não executa a operação", async () => {
    const store = new MemoryStore();
    const events: Array<Record<string, unknown>> = [];
    const operation = createOperation();

    await expect(new ThanosConfirmationEngine(store, createAudit(events), () => "confirmation-denied").prepare({
      context: createContext(["agent:read"]),
      operation,
      value: { label: "item" },
      idempotencyKey: "idem-denied",
      requestId: "prepare-denied",
    })).rejects.toThrow("Capability não autorizada");

    expect(operation.prepare).not.toHaveBeenCalled();
    expect(operation.execute).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ action: "thanos.confirm.denied", result: "capability_not_authorized" }));
  });

  it("recusa confirmação inexistente e confirmação de outro tenant", async () => {
    const store = new MemoryStore();
    const events: Array<Record<string, unknown>> = [];
    const operation = createOperation();
    const engine = new ThanosConfirmationEngine(store, createAudit(events), () => "confirmation-scope");
    const pending = await engine.prepare({ context: createContext(), operation, value: { label: "item" }, idempotencyKey: "idem-scope", requestId: "prepare-scope" });

    await expect(engine.confirm({ context: createContext(), operation, confirmationId: "other", idempotencyKey: "idem-scope", requestId: "confirm-not-found" })).rejects.toThrow(ThanosConfirmationError);
    await expect(engine.confirm({ context: createContext(["agent:write"], "tenant:two"), operation, confirmationId: pending.confirmationId, idempotencyKey: "idem-scope", requestId: "confirm-cross-tenant" })).rejects.toThrow("fora do escopo");
    expect(operation.execute).not.toHaveBeenCalled();
    expect(events.filter(event => event.result === "confirmation_not_found" || event.result === "confirmation_scope_mismatch")).toHaveLength(2);
  });

  it("deduplica confirmações concorrentes pelo mesmo idempotencyKey", async () => {
    const store = new MemoryStore();
    const events: Array<Record<string, unknown>> = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      await gate;
      return { created: true as const, result: { id: "concurrent-1" } };
    });
    const operation = createOperation(execute);
    const engine = new ThanosConfirmationEngine(store, createAudit(events), () => "confirmation-concurrent");
    const pending = await engine.prepare({ context: createContext(), operation, value: { label: "item" }, idempotencyKey: "idem-concurrent", requestId: "prepare-concurrent" });

    const first = engine.confirm({ context: createContext(), operation, confirmationId: pending.confirmationId, idempotencyKey: "idem-concurrent", requestId: "confirm-a" });
    const second = engine.confirm({ context: createContext(), operation, confirmationId: pending.confirmationId, idempotencyKey: "idem-concurrent", requestId: "confirm-b" });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    release();
    const [resultA, resultB] = await Promise.all([first, second]);

    expect(resultA).toMatchObject({ status: "confirmed", result: { id: "concurrent-1" } });
    expect(resultB).toEqual(resultA);
    expect(execute).toHaveBeenCalledOnce();
  });
});
