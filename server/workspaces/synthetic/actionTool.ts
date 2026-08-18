import type { ThanosConnector, ThanosConnectorExecutionResult } from "../../thanos/connectorRegistry";
import type { ThanosContext } from "../../thanos/contracts";

export type SyntheticActionItem = Readonly<{
  id: string;
  label: string;
}>;

export type SyntheticActionFixture = Readonly<{
  readConnector: ThanosConnector;
  writeConnector: ThanosConnector;
  getItems(): readonly SyntheticActionItem[];
  getWriteExecutionCount(): number;
  setWriteFailure(shouldFail: boolean): void;
}>;

export function createSyntheticActionFixture(): SyntheticActionFixture {
  const items: SyntheticActionItem[] = [{ id: "synthetic-seed-1", label: "Pendência sintética inicial" }];
  let writeExecutionCount = 0;
  let writeFailure = false;
  let nextId = 1;

  const readConnector: ThanosConnector = Object.freeze({
    manifest: Object.freeze({
      key: "listar_pendencias_sinteticas",
      displayName: "Lista sintética de itens",
      intent: "READ" as const,
      requiredCapability: "agent:read" as const,
      allowedChannels: Object.freeze(["chat"] as const),
      allowedPayloadKinds: Object.freeze(["text"] as const),
      enabled: true,
    }),
    async execute(input): Promise<ThanosConnectorExecutionResult> {
      return {
        status: "success",
        evidence: {
          summary: `A consulta sintética encontrou ${items.length} item(ns).`,
          data: Object.freeze({
            count: items.length,
            items: Object.freeze(items.map(item => Object.freeze({ ...item }))),
            workspaceKey: input.context.workspaceKey,
            tenantId: input.context.tenantId,
          }),
        },
      };
    },
  });

  const writeConnector: ThanosConnector = Object.freeze({
    manifest: Object.freeze({
      key: "synthetic:item:create",
      displayName: "Criação sintética de item",
      intent: "WRITE" as const,
      requiredCapability: "agent:write" as const,
      allowedChannels: Object.freeze(["chat"] as const),
      allowedPayloadKinds: Object.freeze(["text"] as const),
      enabled: true,
    }),
    async execute(input): Promise<ThanosConnectorExecutionResult> {
      if (writeFailure) throw new Error("synthetic_write_failure");
      const label = input.input.label?.trim();
      if (!label) throw new Error("Item sintético exige label não vazio.");
      writeExecutionCount += 1;
      const item = Object.freeze({ id: `synthetic-created-${nextId++}`, label });
      items.push(item);
      return {
        status: "success",
        evidence: {
          summary: `O item sintético ${item.id} foi criado.`,
          data: Object.freeze({
            created: true,
            item,
            executionCount: writeExecutionCount,
            workspaceKey: input.context.workspaceKey,
            tenantId: input.context.tenantId,
          }),
        },
      };
    },
  });

  return Object.freeze({
    readConnector,
    writeConnector,
    getItems: () => Object.freeze(items.map(item => Object.freeze({ ...item }))),
    getWriteExecutionCount: () => writeExecutionCount,
    setWriteFailure: (shouldFail: boolean) => {
      writeFailure = shouldFail;
    },
  });
}

export function createSyntheticActionContextSummary(context: ThanosContext): Readonly<{ workspaceKey: string; tenantId: string; userId: number }> {
  return Object.freeze({ workspaceKey: context.workspaceKey, tenantId: context.tenantId, userId: context.userId });
}
