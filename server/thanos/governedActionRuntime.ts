import { assertThanosCapability } from "./context";
import {
  assertChannelAllowed,
  createChannelEnvelope,
  type ThanosChannelKind,
  type ThanosChannelPayloadKind,
  type ThanosChannelPolicy,
} from "./channels";
import {
  fingerprintThanosPayload,
  type ThanosConfirmationEngine,
  type ThanosConfirmationGrant,
  type ThanosConfirmationOperation,
} from "./confirmation";
import type { ThanosCapability, ThanosContext, SkillDefinition } from "./contracts";
import {
  normalizeThanosEvidence,
  type ThanosEvidence,
} from "./evidence";
import {
  ThanosConnectorError,
  type ThanosConnectorRegistry,
} from "./connectorRegistry";
import { assertThanosActionIntent, type ThanosActionIntent, type ThanosActionIntentKind } from "./actionIntent";
import type { SkillRegistry } from "./skillRegistry";
import type { WorkspaceRegistry } from "./workspaceRegistry";
import type { ThanosWorkspaceSource } from "./defaultRegistries";

export type ThanosActionOperationDefinition = Readonly<{
  name: string;
  connectorKey: string;
  intent: ThanosActionIntentKind;
  requiredCapability: ThanosCapability;
}>;

export class ThanosActionOperationRegistry {
  private readonly operations: ReadonlyMap<string, ThanosActionOperationDefinition>;

  constructor(
    definitions: readonly ThanosActionOperationDefinition[],
    connectorRegistry: ThanosConnectorRegistry,
  ) {
    const manifests = new Map(connectorRegistry.list().map(manifest => [manifest.key, manifest]));
    const entries = new Map<string, ThanosActionOperationDefinition>();
    for (const definition of definitions) {
      if (!definition.name.trim() || !definition.connectorKey.trim()) {
        throw new ThanosActionRuntimeError("Operação exige name e connectorKey não vazios.");
      }
      if (entries.has(definition.name)) {
        throw new ThanosActionRuntimeError("Operação duplicada no registry de ações.");
      }
      const manifest = manifests.get(definition.connectorKey);
      if (!manifest) {
        throw new ThanosActionRuntimeError("Operação referencia connector fora do registry trusted.");
      }
      if (manifest.intent !== definition.intent || manifest.requiredCapability !== definition.requiredCapability) {
        throw new ThanosActionRuntimeError("Operação e manifest do connector possuem autoridade incompatível.");
      }
      entries.set(definition.name, Object.freeze({ ...definition }));
    }
    this.operations = entries;
  }

  get(operation: string): ThanosActionOperationDefinition {
    const definition = this.operations.get(operation);
    if (!definition) {
      throw new ThanosActionRuntimeError("Operação não registrada no runtime.");
    }
    return definition;
  }
}

export type ThanosActionAuditPort = Readonly<{
  record(event: Readonly<{
    context: ThanosContext;
    action:
      | "thanos.action.requested"
      | "thanos.action.confirmation_pending"
      | "thanos.action.confirmation_granted"
      | "thanos.action.read"
      | "thanos.action.write"
      | "thanos.action.denied"
      | "thanos.action.failed";
    status: "success" | "pending" | "denied" | "failure";
    operation: string;
    connector: string;
    requestId: string;
    originRequestId?: string;
    result: string;
  }>): Promise<void>;
}>;

export type ThanosActionRuntimeDependencies = Readonly<{
  workspaceRegistry: WorkspaceRegistry<ThanosWorkspaceSource>;
  skillRegistry: SkillRegistry;
  operationRegistry: ThanosActionOperationRegistry;
  connectorRegistry: ThanosConnectorRegistry;
  confirmationEngine: ThanosConfirmationEngine<Record<string, string>, Record<string, string>, never>;
  channelPolicy: ThanosChannelPolicy;
  audit: ThanosActionAuditPort;
}>;

export type ThanosActionRuntimeRequest = Readonly<{
  context: ThanosContext;
  intent: ThanosActionIntent;
  confirmation?: Readonly<{
    confirmationId: string;
    idempotencyKey: string;
  }>;
  grant?: ThanosConfirmationGrant;
}>;

export type ThanosActionRuntimeResult = Readonly<{
  state: "completed" | "confirmation_pending" | "confirmation_granted";
  requestId: string;
  operation: string;
  connector: string;
  confirmationStatus: "not_required" | "pending" | "confirmed";
  confirmationId?: string;
  idempotencyKey?: string;
  grant?: ThanosConfirmationGrant;
  evidence?: ThanosEvidence;
  content: string;
}>;

export class ThanosActionRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThanosActionRuntimeError";
  }
}

export class ThanosGovernedActionRuntime {
  constructor(private readonly dependencies: ThanosActionRuntimeDependencies) {}

  async run(input: ThanosActionRuntimeRequest): Promise<ThanosActionRuntimeResult> {
    const operation = await this.resolve(input);
    await this.recordRequested(input.context, operation);

    if (operation.intent === "READ") {
      if (input.confirmation !== undefined || input.grant !== undefined) {
        return this.deny(input.context, operation, "READ não aceita confirmação ou grant.");
      }
      return this.executeRead(input.context, input.intent, operation);
    }

    if (input.confirmation !== undefined && input.grant !== undefined) {
      return this.deny(input.context, operation, "WRITE não aceita confirmação e grant simultâneos.");
    }
    if (input.confirmation === undefined && input.grant === undefined) {
      return this.prepareWrite(input.context, input.intent, operation);
    }
    if (input.confirmation !== undefined) {
      return this.confirmWrite(input.context, input.intent, operation, input.confirmation);
    }
    return this.executeWrite(input.context, input.intent, operation, input.grant!);
  }

  private async resolve(input: ThanosActionRuntimeRequest): Promise<ThanosActionOperationDefinition> {
    try {
      assertThanosActionIntent(input.intent);
      if (input.intent.channel !== input.context.channel) {
        throw new ThanosActionRuntimeError("Canal da intenção não corresponde ao canal trusted do contexto.");
      }
      if (input.context.workspaceKey !== input.intent.workspaceKey) {
        throw new ThanosActionRuntimeError("Workspace da intenção não corresponde ao contexto trusted.");
      }
      const workspace = this.dependencies.workspaceRegistry.get(input.context.workspaceKey);
      if (workspace.domain !== input.context.domain) {
        throw new ThanosActionRuntimeError("Domínio do contexto não corresponde ao workspace trusted.");
      }
      const skill = this.dependencies.skillRegistry.getForWorkspace(input.context.workspaceKey, input.intent.skillKey);
      this.assertSkill(skill, input.context, input.intent);
      const operation = this.dependencies.operationRegistry.get(input.intent.operation);
      if (operation.intent !== input.intent.intent) {
        throw new ThanosActionRuntimeError("Intent incompatível com a operação registrada.");
      }
      if (operation.connectorKey !== input.intent.connectorKey) {
        throw new ThanosActionRuntimeError("Connector da intenção não corresponde à operação trusted.");
      }
      if (!skill.allowedTools.includes(operation.connectorKey)) {
        throw new ThanosActionRuntimeError("Connector não está na allowlist da skill.");
      }
      const envelope = createChannelEnvelope({
        context: input.context,
        channel: input.context.channel,
        payloadKind: input.intent.payloadKind,
      });
      assertChannelAllowed(this.dependencies.channelPolicy, envelope);
      if (operation.intent === "WRITE" && skill.readOnly) {
        throw new ThanosActionRuntimeError("Skill READ-only não pode solicitar WRITE.");
      }
      assertThanosCapability(input.context, operation.requiredCapability);
      return operation;
    } catch (error) {
      const operation = input.intent.operation.trim() || "unknown";
      const connector = input.intent.connectorKey.trim() || "unknown";
      await this.dependencies.audit.record({
        context: input.context,
        action: "thanos.action.denied",
        status: "denied",
        operation,
        connector,
        requestId: input.context.requestId,
        result: this.denialResult(error),
      });
      if (error instanceof ThanosActionRuntimeError) throw error;
      throw new ThanosActionRuntimeError(error instanceof Error ? error.message : "Ação negada pelo runtime.");
    }
  }

  private assertSkill(skill: SkillDefinition, context: ThanosContext, intent: ThanosActionIntent): void {
    if (!skill.allowedChannels.includes(context.channel as never)) {
      throw new ThanosActionRuntimeError("Canal não está na allowlist da skill.");
    }
    for (const capability of skill.requiredCapabilities) {
      assertThanosCapability(context, capability);
    }
    if (skill.domain !== context.domain) {
      throw new ThanosActionRuntimeError("Domínio da skill não corresponde ao contexto.");
    }
  }

  private async prepareWrite(
    context: ThanosContext,
    intent: ThanosActionIntent,
    operation: ThanosActionOperationDefinition,
  ): Promise<ThanosActionRuntimeResult> {
    if (!intent.idempotencyKey) {
      return this.deny(context, operation, "WRITE exige idempotencyKey antes da confirmação.");
    }
    const pending = await this.dependencies.confirmationEngine.prepare({
      context,
      operation: this.toConfirmationOperation(operation),
      value: Object.freeze({ ...intent.payload }),
      idempotencyKey: intent.idempotencyKey,
      requestId: context.requestId,
    });
    await this.dependencies.audit.record({
      context,
      action: "thanos.action.confirmation_pending",
      status: "pending",
      operation: operation.name,
      connector: operation.connectorKey,
      requestId: context.requestId,
      result: "confirmation_pending",
    });
    return Object.freeze({
      state: "confirmation_pending",
      requestId: context.requestId,
      operation: operation.name,
      connector: operation.connectorKey,
      confirmationStatus: "pending",
      confirmationId: pending.confirmationId,
      idempotencyKey: pending.idempotencyKey,
      content: "A ação está pronta. Confirma?",
    });
  }

  private async confirmWrite(
    context: ThanosContext,
    intent: ThanosActionIntent,
    operation: ThanosActionOperationDefinition,
    confirmation: Readonly<{ confirmationId: string; idempotencyKey: string }>,
  ): Promise<ThanosActionRuntimeResult> {
    try {
      const confirmed = await this.dependencies.confirmationEngine.confirm({
        context,
        operation: this.toConfirmationOperation(operation),
        confirmationId: confirmation.confirmationId,
        idempotencyKey: confirmation.idempotencyKey,
        requestId: context.requestId,
      });
      if (!confirmed.grant) {
        throw new ThanosActionRuntimeError("Confirmation Engine não produziu grant verificável.");
      }
      await this.dependencies.audit.record({
        context,
        action: "thanos.action.confirmation_granted",
        status: "success",
        operation: operation.name,
        connector: operation.connectorKey,
        requestId: context.requestId,
        originRequestId: confirmed.grant.originRequestId,
        result: confirmed.status === "duplicate" ? "confirmation_duplicate" : "confirmation_grant_issued",
      });
      return Object.freeze({
        state: "confirmation_granted",
        requestId: context.requestId,
        operation: operation.name,
        connector: operation.connectorKey,
        confirmationStatus: "confirmed",
        confirmationId: confirmed.confirmationId,
        idempotencyKey: confirmed.idempotencyKey,
        grant: confirmed.grant,
        content: "Confirmação registrada. A ação pode ser executada pelo fluxo trusted.",
      });
    } catch (error) {
      return this.deny(context, operation, this.denialResult(error));
    }
  }

  private async executeRead(
    context: ThanosContext,
    intent: ThanosActionIntent,
    operation: ThanosActionOperationDefinition,
  ): Promise<ThanosActionRuntimeResult> {
    try {
      const execution = await this.dependencies.connectorRegistry.execute({
        context,
        connectorKey: operation.connectorKey,
        requestId: context.requestId,
        operation: operation.name,
        channel: context.channel,
        payloadKind: intent.payloadKind,
        values: intent.payload,
      });
      const evidence = normalizeThanosEvidence(
        { summary: execution.evidence.summary, data: execution.evidence.data },
        context,
        { source: "connector", tool: operation.connectorKey },
      );
      await this.dependencies.audit.record({
        context,
        action: "thanos.action.read",
        status: "success",
        operation: operation.name,
        connector: operation.connectorKey,
        requestId: context.requestId,
        result: "read_completed",
      });
      return Object.freeze({
        state: "completed",
        requestId: context.requestId,
        operation: operation.name,
        connector: operation.connectorKey,
        confirmationStatus: "not_required",
        evidence,
        content: evidence.summary,
      });
    } catch (error) {
      return this.fail(context, operation, error);
    }
  }

  private async executeWrite(
    context: ThanosContext,
    intent: ThanosActionIntent,
    operation: ThanosActionOperationDefinition,
    grant: ThanosConfirmationGrant,
  ): Promise<ThanosActionRuntimeResult> {
    try {
      await this.dependencies.confirmationEngine.verifyGrant({
        context,
        operation: operation.name,
        connectorKey: operation.connectorKey,
        payloadFingerprint: fingerprintThanosPayload(intent.payload),
        grant,
        requestId: context.requestId,
      });
      const execution = await this.dependencies.connectorRegistry.execute({
        context,
        connectorKey: operation.connectorKey,
        requestId: context.requestId,
        operation: operation.name,
        channel: context.channel,
        payloadKind: intent.payloadKind,
        values: intent.payload,
        confirmationGrant: grant,
      });
      const evidence = normalizeThanosEvidence(
        { summary: execution.evidence.summary, data: execution.evidence.data },
        context,
        { source: "connector", tool: operation.connectorKey },
      );
      await this.dependencies.audit.record({
        context,
        action: "thanos.action.write",
        status: "success",
        operation: operation.name,
        connector: operation.connectorKey,
        requestId: context.requestId,
        originRequestId: grant.originRequestId,
        result: "write_completed",
      });
      return Object.freeze({
        state: "completed",
        requestId: context.requestId,
        operation: operation.name,
        connector: operation.connectorKey,
        confirmationStatus: "confirmed",
        grant,
        evidence,
        content: evidence.summary,
      });
    } catch (error) {
      return this.fail(context, operation, error, grant.originRequestId);
    }
  }

  private toConfirmationOperation(
    operation: ThanosActionOperationDefinition,
  ): ThanosConfirmationOperation<Record<string, string>, Record<string, string>, never> {
    return {
      name: operation.name,
      connectorKey: operation.connectorKey,
      intent: "WRITE",
      requiredCapability: operation.requiredCapability,
      fingerprint: fingerprintThanosPayload,
      prepare: async (_context, value) => Object.freeze({ ...value }),
      execute: async () => {
        throw new ThanosActionRuntimeError("WRITE deve executar pelo Connector Registry trusted.");
      },
    };
  }

  private async recordRequested(context: ThanosContext, operation: ThanosActionOperationDefinition): Promise<void> {
    await this.dependencies.audit.record({
      context,
      action: "thanos.action.requested",
      status: "success",
      operation: operation.name,
      connector: operation.connectorKey,
      requestId: context.requestId,
      result: operation.intent === "WRITE" ? "write_requested" : "read_requested",
    });
  }

  private async deny(
    context: ThanosContext,
    operation: ThanosActionOperationDefinition,
    reason: string,
  ): Promise<never> {
    await this.dependencies.audit.record({
      context,
      action: "thanos.action.denied",
      status: "denied",
      operation: operation.name,
      connector: operation.connectorKey,
      requestId: context.requestId,
      result: reason,
    });
    throw new ThanosActionRuntimeError(reason);
  }

  private async fail(
    context: ThanosContext,
    operation: ThanosActionOperationDefinition,
    error: unknown,
    originRequestId?: string,
  ): Promise<never> {
    await this.dependencies.audit.record({
      context,
      action: "thanos.action.failed",
      status: "failure",
      operation: operation.name,
      connector: operation.connectorKey,
      requestId: context.requestId,
      ...(originRequestId === undefined ? {} : { originRequestId }),
      result: "execution_failed",
    });
    if (error instanceof ThanosActionRuntimeError) throw error;
    if (error instanceof ThanosConnectorError) throw error;
    throw new ThanosActionRuntimeError(error instanceof Error ? error.message : "Execução falhou de forma segura.");
  }

  private denialResult(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message;
    return "action_denied";
  }
}
