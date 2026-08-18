import { randomUUID } from "node:crypto";
import type { ThanosModality, ThanosTransport } from "../thanos/channels";
import type { ThanosContext } from "../thanos/contracts";
import { ThanosReadOrchestrator, type ThanosGeneratorPort } from "../thanos/orchestrator";
import { createPastoralDeclaredReadToolAdapter } from "../workspaces/pastoral/pastoralToolAdapter";
import {
  pastoralSkillDefinition,
  pastoralWorkspaceDefinition,
} from "../workspaces/pastoral/workspaceDefinition";
import { pastoralToolCatalog } from "./toolCatalog";
import type { PastoralRepository, ReadPastoralToolName, TenantContext, ToolCatalogEntry } from "./types";

export const TELEGRAM_TRANSPORT = "telegram" as const;
export const TELEGRAM_MODALITY = "text" as const;
export const TELEGRAM_READ_TOOL = "consultar_celulas" as const;
export const TELEGRAM_READ_MODEL = "telegram-read-sandbox-v1";
export const TELEGRAM_GENERIC_DENIAL = "A mensagem não pôde ser processada por esta integração.";
export const TELEGRAM_POLICY = Object.freeze({
  transport: TELEGRAM_TRANSPORT,
  modality: TELEGRAM_MODALITY,
  intent: "READ" as const,
  allowedTools: Object.freeze([TELEGRAM_READ_TOOL]),
  writeEnabled: false as const,
  sensitiveEnabled: false as const,
  publicIngress: false as const,
});

const MAX_TELEGRAM_TEXT_LENGTH = 4096;
const FORBIDDEN_AUTHORITY_KEYS = new Set([
  "tenantId",
  "workspaceKey",
  "domain",
  "role",
  "capabilities",
  "platformRole",
  "platformCapabilities",
  "userId",
  "organizationId",
  "channel",
  "requestId",
  "claimedTenantId",
  "claimedWorkspaceKey",
  "claimedDomain",
  "claimedRole",
  "claimedCapabilities",
  "claimedPlatformRole",
  "claimedPlatformCapabilities",
]);

type TelegramLinkState = "linked" | "unlinked" | "disabled";

export type TelegramInboundInput = Readonly<{
  transport: ThanosTransport;
  modality: ThanosModality;
  telegramUserId: string;
  telegramChatId: string;
  text: string;
  blockId?: string;
  tenantId?: string;
  workspaceKey?: string;
  domain?: string;
  role?: string;
  capabilities?: readonly string[];
  platformRole?: string;
  platformCapabilities?: readonly string[];
  claimedTenantId?: string;
  claimedWorkspaceKey?: string;
  claimedDomain?: string;
  claimedRole?: string;
  claimedCapabilities?: readonly string[];
  claimedPlatformRole?: string;
  claimedPlatformCapabilities?: readonly string[];
  requestId?: string;
}>;

export type TelegramLinkedIdentity = Readonly<{
  telegramUserId: string;
  telegramChatId: string;
  tenantContext: TenantContext;
  conversationId: number;
}>;

export type TelegramIdentityResolution = Readonly<
  | { status: "linked"; identity: TelegramLinkedIdentity }
  | { status: "unlinked"; reason: "identity_not_linked" }
  | { status: "disabled"; reason: "integration_disabled" }
>;

export type TelegramIdentityResolver = Readonly<{
  resolve(input: Readonly<{ telegramUserId: string; telegramChatId: string }>): Promise<TelegramIdentityResolution>;
}>;

export type TelegramAuditEvent = Readonly<{
  action: "telegram.ingress.accepted" | "telegram.ingress.denied" | "telegram.read.completed" | "telegram.read.failed";
  status: "success" | "denied" | "failure";
  requestId: string;
  transport: typeof TELEGRAM_TRANSPORT;
  modality: typeof TELEGRAM_MODALITY;
  result: string;
  reason?: string;
  context?: ThanosContext;
  metadata?: Readonly<Record<string, string>>;
}>;

export type TelegramAuditPort = Readonly<{
  record(event: TelegramAuditEvent): Promise<void>;
}>;

export type TelegramAdapterResult = Readonly<{
  status: "completed" | "denied" | "duplicate";
  requestId: string;
  transport: typeof TELEGRAM_TRANSPORT;
  modality: typeof TELEGRAM_MODALITY;
  content: string;
  tool?: typeof TELEGRAM_READ_TOOL;
  provider?: "deterministic";
  model?: typeof TELEGRAM_READ_MODEL;
  reason?: string;
}>;

export class TelegramIngressDeniedError extends Error {
  constructor(public readonly reason: string) {
    super("Ingress Telegram negado.");
    this.name = "TelegramIngressDeniedError";
  }
}

export class InMemoryTelegramIdentityResolver implements TelegramIdentityResolver {
  private readonly records = new Map<string, TelegramIdentityResolution>();

  constructor(records: readonly TelegramLinkedIdentity[] = [], private readonly enabled = true) {
    for (const record of records) this.link(record);
  }

  link(identity: TelegramLinkedIdentity): void {
    this.records.set(telegramIdentityKey(identity.telegramUserId, identity.telegramChatId), Object.freeze({ status: "linked", identity }));
  }

  unlink(input: Readonly<{ telegramUserId: string; telegramChatId: string }>): void {
    this.records.delete(telegramIdentityKey(input.telegramUserId, input.telegramChatId));
  }

  async resolve(input: Readonly<{ telegramUserId: string; telegramChatId: string }>): Promise<TelegramIdentityResolution> {
    if (!this.enabled) return Object.freeze({ status: "disabled" as const, reason: "integration_disabled" as const });
    return this.records.get(telegramIdentityKey(input.telegramUserId, input.telegramChatId)) ?? Object.freeze({ status: "unlinked" as const, reason: "identity_not_linked" as const });
  }
}

function telegramIdentityKey(telegramUserId: string, telegramChatId: string): string {
  const user = normalizeExternalId(telegramUserId, "telegramUserId");
  const chat = normalizeExternalId(telegramChatId, "telegramChatId");
  return `${user}:${chat}`;
}

function normalizeExternalId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TelegramIngressDeniedError(`${label}_missing`);
  if (normalized.length > 128) throw new TelegramIngressDeniedError(`${label}_too_long`);
  return normalized;
}

function forbiddenAuthorityKey(input: TelegramInboundInput): string | undefined {
  for (const key of Array.from(FORBIDDEN_AUTHORITY_KEYS)) {
    if (Object.prototype.hasOwnProperty.call(input, key) && (input as Record<string, unknown>)[key] !== undefined) return key;
  }
  return undefined;
}

function validateTelegramInput(input: TelegramInboundInput): void {
  if (input.transport !== TELEGRAM_POLICY.transport) throw new TelegramIngressDeniedError("transport_not_allowed");
  if (input.modality !== TELEGRAM_POLICY.modality) throw new TelegramIngressDeniedError("modality_not_allowed");
  const forgedKey = forbiddenAuthorityKey(input);
  if (forgedKey) throw new TelegramIngressDeniedError(`untrusted_authority_field:${forgedKey}`);
  normalizeExternalId(input.telegramUserId, "telegramUserId");
  normalizeExternalId(input.telegramChatId, "telegramChatId");
  if (input.blockId !== undefined) normalizeExternalId(input.blockId, "blockId");
  if (!input.text.trim()) throw new TelegramIngressDeniedError("text_empty");
  if (input.text.length > MAX_TELEGRAM_TEXT_LENGTH) throw new TelegramIngressDeniedError("text_too_long");
}

function createDeterministicGenerator(): ThanosGeneratorPort {
  return Object.freeze({
    generate: async (input) => Object.freeze({
      content: input.fallback,
      provider: "deterministic",
      model: TELEGRAM_READ_MODEL,
    }),
  });
}

function mapReadAuditEvent(event: Readonly<{
  context: ThanosContext;
  action: "thanos.read" | "thanos.read.denied" | "thanos.read.failed" | "thanos.read.step" | "thanos.read.step.failed";
  status: "success" | "denied" | "failure";
  result: string;
  tool: string;
  provider?: string;
  model?: string;
}>): TelegramAuditEvent {
  const action = event.action === "thanos.read" ? "telegram.read.completed" : event.status === "denied" ? "telegram.ingress.denied" : "telegram.read.failed";
  return Object.freeze({
    action,
    status: event.status,
    requestId: event.context.requestId,
    transport: TELEGRAM_TRANSPORT,
    modality: TELEGRAM_MODALITY,
    result: event.result,
    context: event.context,
    metadata: Object.freeze({
      tool: event.tool,
      ...(event.provider === undefined ? {} : { provider: event.provider }),
      ...(event.model === undefined ? {} : { model: event.model }),
    }),
  });
}

export class TelegramChannelAdapter {
  private readonly readOrchestrator: ThanosReadOrchestrator;
  private readonly generator = createDeterministicGenerator();
  private readonly processedBlocks = new Map<string, TelegramAdapterResult>();

  constructor(
    private readonly input: Readonly<{
      repository: PastoralRepository;
      identityResolver: TelegramIdentityResolver;
      audit: TelegramAuditPort;
      toolCatalog?: readonly ToolCatalogEntry[];
      readTool?: ReadPastoralToolName;
      requestIdFactory?: () => string;
    }>,
  ) {
    this.readOrchestrator = new ThanosReadOrchestrator({
      record: async event => this.input.audit.record(mapReadAuditEvent(event)),
    });
  }

  async handle(input: TelegramInboundInput): Promise<TelegramAdapterResult> {
    const requestId = this.input.requestIdFactory?.() ?? randomUUID();
    try {
      validateTelegramInput(input);
    } catch (error) {
      const reason = error instanceof TelegramIngressDeniedError ? error.reason : "invalid_ingress";
      await this.recordDenied(requestId, reason);
      return this.denied(requestId, reason);
    }

    const blockId = input.blockId?.trim();
    if (blockId) {
      const previous = this.processedBlocks.get(blockId);
      if (previous) {
        return Object.freeze({ ...previous, status: "duplicate" as const, reason: "duplicate_block_id" });
      }
    }

    const resolution = await this.input.identityResolver.resolve({ telegramUserId: input.telegramUserId, telegramChatId: input.telegramChatId });
    if (resolution.status !== "linked") {
      await this.recordDenied(requestId, resolution.reason);
      return this.denied(requestId, resolution.reason);
    }

    const thanosContext = pastoralWorkspaceDefinition.resolveContext({
      tenantContext: resolution.identity.tenantContext,
      channel: "chat",
      conversationId: resolution.identity.conversationId,
      serverRequestId: requestId,
    });
    const tool = this.input.readTool ?? TELEGRAM_READ_TOOL;
    const pastoralTool = createPastoralDeclaredReadToolAdapter({
      repository: this.input.repository,
      tenantContext: resolution.identity.tenantContext,
      thanosContext,
      skill: pastoralSkillDefinition,
      toolCatalog: this.input.toolCatalog ?? pastoralToolCatalog,
      tool,
    });

    await this.input.audit.record(Object.freeze({
      action: "telegram.ingress.accepted",
      status: "success",
      requestId,
      transport: TELEGRAM_TRANSPORT,
      modality: TELEGRAM_MODALITY,
      result: "linked_identity_resolved",
      context: thanosContext,
    }));

    try {
      const result = await this.readOrchestrator.run({
        context: thanosContext,
        tool: pastoralTool,
        system: "Responder somente com a evidência READ autorizada, sem executar escrita, sem expor identidade ou dados brutos.",
        user: input.text,
        generator: this.generator,
      });
      const completed = Object.freeze({
        status: "completed" as const,
        requestId,
        transport: TELEGRAM_TRANSPORT,
        modality: TELEGRAM_MODALITY,
        content: result.content,
        tool: TELEGRAM_READ_TOOL,
        provider: "deterministic" as const,
        model: TELEGRAM_READ_MODEL,
      });
      if (blockId) this.processedBlocks.set(blockId, completed);
      return completed;
    } catch {
      return this.denied(requestId, "read_failed");
    }
  }

  private async recordDenied(requestId: string, reason: string): Promise<void> {
    await this.input.audit.record(Object.freeze({
      action: "telegram.ingress.denied",
      status: "denied",
      requestId,
      transport: TELEGRAM_TRANSPORT,
      modality: TELEGRAM_MODALITY,
      result: "ingress_denied",
      reason,
    }));
  }

  private denied(requestId: string, reason: string): TelegramAdapterResult {
    return Object.freeze({
      status: "denied",
      requestId,
      transport: TELEGRAM_TRANSPORT,
      modality: TELEGRAM_MODALITY,
      content: TELEGRAM_GENERIC_DENIAL,
      reason,
    });
  }
}
