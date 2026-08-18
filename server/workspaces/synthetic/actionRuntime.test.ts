import { describe, expect, it } from "vitest";
import { createThanosActionIntent } from "../../thanos/actionIntent";
import { createThanosContext } from "../../thanos/context";
import { toDomain, toTenantId, toWorkspaceKey } from "../../thanos/contextIdentity";
import { createSyntheticActionRuntimeHarness } from "./actionRuntime";
import { syntheticWorkspaceDefinition } from "./workspaceDefinition";

const tenantId = toTenantId("synthetic-tenant-a");
const workspaceKey = toWorkspaceKey("synthetic-operations");
const domain = toDomain("synthetic-operations");

function createIntent(input: Readonly<{
  operation: "synthetic:item:list" | "synthetic:item:create";
  intent: "READ" | "WRITE";
  connectorKey: "listar_pendencias_sinteticas" | "synthetic:item:create";
  payload: Readonly<Record<string, string>>;
  idempotencyKey?: string;
}>) {
  return createThanosActionIntent({
    workspaceKey,
    skillKey: input.intent === "READ" ? "synthetic-operations-readonly" : "synthetic-operations-governed-write",
    operation: input.operation,
    intent: input.intent,
    connectorKey: input.connectorKey,
    channel: "chat",
    payloadKind: "text",
    payload: input.payload,
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  });
}

function createContext(requestId: string, overrides: Readonly<{ userId?: number; tenantId?: string; workspaceKey?: string; capabilities?: readonly ("agent:read" | "agent:write")[]; conversationId?: number }> = {}) {
  return createThanosContext({
    workspaceKey: toWorkspaceKey(overrides.workspaceKey ?? workspaceKey),
    tenantId: toTenantId(overrides.tenantId ?? tenantId),
    domain,
    userId: overrides.userId ?? 42,
    userName: "Usuário Sintético",
    role: "operator",
    capabilities: overrides.capabilities ?? ["agent:read", "agent:write"],
    channel: "chat",
    conversationId: overrides.conversationId ?? 77,
    requestId,
  });
}

describe("ThanosGovernedActionRuntime no workspace sintético", () => {
  it("executa READ pelo mesmo runtime sem criar grant", async () => {
    const harness = createSyntheticActionRuntimeHarness();
    const result = await harness.runtime.run({
      context: createContext("runtime-read-1"),
      intent: createIntent({
        operation: "synthetic:item:list",
        intent: "READ",
        connectorKey: "listar_pendencias_sinteticas",
        payload: {},
      }),
    });

    expect(result).toMatchObject({
      state: "completed",
      confirmationStatus: "not_required",
      operation: "synthetic:item:list",
      connector: "listar_pendencias_sinteticas",
      requestId: "runtime-read-1",
    });
    expect(result.grant).toBeUndefined();
    expect(result.evidence?.provenance).toMatchObject({
      source: "connector",
      workspaceKey,
      tenantId,
      requestId: "runtime-read-1",
      tool: "listar_pendencias_sinteticas",
    });
    expect(harness.events).toContainEqual(expect.objectContaining({ action: "thanos.action.read", status: "success", result: "read_completed" }));
  });

  it("mantém WRITE pending até confirmação explícita e executa uma única vez com grant verificável", async () => {
    const harness = createSyntheticActionRuntimeHarness();
    const context = createContext("runtime-write-prepare");
    const intent = createIntent({
      operation: "synthetic:item:create",
      intent: "WRITE",
      connectorKey: "synthetic:item:create",
      payload: { label: "item governado" },
      idempotencyKey: "runtime-write-1",
    });

    const pending = await harness.runtime.run({ context, intent });
    expect(pending).toMatchObject({ state: "confirmation_pending", confirmationStatus: "pending", idempotencyKey: "runtime-write-1" });
    expect(pending.confirmationId).toBeTruthy();
    expect(pending.grant).toBeUndefined();
    expect(harness.fixture.getWriteExecutionCount()).toBe(0);

    const granted = await harness.runtime.run({
      context: createContext("runtime-write-confirm"),
      intent,
      confirmation: { confirmationId: pending.confirmationId!, idempotencyKey: pending.idempotencyKey! },
    });
    expect(granted).toMatchObject({ state: "confirmation_granted", confirmationStatus: "confirmed", operation: "synthetic:item:create" });
    expect(granted.grant).toMatchObject({
      confirmationId: pending.confirmationId,
      idempotencyKey: "runtime-write-1",
      operation: "synthetic:item:create",
      connectorKey: "synthetic:item:create",
      userId: 42,
      conversationId: 77,
      tenantId,
      workspaceKey,
      originRequestId: "runtime-write-prepare",
    });
    expect(granted.grant?.payloadFingerprint).toBeTruthy();
    expect(harness.fixture.getWriteExecutionCount()).toBe(0);

    const executed = await harness.runtime.run({
      context: createContext("runtime-write-execute"),
      intent,
      grant: granted.grant,
    });
    expect(executed).toMatchObject({ state: "completed", confirmationStatus: "confirmed" });
    expect(executed.evidence?.data).toMatchObject({ created: true, executionCount: 1 });
    expect(executed.evidence?.provenance).toMatchObject({
      source: "connector",
      workspaceKey,
      tenantId,
      requestId: "runtime-write-execute",
      tool: "synthetic:item:create",
    });
    expect(harness.fixture.getWriteExecutionCount()).toBe(1);
    expect(harness.events).toContainEqual(expect.objectContaining({ action: "thanos.action.confirmation_pending", status: "pending" }));
    expect(harness.events).toContainEqual(expect.objectContaining({ action: "thanos.action.confirmation_granted", status: "success", originRequestId: "runtime-write-prepare" }));
    expect(harness.events).toContainEqual(expect.objectContaining({ action: "thanos.action.write", status: "success", result: "write_completed" }));
  });

  it("nega auto-confirm, status textual e grant ausente", async () => {
    const harness = createSyntheticActionRuntimeHarness();
    const context = createContext("runtime-write-no-grant");
    const intent = createIntent({
      operation: "synthetic:item:create",
      intent: "WRITE",
      connectorKey: "synthetic:item:create",
      payload: { label: "não executar" },
      idempotencyKey: "runtime-write-no-grant",
    });

    const pending = await harness.runtime.run({ context, intent });
    await expect(harness.runtime.run({ context: createContext("runtime-write-fake-status"), intent, grant: undefined })).resolves.toMatchObject({ state: "confirmation_pending" });
    await expect(harness.runtime.run({
      context: createContext("runtime-write-fake-confirmation"),
      intent,
      confirmation: { confirmationId: "fake", idempotencyKey: "runtime-write-no-grant" },
    })).rejects.toThrow("Confirmação não encontrada");
    expect(pending.confirmationStatus).toBe("pending");
    expect(harness.fixture.getWriteExecutionCount()).toBe(0);
  });

  it("nega usuário, conversa, tenant, workspace, capability, skill, operação e connector incompatíveis", async () => {
    const harness = createSyntheticActionRuntimeHarness();
    const intent = createIntent({
      operation: "synthetic:item:create",
      intent: "WRITE",
      connectorKey: "synthetic:item:create",
      payload: { label: "não autorizado" },
      idempotencyKey: "runtime-negative-binding",
    });
    const pending = await harness.runtime.run({ context: createContext("runtime-negative-prepare"), intent });

    await expect(harness.runtime.run({
      context: createContext("runtime-negative-user", { userId: 99 }),
      intent,
      confirmation: { confirmationId: pending.confirmationId!, idempotencyKey: pending.idempotencyKey! },
    })).rejects.toThrow("outro usuário");

    await expect(harness.runtime.run({
      context: createContext("runtime-negative-conversation", { conversationId: 88 }),
      intent,
      confirmation: { confirmationId: pending.confirmationId!, idempotencyKey: pending.idempotencyKey! },
    })).rejects.toThrow("outra conversa");

    await expect(harness.runtime.run({
      context: createContext("runtime-negative-tenant", { tenantId: "synthetic-tenant-b" }),
      intent,
      confirmation: { confirmationId: pending.confirmationId!, idempotencyKey: pending.idempotencyKey! },
    })).rejects.toThrow("fora do escopo");

    await expect(harness.runtime.run({
      context: createContext("runtime-negative-workspace", { workspaceKey: "synthetic-other" }),
      intent,
      confirmation: { confirmationId: pending.confirmationId!, idempotencyKey: pending.idempotencyKey! },
    })).rejects.toThrow("Workspace da intenção");

    const noWriteContext = createContext("runtime-negative-capability", { capabilities: ["agent:read"] });
    await expect(harness.runtime.run({ context: noWriteContext, intent })).rejects.toThrow("Capability não autorizada");

    await expect(harness.runtime.run({
      context: createContext("runtime-negative-skill"),
      intent: createThanosActionIntent({ ...intent, skillKey: "synthetic-operations-readonly" }),
    })).rejects.toThrow("Connector não está na allowlist");

    await expect(harness.runtime.run({
      context: createContext("runtime-negative-operation"),
      intent: createThanosActionIntent({ ...intent, operation: "synthetic:item:unknown" }),
    })).rejects.toThrow("Operação não registrada");

    await expect(harness.runtime.run({
      context: createContext("runtime-negative-connector"),
      intent: createThanosActionIntent({ ...intent, connectorKey: "listar_pendencias_sinteticas" }),
    })).rejects.toThrow("Connector da intenção");
    expect(harness.fixture.getWriteExecutionCount()).toBe(0);
  });

  it("nega payload adulterado, grant forjado, replay e confirmação expirada", async () => {
    const harness = createSyntheticActionRuntimeHarness();
    const context = createContext("runtime-tamper-prepare");
    const intent = createIntent({
      operation: "synthetic:item:create",
      intent: "WRITE",
      connectorKey: "synthetic:item:create",
      payload: { label: "item original" },
      idempotencyKey: "runtime-tamper",
    });
    const pending = await harness.runtime.run({ context, intent });
    const granted = await harness.runtime.run({
      context: createContext("runtime-tamper-confirm"),
      intent,
      confirmation: { confirmationId: pending.confirmationId!, idempotencyKey: pending.idempotencyKey! },
    });

    await expect(harness.runtime.run({
      context: createContext("runtime-tamper-payload"),
      intent: createThanosActionIntent({ ...intent, payload: { label: "item adulterado" } }),
      grant: granted.grant,
    })).rejects.toThrow("operação, connector ou payload");

    await expect(harness.runtime.run({
      context: createContext("runtime-tamper-forged"),
      intent,
      grant: { ...granted.grant!, originRequestId: "forged-origin" },
    })).rejects.toThrow("operação, connector ou payload");

    await harness.runtime.run({ context: createContext("runtime-tamper-execute"), intent, grant: granted.grant });
    await expect(harness.runtime.run({ context: createContext("runtime-tamper-replay"), intent, grant: granted.grant })).rejects.toThrow("já foi consumido");
    expect(harness.fixture.getWriteExecutionCount()).toBe(1);

    let expiredNow = 1_000;
    const expiredHarness = createSyntheticActionRuntimeHarness(() => expiredNow);
    const expiredIntent = createIntent({
      operation: "synthetic:item:create",
      intent: "WRITE",
      connectorKey: "synthetic:item:create",
      payload: { label: "expirada" },
      idempotencyKey: "runtime-expired",
    });
    const expiredPending = await expiredHarness.runtime.run({ context: createContext("runtime-expired-prepare"), intent: expiredIntent });
    const expiredRecord = await expiredHarness.getConfirmationRecord(expiredPending.idempotencyKey!);
    expect(expiredRecord?.expiresAt).toBeGreaterThan(expiredRecord?.createdAt ?? 0);
    expiredNow = (expiredRecord?.expiresAt ?? 1_001);
    if (expiredRecord) {
      await expect(expiredHarness.runtime.run({
        context: createContext("runtime-expired-confirm"),
        intent: expiredIntent,
        confirmation: { confirmationId: expiredPending.confirmationId!, idempotencyKey: expiredPending.idempotencyKey! },
      })).rejects.toThrow("expirada");
    }
    expect(expiredHarness.fixture.getWriteExecutionCount()).toBe(0);
  });

  it("deduplica execuções concorrentes e não faz retry após falha do connector", async () => {
    const harness = createSyntheticActionRuntimeHarness();
    const intent = createIntent({
      operation: "synthetic:item:create",
      intent: "WRITE",
      connectorKey: "synthetic:item:create",
      payload: { label: "concorrente" },
      idempotencyKey: "runtime-concurrent",
    });
    const pending = await harness.runtime.run({ context: createContext("runtime-concurrent-prepare"), intent });
    const granted = await harness.runtime.run({
      context: createContext("runtime-concurrent-confirm"),
      intent,
      confirmation: { confirmationId: pending.confirmationId!, idempotencyKey: pending.idempotencyKey! },
    });

    const results = await Promise.allSettled([
      harness.runtime.run({ context: createContext("runtime-concurrent-a"), intent, grant: granted.grant }),
      harness.runtime.run({ context: createContext("runtime-concurrent-b"), intent, grant: granted.grant }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(harness.fixture.getWriteExecutionCount()).toBe(1);

    const failureHarness = createSyntheticActionRuntimeHarness();
    const failureIntent = createIntent({
      operation: "synthetic:item:create",
      intent: "WRITE",
      connectorKey: "synthetic:item:create",
      payload: { label: "falha" },
      idempotencyKey: "runtime-failure",
    });
    const failurePending = await failureHarness.runtime.run({ context: createContext("runtime-failure-prepare"), intent: failureIntent });
    const failureGranted = await failureHarness.runtime.run({
      context: createContext("runtime-failure-confirm"),
      intent: failureIntent,
      confirmation: { confirmationId: failurePending.confirmationId!, idempotencyKey: failurePending.idempotencyKey! },
    });
    failureHarness.fixture.setWriteFailure(true);
    await expect(failureHarness.runtime.run({ context: createContext("runtime-failure-execute"), intent: failureIntent, grant: failureGranted.grant })).rejects.toThrow("synthetic_write_failure");
    expect(failureHarness.fixture.getWriteExecutionCount()).toBe(0);
    await expect(failureHarness.runtime.run({ context: createContext("runtime-failure-retry"), intent: failureIntent, grant: failureGranted.grant })).rejects.toThrow("já foi consumido");
    expect(failureHarness.fixture.getWriteExecutionCount()).toBe(0);
  });

  it("não aceita campos de autoridade no Action Intent nem contexto de outro domínio", async () => {
    expect(() => createThanosActionIntent({
      workspaceKey,
      skillKey: "synthetic-operations-governed-write",
      operation: "synthetic:item:create",
      intent: "WRITE",
      connectorKey: "synthetic:item:create",
      channel: "chat",
      payloadKind: "text",
      payload: { label: "authority" },
      idempotencyKey: "runtime-authority",
      // @ts-expect-error autoridade não faz parte do contrato declarativo.
      capabilities: ["agent:write"],
    })).not.toThrow();

    const harness = createSyntheticActionRuntimeHarness();
    const foreignContext = createThanosContext({
      workspaceKey,
      tenantId,
      domain: toDomain("foreign-domain"),
      userId: 42,
      userName: "Usuário Sintético",
      role: "operator",
      capabilities: ["agent:read", "agent:write"],
      channel: "chat",
      conversationId: 77,
      requestId: "runtime-foreign-domain",
    });
    await expect(harness.runtime.run({
      context: foreignContext,
      intent: createIntent({ operation: "synthetic:item:list", intent: "READ", connectorKey: "listar_pendencias_sinteticas", payload: {} }),
    })).rejects.toThrow("Domínio do contexto");
  });
});
