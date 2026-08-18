import type { ThanosChannel, ThanosContext } from "./contracts";

export type ThanosChannelKind = ThanosChannel | "webhook" | "email" | "whatsapp" | "slack";
export type ThanosChannelPayloadKind = "text" | "voice" | "event";
/** Transporte de ingressão; não substitui o channel de ação trusted do contexto. */
export type ThanosTransport = "web" | "telegram";
/** Modalidade de payload recebida pelo transporte. */
export type ThanosModality = ThanosChannelPayloadKind;

export type ThanosChannelEnvelope = Readonly<{
  channel: ThanosChannelKind;
  payloadKind: ThanosChannelPayloadKind;
  requestId: string;
  workspaceKey: string;
  tenantId: string;
  actorId?: number;
  content?: string;
  metadata?: Readonly<Record<string, string>>;
}>;

export type ThanosChannelResponse = Readonly<{
  channel: ThanosChannelKind;
  requestId: string;
  workspaceKey: string;
  tenantId: string;
  content: string;
  confirmationStatus?: "not_required" | "pending" | "confirmed" | "duplicate" | "denied" | "failed";
}>;

export type ThanosChannelPolicy = Readonly<{
  allowedChannels: readonly ThanosChannelKind[];
  allowedPayloadKinds: readonly ThanosChannelPayloadKind[];
  readOnly: boolean;
}>;

export class ThanosChannelPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThanosChannelPolicyError";
  }
}

const knownChannels = new Set<ThanosChannelKind>(["chat", "voice", "webhook", "email", "whatsapp", "slack"]);
const knownPayloadKinds = new Set<ThanosChannelPayloadKind>(["text", "voice", "event"]);

export function createChannelPolicy(input: Readonly<{
  allowedChannels: readonly ThanosChannelKind[];
  allowedPayloadKinds?: readonly ThanosChannelPayloadKind[];
  readOnly?: boolean;
}>): ThanosChannelPolicy {
  const allowedPayloadKinds = input.allowedPayloadKinds ?? ["text", "voice", "event"];
  if (input.allowedChannels.length === 0 || input.allowedChannels.some(channel => !knownChannels.has(channel))) {
    throw new ThanosChannelPolicyError("Policy de canal exige allowlist não vazia e conhecida.");
  }
  if (allowedPayloadKinds.length === 0 || allowedPayloadKinds.some(kind => !knownPayloadKinds.has(kind))) {
    throw new ThanosChannelPolicyError("Policy de canal exige payloads conhecidos.");
  }
  return Object.freeze({
    allowedChannels: Object.freeze(input.allowedChannels.filter((channel, index, values) => values.indexOf(channel) === index)),
    allowedPayloadKinds: Object.freeze(allowedPayloadKinds.filter((kind, index, values) => values.indexOf(kind) === index)),
    readOnly: input.readOnly ?? true,
  });
}

export function assertChannelAllowed(policy: ThanosChannelPolicy, envelope: ThanosChannelEnvelope): void {
  if (!policy.allowedChannels.includes(envelope.channel)) {
    throw new ThanosChannelPolicyError("Canal não autorizado pela policy do workspace.");
  }
  if (!policy.allowedPayloadKinds.includes(envelope.payloadKind)) {
    throw new ThanosChannelPolicyError("Tipo de payload não autorizado pela policy do canal.");
  }
  if (!envelope.requestId.trim() || !envelope.workspaceKey.trim() || !envelope.tenantId.trim()) {
    throw new ThanosChannelPolicyError("Envelope de canal exige requestId e identidade completa.");
  }
  if (policy.readOnly && envelope.payloadKind === "event") {
    throw new ThanosChannelPolicyError("Policy READ-only não aceita eventos mutáveis.");
  }
}

export function createChannelEnvelope(input: Readonly<{
  context: ThanosContext;
  channel: ThanosChannelKind;
  payloadKind: ThanosChannelPayloadKind;
  content?: string;
  metadata?: Readonly<Record<string, string>>;
}>): ThanosChannelEnvelope {
  return Object.freeze({
    channel: input.channel,
    payloadKind: input.payloadKind,
    requestId: input.context.requestId,
    workspaceKey: input.context.workspaceKey,
    tenantId: input.context.tenantId,
    actorId: input.context.userId,
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.metadata === undefined ? {} : { metadata: Object.freeze({ ...input.metadata }) }),
  });
}

export function createChannelResponse(input: Readonly<{
  context: ThanosContext;
  channel: ThanosChannelKind;
  content: string;
  confirmationStatus?: ThanosChannelResponse["confirmationStatus"];
}>): ThanosChannelResponse {
  if (!input.content.trim()) {
    throw new ThanosChannelPolicyError("Resposta de canal exige conteúdo não vazio.");
  }
  return Object.freeze({
    channel: input.channel,
    requestId: input.context.requestId,
    workspaceKey: input.context.workspaceKey,
    tenantId: input.context.tenantId,
    content: input.content,
    ...(input.confirmationStatus === undefined ? {} : { confirmationStatus: input.confirmationStatus }),
  });
}
