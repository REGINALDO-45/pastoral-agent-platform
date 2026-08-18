import { assertThanosCapability } from "./context";
import type { ThanosCapability, ThanosContext } from "./contracts";
import { assertChannelAllowed, createChannelEnvelope, type ThanosChannelKind, type ThanosChannelPayloadKind, type ThanosChannelPolicy } from "./channels";
import { fingerprintThanosPayload, type ThanosConfirmationGrant, type ThanosConfirmationGrantPort } from "./confirmation";
import type { ThanosEvidence } from "./evidence";

export type ThanosConnectorIntent = "READ" | "WRITE";

export type ThanosConnectorManifest = Readonly<{
  key: string;
  displayName: string;
  intent: ThanosConnectorIntent;
  requiredCapability: ThanosCapability;
  allowedChannels: readonly ThanosChannelKind[];
  allowedPayloadKinds: readonly ThanosChannelPayloadKind[];
  enabled: boolean;
}>;

export type ThanosConnectorExecutionInput = Readonly<{
  context: ThanosContext;
  requestId: string;
  operation: string;
  channel: ThanosChannelKind;
  payloadKind: ThanosChannelPayloadKind;
  input: Readonly<Record<string, string>>;
}>;

export type ThanosConnectorExecutionResult = Readonly<{
  status: "success";
  evidence: ThanosEvidence;
}>;

export type ThanosConnector = Readonly<{
  manifest: ThanosConnectorManifest;
  execute(input: ThanosConnectorExecutionInput): Promise<ThanosConnectorExecutionResult>;
}>;

export type ThanosConnectorAuditPort = Readonly<{
  record(event: Readonly<{
    context: ThanosContext;
    action: "thanos.connector.execute" | "thanos.connector.denied" | "thanos.connector.failed";
    status: "success" | "denied" | "failure";
    connector: string;
    requestId: string;
    result: string;
  }>): Promise<void>;
}>;

export class ThanosConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThanosConnectorError";
  }
}

export class ThanosConnectorRegistry {
  private readonly connectors = new Map<string, ThanosConnector>();

  constructor(
    private readonly allowedConnectorKeys: readonly string[],
    private readonly channelPolicy: ThanosChannelPolicy,
    private readonly audit: ThanosConnectorAuditPort,
    private readonly trustedConfirmationGrantPort?: ThanosConfirmationGrantPort,
  ) {}

  register(connector: ThanosConnector): void {
    this.assertManifest(connector.manifest);
    if (!this.allowedConnectorKeys.includes(connector.manifest.key)) {
      throw new ThanosConnectorError("Connector não está na allowlist do registry.");
    }
    if (this.connectors.has(connector.manifest.key)) {
      throw new ThanosConnectorError("Connector já registrado no registry.");
    }
    this.connectors.set(connector.manifest.key, connector);
  }

  list(): readonly ThanosConnectorManifest[] {
    return Array.from(this.connectors.values()).map(connector => connector.manifest);
  }

  async execute(input: Readonly<{
    context: ThanosContext;
    connectorKey: string;
    requestId: string;
    operation: string;
    channel: ThanosChannelKind;
    payloadKind: ThanosChannelPayloadKind;
    values?: Readonly<Record<string, string>>;
    confirmationGrant?: ThanosConfirmationGrant;
  }>): Promise<ThanosConnectorExecutionResult> {
    const connector = this.connectors.get(input.connectorKey);
    if (!connector) {
      await this.recordDenied(input.context, input.connectorKey, input.requestId, "connector_not_registered");
      throw new ThanosConnectorError("Connector não registrado.");
    }
    if (input.requestId !== input.context.requestId) {
      await this.recordDenied(input.context, connector.manifest.key, input.requestId, "request_id_mismatch");
      throw new ThanosConnectorError("requestId do connector não corresponde ao contexto.");
    }
    if (!connector.manifest.enabled) {
      await this.recordDenied(input.context, connector.manifest.key, input.requestId, "connector_disabled");
      throw new ThanosConnectorError("Connector desabilitado.");
    }
    if (!connector.manifest.allowedChannels.includes(input.channel) || !connector.manifest.allowedPayloadKinds.includes(input.payloadKind)) {
      await this.recordDenied(input.context, connector.manifest.key, input.requestId, "connector_channel_not_allowed");
      throw new ThanosConnectorError("Canal ou payload não autorizado pelo connector.");
    }
    const envelope = createChannelEnvelope({ context: input.context, channel: input.channel, payloadKind: input.payloadKind });
    try {
      assertChannelAllowed(this.channelPolicy, envelope);
      assertThanosCapability(input.context, connector.manifest.requiredCapability);
    } catch (error) {
      await this.recordDenied(input.context, connector.manifest.key, input.requestId, "policy_or_capability_denied");
      throw error;
    }

    const values = Object.freeze({ ...(input.values ?? {}) });
    if (connector.manifest.intent === "WRITE") {
      if (!input.confirmationGrant) {
        await this.recordDenied(input.context, connector.manifest.key, input.requestId, "confirmation_grant_required");
        throw new ThanosConnectorError("Connector WRITE exige grant de confirmação verificável.");
      }
      if (!this.trustedConfirmationGrantPort) {
        await this.recordDenied(input.context, connector.manifest.key, input.requestId, "confirmation_authority_unavailable");
        throw new ThanosConnectorError("Connector WRITE está bloqueado: autoridade trusted de confirmação não configurada.");
      }
      try {
        await this.trustedConfirmationGrantPort.consumeGrant({
          context: input.context,
          operation: input.operation,
          connectorKey: connector.manifest.key,
          payloadFingerprint: fingerprintThanosPayload(values),
          grant: input.confirmationGrant,
          requestId: input.requestId,
        });
      } catch (error) {
        await this.recordDenied(input.context, connector.manifest.key, input.requestId, "confirmation_grant_denied");
        throw error;
      }
    }

    try {
      const result = await connector.execute({
        context: input.context,
        requestId: input.requestId,
        operation: input.operation,
        channel: input.channel,
        payloadKind: input.payloadKind,
        input: values,
      });
      await this.audit.record({
        context: input.context,
        action: "thanos.connector.execute",
        status: "success",
        connector: connector.manifest.key,
        requestId: input.requestId,
        result: "connector_executed",
      });
      return result;
    } catch (error) {
      await this.audit.record({
        context: input.context,
        action: "thanos.connector.failed",
        status: "failure",
        connector: connector.manifest.key,
        requestId: input.requestId,
        result: "connector_execution_failed",
      });
      throw error;
    }
  }

  private async recordDenied(context: ThanosContext, connector: string, requestId: string, result: string): Promise<void> {
    await this.audit.record({ context, action: "thanos.connector.denied", status: "denied", connector, requestId, result });
  }

  private assertManifest(manifest: ThanosConnectorManifest): void {
    if (!manifest.key.trim() || !manifest.displayName.trim()) {
      throw new ThanosConnectorError("Manifest do connector exige key e displayName.");
    }
    if (manifest.intent === "READ" && manifest.requiredCapability !== "connector:execute" && manifest.requiredCapability !== "agent:read") {
      throw new ThanosConnectorError("Connector READ exige capability de leitura ou execução de connector.");
    }
    if (manifest.intent === "WRITE" && manifest.requiredCapability !== "connector:execute" && manifest.requiredCapability !== "agent:write") {
      throw new ThanosConnectorError("Connector WRITE exige capability de escrita ou execução de connector.");
    }
    if (manifest.allowedChannels.length === 0 || manifest.allowedPayloadKinds.length === 0) {
      throw new ThanosConnectorError("Manifest do connector exige canais e payloads allowlisted.");
    }
  }
}
