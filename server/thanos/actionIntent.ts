import type { ThanosChannelKind, ThanosChannelPayloadKind } from "./channels";

export type ThanosActionIntentKind = "READ" | "WRITE";

/**
 * Pedido declarativo de ação. Identidade e autoridade nunca fazem parte deste contrato.
 * Elas são obtidas exclusivamente do ThanosContext e dos catálogos server-side.
 */
export type ThanosActionIntent = Readonly<{
  workspaceKey: string;
  skillKey: string;
  operation: string;
  intent: ThanosActionIntentKind;
  connectorKey: string;
  channel: ThanosChannelKind;
  payloadKind: ThanosChannelPayloadKind;
  payload: Readonly<Record<string, string>>;
  idempotencyKey?: string;
}>;

export class ThanosActionIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThanosActionIntentError";
  }
}

export function createThanosActionIntent(input: ThanosActionIntent): ThanosActionIntent {
  assertThanosActionIntent(input);
  return Object.freeze({
    ...input,
    payload: Object.freeze({ ...input.payload }),
  });
}

export function assertThanosActionIntent(intent: ThanosActionIntent): void {
  for (const [field, value] of Object.entries({
    workspaceKey: intent.workspaceKey,
    skillKey: intent.skillKey,
    operation: intent.operation,
    connectorKey: intent.connectorKey,
    channel: intent.channel,
    payloadKind: intent.payloadKind,
  })) {
    if (typeof value !== "string" || !value.trim()) {
      throw new ThanosActionIntentError(`Action Intent exige ${field} não vazio.`);
    }
  }
  if (intent.intent !== "READ" && intent.intent !== "WRITE") {
    throw new ThanosActionIntentError("Action Intent exige intent READ ou WRITE.");
  }
  if (intent.payload === null || typeof intent.payload !== "object" || Array.isArray(intent.payload)) {
    throw new ThanosActionIntentError("Action Intent exige payload em mapa de strings.");
  }
  for (const [key, value] of Object.entries(intent.payload)) {
    if (!key.trim() || typeof value !== "string") {
      throw new ThanosActionIntentError("Payload de Action Intent aceita somente chaves e valores string.");
    }
  }
  if (intent.intent === "WRITE" && intent.idempotencyKey !== undefined && !intent.idempotencyKey.trim()) {
    throw new ThanosActionIntentError("idempotencyKey de WRITE não pode ser vazio.");
  }
}
