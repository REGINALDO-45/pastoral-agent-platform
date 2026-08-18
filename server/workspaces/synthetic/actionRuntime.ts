import {
  ThanosConfirmationEngine,
  type ThanosConfirmationAuditPort,
  type ThanosConfirmationRecord,
  type ThanosConfirmationStore,
} from "../../thanos/confirmation";
import { createChannelPolicy } from "../../thanos/channels";
import { ThanosConnectorRegistry, type ThanosConnectorAuditPort } from "../../thanos/connectorRegistry";
import {
  ThanosGovernedActionRuntime,
  ThanosActionOperationRegistry,
  type ThanosActionAuditPort,
  type ThanosActionRuntimeResult,
} from "../../thanos/governedActionRuntime";
import { SkillRegistry } from "../../thanos/skillRegistry";
import { WorkspaceRegistry } from "../../thanos/workspaceRegistry";
import {
  syntheticSkillDefinition,
  syntheticWriteSkillDefinition,
  syntheticWorkspaceDefinition,
  type SyntheticWorkspaceSource,
} from "./workspaceDefinition";
import { createSyntheticActionFixture, type SyntheticActionFixture } from "./actionTool";

export type SyntheticAuditEvent = Readonly<{
  action: string;
  status: string;
  operation?: string;
  connector?: string;
  requestId: string;
  originRequestId?: string;
  result: string;
  tenantId: string;
  workspaceKey: string;
  userId: number;
}>;

type SyntheticStoredRecord = ThanosConfirmationRecord<Record<string, string>>;

class SyntheticConfirmationStore implements ThanosConfirmationStore<Record<string, string>, never> {
  private readonly records = new Map<string, SyntheticStoredRecord>();

  async get(idempotencyKey: string): Promise<SyntheticStoredRecord | undefined> {
    return this.records.get(idempotencyKey);
  }

  async save(record: SyntheticStoredRecord): Promise<void> {
    if (this.records.has(record.idempotencyKey)) throw new Error("Confirmação sintética já existe.");
    this.records.set(record.idempotencyKey, record);
  }

  async update(record: SyntheticStoredRecord): Promise<void> {
    this.records.set(record.idempotencyKey, record);
  }
}

export type SyntheticActionRuntimeHarness = Readonly<{
  runtime: ThanosGovernedActionRuntime;
  fixture: SyntheticActionFixture;
  events: readonly SyntheticAuditEvent[];
  resolveContext(source: SyntheticWorkspaceSource): ReturnType<typeof syntheticWorkspaceDefinition.resolveContext>;
  getConfirmationRecord(idempotencyKey: string): Promise<SyntheticStoredRecord | undefined>;
}>;

export function createSyntheticActionRuntimeHarness(now: () => number = () => Date.now()): SyntheticActionRuntimeHarness {
  const events: SyntheticAuditEvent[] = [];
  const store = new SyntheticConfirmationStore();
  const fixture = createSyntheticActionFixture();
  const audit = {
    record: async (event: Readonly<Record<string, unknown>>): Promise<void> => {
      const context = event.context as { tenantId: string; workspaceKey: string; userId: number };
      events.push(Object.freeze({
        action: String(event.action ?? "unknown"),
        status: String(event.status ?? "unknown"),
        ...(event.operation === undefined ? {} : { operation: String(event.operation) }),
        ...(event.connector === undefined ? {} : { connector: String(event.connector) }),
        requestId: String(event.requestId ?? ""),
        ...(event.originRequestId === undefined ? {} : { originRequestId: String(event.originRequestId) }),
        result: String(event.result ?? ""),
        tenantId: context.tenantId,
        workspaceKey: context.workspaceKey,
        userId: context.userId,
      }));
    },
  } satisfies ThanosActionAuditPort & ThanosConfirmationAuditPort & ThanosConnectorAuditPort;

  const confirmationEngine = new ThanosConfirmationEngine<Record<string, string>, Record<string, string>, never>(store, audit, undefined, undefined, now);
  const channelPolicy = createChannelPolicy({ allowedChannels: ["chat"], allowedPayloadKinds: ["text"], readOnly: false });
  const connectorRegistry = new ThanosConnectorRegistry(
    ["listar_pendencias_sinteticas", "synthetic:item:create"],
    channelPolicy,
    audit,
    confirmationEngine,
  );
  connectorRegistry.register(fixture.readConnector);
  connectorRegistry.register(fixture.writeConnector);
  const operationRegistry = new ThanosActionOperationRegistry([
    {
      name: "synthetic:item:list",
      connectorKey: "listar_pendencias_sinteticas",
      intent: "READ",
      requiredCapability: "agent:read",
    },
    {
      name: "synthetic:item:create",
      connectorKey: "synthetic:item:create",
      intent: "WRITE",
      requiredCapability: "agent:write",
    },
  ], connectorRegistry);
  const workspaceRegistry = new WorkspaceRegistry<SyntheticWorkspaceSource>([syntheticWorkspaceDefinition]);
  const skillRegistry = new SkillRegistry([syntheticSkillDefinition, syntheticWriteSkillDefinition]);
  const runtime = new ThanosGovernedActionRuntime({
    workspaceRegistry,
    skillRegistry,
    operationRegistry,
    connectorRegistry,
    confirmationEngine,
    channelPolicy,
    audit,
  });

  return Object.freeze({
    runtime,
    fixture,
    events,
    resolveContext: source => syntheticWorkspaceDefinition.resolveContext(source),
    getConfirmationRecord: idempotencyKey => store.get(idempotencyKey),
  });
}
