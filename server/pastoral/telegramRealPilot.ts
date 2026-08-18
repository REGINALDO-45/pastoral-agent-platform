import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ENV } from "../_core/env";
import { getDb } from "../db";
import { organizationMemberships, organizations, users } from "../../drizzle/schema";
import {
  SyntheticTelegramIngressVerifier,
  TELEGRAM_READ_TOOL,
  TELEGRAM_TRANSPORT,
  TELEGRAM_MODALITY,
  TelegramChannelAdapter,
  type TelegramAdapterResult,
  type TelegramAuditEvent,
  type TelegramAuditPort,
  type TelegramIdentityResolution,
  type TelegramIngressVerifier,
  type TelegramLinkedIdentity,
  type TelegramInboundInput,
  type TelegramIdentityResolver,
} from "./telegramChannel";
import type { PastoralRepository, TenantContext, TenantRole, ToolCatalogEntry } from "./types";

export const TELEGRAM_BOT_API_HOST = "api.telegram.org" as const;
export const TELEGRAM_ALLOWED_UPDATES = Object.freeze(["message"] as const);
export const TELEGRAM_PILOT_DEFAULT_VERSION = "thanos-telegram-read-pilot-v1" as const;
export const TELEGRAM_PILOT_START_TEXT = "Piloto THÁNOS ativo. Use /celulas.";
export const TELEGRAM_PILOT_UNKNOWN_COMMAND_TEXT = "Comando não disponível neste piloto.";

const TELEGRAM_ALLOWED_METHODS = Object.freeze(["getMe", "getWebhookInfo", "getUpdates", "sendMessage"] as const);
type TelegramBotApiMethod = (typeof TELEGRAM_ALLOWED_METHODS)[number];

type TelegramPilotEnvironment = Readonly<{
  TELEGRAM_PILOT_ENABLED?: string;
  TELEGRAM_PILOT_KILL_SWITCH?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_PILOT_EXTERNAL_USER_ID?: string;
  TELEGRAM_PILOT_EXTERNAL_CHAT_ID?: string;
  TELEGRAM_PILOT_ORGANIZATION_ID?: string;
  TELEGRAM_PILOT_INTERNAL_USER_ID?: string;
  TELEGRAM_PILOT_VERSION?: string;
  TELEGRAM_PILOT_POLL_TIMEOUT_SECONDS?: string;
  TELEGRAM_PILOT_REQUEST_TIMEOUT_MS?: string;
}>;

export type TelegramPilotConfig = Readonly<{
  enabled: boolean;
  killSwitch: boolean;
  botToken: string;
  externalUserId: string;
  externalChatId: string;
  organizationId?: number;
  internalUserId?: number;
  version: string;
  pollTimeoutSeconds: number;
  requestTimeoutMs: number;
}>;

export function readTelegramPilotConfig(environment: TelegramPilotEnvironment = ENV): TelegramPilotConfig {
  return Object.freeze({
    enabled: environment.TELEGRAM_PILOT_ENABLED === "true",
    killSwitch: environment.TELEGRAM_PILOT_KILL_SWITCH === "true",
    botToken: environment.TELEGRAM_BOT_TOKEN?.trim() ?? "",
    externalUserId: environment.TELEGRAM_PILOT_EXTERNAL_USER_ID?.trim() ?? "",
    externalChatId: environment.TELEGRAM_PILOT_EXTERNAL_CHAT_ID?.trim() ?? "",
    organizationId: parsePositiveInteger(environment.TELEGRAM_PILOT_ORGANIZATION_ID),
    internalUserId: parsePositiveInteger(environment.TELEGRAM_PILOT_INTERNAL_USER_ID),
    version: environment.TELEGRAM_PILOT_VERSION?.trim() || TELEGRAM_PILOT_DEFAULT_VERSION,
    pollTimeoutSeconds: parseBoundedInteger(environment.TELEGRAM_PILOT_POLL_TIMEOUT_SECONDS, 10, 0, 50),
    requestTimeoutMs: parseBoundedInteger(environment.TELEGRAM_PILOT_REQUEST_TIMEOUT_MS, 15_000, 1_000, 60_000),
  });
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBoundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function hasCompleteTelegramPilotBinding(config: TelegramPilotConfig): boolean {
  return Boolean(
    config.externalUserId &&
    config.externalChatId &&
    config.organizationId !== undefined &&
    config.internalUserId !== undefined,
  );
}

export type TelegramPilotBlockedReason =
  | "pilot_disabled"
  | "kill_switch_active"
  | "bot_token_missing"
  | "pilot_binding_incomplete"
  | "bot_authentication_failed"
  | "webhook_active"
  | "telegram_update_invalid"
  | "private_chat_required"
  | "text_message_required"
  | "telegram_user_not_allowlisted"
  | "telegram_chat_not_allowlisted"
  | "binding_not_found"
  | "membership_invalid"
  | "command_not_allowed"
  | "runtime_denied"
  | "read_failed"
  | "outbound_failed"
  | "preflight_required";

export class TelegramPilotBlockedError extends Error {
  constructor(public readonly reason: TelegramPilotBlockedReason) {
    super("Piloto Telegram bloqueado.");
    this.name = "TelegramPilotBlockedError";
  }
}

export function assertTelegramPilotCanStart(config: TelegramPilotConfig): void {
  if (!config.enabled) throw new TelegramPilotBlockedError("pilot_disabled");
  if (config.killSwitch) throw new TelegramPilotBlockedError("kill_switch_active");
  if (!config.botToken) throw new TelegramPilotBlockedError("bot_token_missing");
  if (!hasCompleteTelegramPilotBinding(config)) throw new TelegramPilotBlockedError("pilot_binding_incomplete");
}

export function assertTelegramPilotActive(config: TelegramPilotConfig): void {
  if (!config.enabled) throw new TelegramPilotBlockedError("pilot_disabled");
  if (config.killSwitch) throw new TelegramPilotBlockedError("kill_switch_active");
}

type TelegramBotApiEnvelope<T> = Readonly<{
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}>;

export type TelegramBotUser = Readonly<{
  id: number;
  is_bot: boolean;
}>;

export type TelegramWebhookInfo = Readonly<{
  url: string;
}>;

export type TelegramUpdate = Readonly<{
  update_id: number;
  message?: Readonly<{
    message_id: number;
    from?: Readonly<{ id: number }>;
    chat?: Readonly<{ id: number; type: string }>;
    text?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}>;

export type TelegramBotApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class TelegramBotApiError extends Error {
  constructor(public readonly reason: "http_error" | "invalid_json" | "telegram_error" | "invalid_envelope" | "redirect_blocked" | "timeout") {
    super("Telegram Bot API indisponível.");
    this.name = "TelegramBotApiError";
  }
}

export class TelegramBotApiClient {
  private readonly token: string;
  private readonly fetchImpl: TelegramBotApiFetch;
  private readonly timeoutMs: number;

  constructor(input: Readonly<{ token: string; fetchImpl?: TelegramBotApiFetch; timeoutMs?: number }>) {
    this.token = input.token.trim();
    this.fetchImpl = input.fetchImpl ?? fetch;
    this.timeoutMs = input.timeoutMs ?? 15_000;
  }

  async getMe(): Promise<TelegramBotUser> {
    return this.call("getMe", {} as const, isTelegramBotUser);
  }

  async getWebhookInfo(): Promise<TelegramWebhookInfo> {
    return this.call("getWebhookInfo", {} as const, isTelegramWebhookInfo);
  }

  async getUpdates(input: Readonly<{ offset?: number; timeoutSeconds: number }>): Promise<readonly TelegramUpdate[]> {
    return this.call(
      "getUpdates",
      {
        ...(input.offset === undefined ? {} : { offset: input.offset }),
        timeout: input.timeoutSeconds,
        allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
      },
      value => Array.isArray(value) && value.every(isTelegramUpdate),
    );
  }

  async sendMessage(input: Readonly<{ chatId: string; text: string }>): Promise<void> {
    const text = normalizePlainText(input.text);
    if (!input.chatId.trim() || !text) throw new TelegramBotApiError("invalid_envelope");
    await this.call(
      "sendMessage",
      { chat_id: input.chatId, text } as const,
      (value): value is Record<string, unknown> => isRecord(value) && typeof value.message_id === "number",
    );
  }

  private async call<T>(method: TelegramBotApiMethod, payload: Readonly<Record<string, unknown>>, validate: (value: unknown) => value is T): Promise<T> {
    if (!TELEGRAM_ALLOWED_METHODS.includes(method) || !this.token) throw new TelegramBotApiError("invalid_envelope");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `https://${TELEGRAM_BOT_API_HOST}/bot${this.tokenForRequest()}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          redirect: "error",
          signal: controller.signal,
        },
      ).catch(error => {
        if (error instanceof Error && error.name === "AbortError") throw new TelegramBotApiError("timeout");
        throw new TelegramBotApiError("http_error");
      });

      if (response.url) {
        try {
          if (new URL(response.url).hostname !== TELEGRAM_BOT_API_HOST) throw new TelegramBotApiError("redirect_blocked");
        } catch (error) {
          if (error instanceof TelegramBotApiError) throw error;
          throw new TelegramBotApiError("redirect_blocked");
        }
      }
      if (!response.ok) throw new TelegramBotApiError("http_error");

      let envelope: TelegramBotApiEnvelope<unknown>;
      try {
        envelope = await response.json() as TelegramBotApiEnvelope<unknown>;
      } catch {
        throw new TelegramBotApiError("invalid_json");
      }
      if (!envelope || envelope.ok !== true || !validate(envelope.result)) throw new TelegramBotApiError("telegram_error");
      return envelope.result;
    } finally {
      clearTimeout(timer);
    }
  }

  private tokenForRequest(): string {
    return this.token;
  }
}

export type TelegramPilotBinding = Readonly<{
  externalUserId: string;
  externalChatId: string;
  organizationId: number;
  internalUserId: number;
}>;

export type TelegramMembershipLookup = (binding: TelegramPilotBinding) => Promise<TenantContext | null>;

export class DatabaseTelegramPilotIdentityResolver implements TelegramIdentityResolver {
  constructor(
    private readonly binding: TelegramPilotBinding,
    private readonly enabled: () => boolean,
    private readonly lookup: TelegramMembershipLookup = lookupTelegramPilotMembership,
  ) {}

  async resolve(input: Readonly<{ telegramUserId: string; telegramChatId: string }>): Promise<TelegramIdentityResolution> {
    if (!this.enabled()) return Object.freeze({ status: "disabled" as const, reason: "integration_disabled" as const });
    if (input.telegramUserId !== this.binding.externalUserId || input.telegramChatId !== this.binding.externalChatId) {
      return Object.freeze({ status: "unlinked" as const, reason: "identity_not_linked" as const });
    }
    const tenantContext = await this.lookup(this.binding);
    if (!tenantContext) return Object.freeze({ status: "unlinked" as const, reason: "identity_not_linked" as const });
    if (tenantContext.organizationId !== this.binding.organizationId || tenantContext.userId !== this.binding.internalUserId) {
      return Object.freeze({ status: "unlinked" as const, reason: "identity_not_linked" as const });
    }
    const identity: TelegramLinkedIdentity = Object.freeze({
      telegramUserId: this.binding.externalUserId,
      telegramChatId: this.binding.externalChatId,
      tenantContext,
    });
    return Object.freeze({ status: "linked" as const, identity });
  }
}

async function lookupTelegramPilotMembership(binding: TelegramPilotBinding): Promise<TenantContext | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      userId: users.id,
      userName: users.name,
      role: organizationMemberships.role,
    })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizationMemberships.organizationId, organizations.id))
    .innerJoin(users, eq(organizationMemberships.userId, users.id))
    .where(and(eq(organizationMemberships.organizationId, binding.organizationId), eq(organizationMemberships.userId, binding.internalUserId)))
    .limit(1);
  const row = rows[0];
  if (!row || !isTenantRole(row.role)) return null;
  return Object.freeze({
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    userId: row.userId,
    userName: row.userName ?? "Usuário",
    role: row.role,
  });
}

function isTenantRole(value: string): value is TenantRole {
  return value === "admin" || value === "pastor" || value === "supervisor" || value === "leader";
}

export type TelegramPilotAuditEvent = Readonly<{
  requestId?: string;
  transport: typeof TELEGRAM_TRANSPORT;
  modality: typeof TELEGRAM_MODALITY;
  operation: "preflight" | "ingress" | "consultar_celulas" | "outbound";
  pilotVersion: string;
  status: "success" | "denied" | "failure";
  bindingMatched?: boolean;
  updateCorrelation?: string;
  durationMs?: number;
  evidenceReference?: "summary";
  outbound?: "success" | "failure";
  duplicate?: boolean;
  reason?: string;
}>;

export type TelegramPilotAuditPort = TelegramAuditPort & Readonly<{
  recordPilot(event: TelegramPilotAuditEvent): Promise<void>;
}>;

export class InMemoryTelegramPilotAuditPort implements TelegramPilotAuditPort {
  readonly events: TelegramPilotAuditEvent[] = [];
  readonly m19Events: TelegramAuditEvent[] = [];

  async recordPilot(event: TelegramPilotAuditEvent): Promise<void> {
    this.events.push(Object.freeze({ ...event }));
  }

  async record(event: TelegramAuditEvent): Promise<void> {
    this.m19Events.push(Object.freeze({ ...event }));
  }
}

export type TelegramRealPilotRuntime = Readonly<{
  config: TelegramPilotConfig;
  client: TelegramBotApiClient;
  identityResolver: TelegramIdentityResolver;
  ingressVerifier: TelegramIngressVerifier;
  adapter: TelegramChannelAdapter;
  receiver: TelegramLongPollingReceiver;
}>;

export function createTelegramRealPilotRuntime(input: Readonly<{
  repository: PastoralRepository;
  audit: TelegramPilotAuditPort;
  environment?: TelegramPilotEnvironment;
  fetchImpl?: TelegramBotApiFetch;
  membershipLookup?: TelegramMembershipLookup;
}>): TelegramRealPilotRuntime {
  const config = readTelegramPilotConfig(input.environment);
  const binding = createBindingFromConfig(config);
  const identityResolver = new DatabaseTelegramPilotIdentityResolver(
    binding,
    () => readTelegramPilotConfig(input.environment).enabled && !readTelegramPilotConfig(input.environment).killSwitch,
    input.membershipLookup,
  );
  const ingressVerifier = new SyntheticTelegramIngressVerifier();
  const adapter = new TelegramChannelAdapter({
    repository: input.repository,
    identityResolver,
    ingressVerifier,
    audit: input.audit,
    readTool: TELEGRAM_READ_TOOL,
  });
  const client = new TelegramBotApiClient({ token: config.botToken, fetchImpl: input.fetchImpl, timeoutMs: config.requestTimeoutMs });
  const receiver = new TelegramLongPollingReceiver({
    getConfig: () => readTelegramPilotConfig(input.environment),
    client,
    adapter,
    identityResolver,
    ingressVerifier,
    audit: input.audit,
  });
  return Object.freeze({ config, client, identityResolver, ingressVerifier, adapter, receiver });
}

function createBindingFromConfig(config: TelegramPilotConfig): TelegramPilotBinding {
  return {
    externalUserId: config.externalUserId,
    externalChatId: config.externalChatId,
    organizationId: config.organizationId ?? 0,
    internalUserId: config.internalUserId ?? 0,
  };
}

export type TelegramLongPollingReceiverInput = Readonly<{
  getConfig: () => TelegramPilotConfig;
  client: TelegramBotApiClient;
  adapter: TelegramChannelAdapter;
  identityResolver: TelegramIdentityResolver;
  ingressVerifier: TelegramIngressVerifier;
  audit: TelegramPilotAuditPort;
  requestIdFactory?: () => string;
  now?: () => number;
}>;

type TelegramPollingGrant = Readonly<{
  client: TelegramBotApiClient;
  configFingerprint: string;
}>;

function telegramPollingConfigFingerprint(config: TelegramPilotConfig): string {
  return [
    config.enabled ? "1" : "0",
    config.killSwitch ? "1" : "0",
    config.externalUserId,
    config.externalChatId,
    config.organizationId ?? "",
    config.internalUserId ?? "",
    config.version,
    config.pollTimeoutSeconds,
    config.requestTimeoutMs,
  ].map(value => encodeURIComponent(String(value))).join("|");
}

export class TelegramLongPollingReceiver {
  private readonly requestIdFactory: () => string;
  private readonly now: () => number;
  private preflightGrant: TelegramPollingGrant | undefined;

  constructor(private readonly input: TelegramLongPollingReceiverInput) {
    this.requestIdFactory = input.requestIdFactory ?? randomUUID;
    this.now = input.now ?? Date.now;
  }

  async preflight(): Promise<Readonly<{ botAuthenticated: true; webhookPresent: false }>> {
    this.preflightGrant = undefined;
    const config = this.input.getConfig();
    assertTelegramPilotCanStart(config);
    const preflightFingerprint = telegramPollingConfigFingerprint(config);
    try {
      await this.input.client.getMe();
    } catch {
      this.preflightGrant = undefined;
      await this.recordPilot({ operation: "preflight", status: "failure", reason: "bot_authentication_failed" });
      throw new TelegramPilotBlockedError("bot_authentication_failed");
    }
    try {
      const webhook = await this.input.client.getWebhookInfo();
      if (webhook.url.trim()) {
        this.preflightGrant = undefined;
        await this.recordPilot({ operation: "preflight", status: "denied", reason: "webhook_active" });
        throw new TelegramPilotBlockedError("webhook_active");
      }
    } catch (error) {
      if (error instanceof TelegramPilotBlockedError) throw error;
      this.preflightGrant = undefined;
      await this.recordPilot({ operation: "preflight", status: "failure", reason: "bot_authentication_failed" });
      throw new TelegramPilotBlockedError("bot_authentication_failed");
    }
    const currentConfig = this.input.getConfig();
    if (!hasCompleteTelegramPilotBinding(currentConfig) || !currentConfig.enabled || currentConfig.killSwitch || telegramPollingConfigFingerprint(currentConfig) !== preflightFingerprint) {
      this.preflightGrant = undefined;
      await this.recordPilot({ operation: "preflight", status: "denied", reason: "preflight_invalidated" });
      throw new TelegramPilotBlockedError("preflight_required");
    }
    this.preflightGrant = Object.freeze({ client: this.input.client, configFingerprint: preflightFingerprint });
    await this.recordPilot({ operation: "preflight", status: "success" });
    return Object.freeze({ botAuthenticated: true as const, webhookPresent: false as const });
  }

  private assertPollingAuthorized(): TelegramPilotConfig {
    const config = this.input.getConfig();
    assertTelegramPilotActive(config);
    const grant = this.preflightGrant;
    if (!grant || grant.client !== this.input.client || grant.configFingerprint !== telegramPollingConfigFingerprint(config)) {
      throw new TelegramPilotBlockedError("preflight_required");
    }
    return config;
  }

  async pollOnce(offset?: number): Promise<Readonly<{ nextOffset?: number; processed: number }>> {
    const config = this.assertPollingAuthorized();
    const updates = await this.input.client.getUpdates({ offset, timeoutSeconds: config.pollTimeoutSeconds });
    let nextOffset = offset;
    let processed = 0;
    for (const update of updates) {
      assertTelegramPilotActive(this.input.getConfig());
      nextOffset = Math.max(nextOffset ?? 0, update.update_id + 1);
      await this.processUpdate(update);
      processed += 1;
    }
    return Object.freeze({ ...(nextOffset === undefined ? {} : { nextOffset }), processed });
  }

  async start(signal?: AbortSignal): Promise<void> {
    await this.preflight();
    let offset: number | undefined;
    while (!signal?.aborted) {
      try {
        assertTelegramPilotActive(this.input.getConfig());
      } catch (error) {
        if (error instanceof TelegramPilotBlockedError && error.reason === "kill_switch_active") return;
        throw error;
      }
      const result = await this.pollOnce(offset);
      offset = result.nextOffset;
    }
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const requestId = this.requestIdFactory();
    const updateCorrelation = isValidUpdateId(update.update_id) ? `telegram:update:${update.update_id}` : undefined;
    const startedAt = this.now();
    if (!isValidUpdate(update)) {
      await this.recordPilot({ requestId, operation: "ingress", status: "denied", reason: "telegram_update_invalid", ...(updateCorrelation ? { updateCorrelation } : {}) });
      return;
    }
    const message = update.message;
    const externalUserId = String(message.from?.id ?? "");
    const externalChatId = String(message.chat?.id ?? "");
    if (message.chat?.type !== "private") {
      await this.recordPilot({ requestId, operation: "ingress", status: "denied", reason: "private_chat_required", updateCorrelation });
      return;
    }
    if (typeof message.text !== "string") {
      await this.recordPilot({ requestId, operation: "ingress", status: "denied", reason: "text_message_required", updateCorrelation });
      return;
    }
    const config = this.input.getConfig();
    if (externalUserId !== config.externalUserId) {
      await this.recordPilot({ requestId, operation: "ingress", status: "denied", reason: "telegram_user_not_allowlisted", bindingMatched: false, updateCorrelation });
      return;
    }
    if (externalChatId !== config.externalChatId) {
      await this.recordPilot({ requestId, operation: "ingress", status: "denied", reason: "telegram_chat_not_allowlisted", bindingMatched: false, updateCorrelation });
      return;
    }
    const resolution = await this.input.identityResolver.resolve({ telegramUserId: externalUserId, telegramChatId: externalChatId });
    if (resolution.status !== "linked") {
      await this.recordPilot({ requestId, operation: "ingress", status: "denied", reason: resolution.reason === "integration_disabled" ? "pilot_disabled" : "binding_not_found", bindingMatched: false, updateCorrelation });
      return;
    }
    await this.recordPilot({ requestId, operation: "ingress", status: "success", bindingMatched: true, updateCorrelation, durationMs: this.now() - startedAt });

    const command = message.text.trim();
    if (command === "/start") {
      await this.sendAuthorized(config, requestId, updateCorrelation, TELEGRAM_PILOT_START_TEXT);
      return;
    }
    if (command !== "/celulas") {
      await this.sendAuthorized(config, requestId, updateCorrelation, TELEGRAM_PILOT_UNKNOWN_COMMAND_TEXT);
      return;
    }

    assertTelegramPilotActive(this.input.getConfig());
    const adapterInput: TelegramInboundInput = {
      transport: TELEGRAM_TRANSPORT,
      modality: TELEGRAM_MODALITY,
      chatType: "private",
      telegramUserId: externalUserId,
      telegramChatId: externalChatId,
      text: command,
      blockId: updateCorrelation,
    };
    const result = await this.input.adapter.handle(adapterInput);
    if (result.status !== "completed" || result.tool !== TELEGRAM_READ_TOOL || !result.evidence) {
      await this.recordPilot({ requestId, operation: "consultar_celulas", status: "denied", bindingMatched: true, updateCorrelation, reason: result.reason ?? "runtime_denied", duplicate: result.status === "duplicate" });
      return;
    }
    await this.recordPilot({ requestId, operation: "consultar_celulas", status: "success", bindingMatched: true, updateCorrelation, durationMs: this.now() - startedAt, evidenceReference: "summary", duplicate: false });
    assertTelegramPilotActive(this.input.getConfig());
    await this.sendAuthorized(config, requestId, updateCorrelation, result.evidence.summary);
  }

  private async sendAuthorized(config: TelegramPilotConfig, requestId: string, updateCorrelation: string | undefined, text: string): Promise<void> {
    assertTelegramPilotActive(this.input.getConfig());
    try {
      await this.input.client.sendMessage({ chatId: config.externalChatId, text: normalizePlainText(text) });
      await this.recordPilot({ requestId, operation: "outbound", status: "success", updateCorrelation, outbound: "success" });
    } catch {
      await this.recordPilot({ requestId, operation: "outbound", status: "failure", updateCorrelation, outbound: "failure", reason: "outbound_failed" });
      throw new TelegramPilotBlockedError("outbound_failed");
    }
  }

  private async recordPilot(event: Omit<TelegramPilotAuditEvent, "transport" | "modality" | "pilotVersion">): Promise<void> {
    await this.input.audit.recordPilot({
      transport: TELEGRAM_TRANSPORT,
      modality: TELEGRAM_MODALITY,
      pilotVersion: this.input.getConfig().version,
      ...event,
    });
  }
}

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidUpdate(value: unknown): value is TelegramUpdate & { message: NonNullable<TelegramUpdate["message"]> } {
  if (!isRecord(value) || !isValidUpdateId(value.update_id) || !isRecord(value.message)) return false;
  const message = value.message;
  const chat = message.chat;
  const from = message.from;
  return (
    typeof message.message_id === "number" &&
    isRecord(chat) &&
    typeof chat.id === "number" &&
    typeof chat.type === "string" &&
    isRecord(from) &&
    typeof from.id === "number"
  );
}

function isTelegramBotUser(value: unknown): value is TelegramBotUser {
  return isRecord(value) && typeof value.id === "number" && typeof value.is_bot === "boolean";
}

function isTelegramWebhookInfo(value: unknown): value is TelegramWebhookInfo {
  return isRecord(value) && typeof value.url === "string";
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  return isRecord(value) && isValidUpdateId(value.update_id);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

export function normalizePlainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\*\*/g, "")
    .replace(/[\\`*_]/g, "")
    .replace(/\[[^\]]+\]\([^)]*\)/g, match => match.replace(/\[|\]|\([^)]*\)/g, ""))
    .trim()
    .slice(0, 4096);
}

export function telegramPilotBindingFromConfig(config: TelegramPilotConfig): TelegramPilotBinding | null {
  if (!hasCompleteTelegramPilotBinding(config)) return null;
  return Object.freeze({
    externalUserId: config.externalUserId,
    externalChatId: config.externalChatId,
    organizationId: config.organizationId as number,
    internalUserId: config.internalUserId as number,
  });
}

export const TELEGRAM_REAL_PILOT_ALLOWED_TOOLS = Object.freeze([TELEGRAM_READ_TOOL] as const);
export const TELEGRAM_REAL_PILOT_ALLOWED_METHODS = TELEGRAM_ALLOWED_METHODS;
export const TELEGRAM_REAL_PILOT_POLICY = Object.freeze({
  transport: TELEGRAM_TRANSPORT,
  modality: TELEGRAM_MODALITY,
  allowedTools: TELEGRAM_REAL_PILOT_ALLOWED_TOOLS,
  allowedMethods: TELEGRAM_REAL_PILOT_ALLOWED_METHODS,
  writeEnabled: false as const,
  sensitiveEnabled: false as const,
  webhookEnabled: false as const,
});

export function isTelegramPilotEnvironmentDisabled(environment: TelegramPilotEnvironment = ENV): boolean {
  const config = readTelegramPilotConfig(environment);
  return !config.enabled && !config.killSwitch;
}

export function isTelegramPilotInput(input: TelegramInboundInput): boolean {
  return input.transport === TELEGRAM_TRANSPORT && input.modality === TELEGRAM_MODALITY && input.chatType === "private";
}

export function auditEventContainsPrivateData(event: TelegramPilotAuditEvent): boolean {
  const serialized = JSON.stringify(event);
  return /raw|token|username|first_name|last_name|phone|capabilities|platformCapabilities|telegramUserId|telegramChatId|texto/i.test(serialized);
}

export type TelegramPilotM19AuditBridge = Readonly<{
  record(event: TelegramAuditEvent): Promise<void>;
  recordPilot(event: TelegramPilotAuditEvent): Promise<void>;
}>;

export function createTelegramPilotAuditBridge(audit: TelegramPilotAuditPort): TelegramAuditPort {
  return Object.freeze({
    record: async (event: TelegramAuditEvent) => audit.record(event),
  });
}

export function isAllowedTelegramBotApiMethod(method: string): method is TelegramBotApiMethod {
  return (TELEGRAM_ALLOWED_METHODS as readonly string[]).includes(method);
}

export function telegramPilotEnvironmentSummary(config: TelegramPilotConfig): Readonly<Record<string, string | boolean | number | undefined>> {
  return Object.freeze({
    enabled: config.enabled,
    killSwitch: config.killSwitch,
    tokenConfigured: Boolean(config.botToken),
    bindingConfigured: hasCompleteTelegramPilotBinding(config),
    version: config.version,
    pollTimeoutSeconds: config.pollTimeoutSeconds,
  });
}
