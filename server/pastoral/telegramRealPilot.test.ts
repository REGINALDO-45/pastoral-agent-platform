import { describe, expect, it } from "vitest";
import {
  TELEGRAM_ALLOWED_UPDATES,
  TELEGRAM_BOT_API_HOST,
  TELEGRAM_PILOT_DEFAULT_VERSION,
  TELEGRAM_REAL_PILOT_ALLOWED_METHODS,
  TELEGRAM_REAL_PILOT_ALLOWED_TOOLS,
  TelegramBotApiClient,
  TelegramBotApiError,
  TelegramLongPollingReceiver,
  TelegramPilotBlockedError,
  auditEventContainsPrivateData,
  createTelegramRealPilotRuntime,
  readTelegramPilotConfig,
  telegramPilotEnvironmentSummary,
  type TelegramBotApiFetch,
  type TelegramPilotAuditEvent,
} from "./telegramRealPilot";
import type { PastoralRepository, TenantContext, ToolResult } from "./types";
import type { TelegramAuditEvent } from "./telegramChannel";

type FakeCall = Readonly<{ url: string; method: string; body: Record<string, unknown> }>;

const runtimeToken = ["runtime", "bot", "credential"].join("-");

function tenantContext(): TenantContext {
  return {
    organizationId: 42,
    organizationName: "Igreja Teste",
    userId: 7,
    userName: "Usuário Interno",
    role: "admin",
  };
}

function repositoryFixture(options: Readonly<{ queryDelayMs?: number }> = {}) {
  const calls: Array<{ method: string; context: TenantContext }> = [];
  const cellsResult: ToolResult = {
    tool: "consultar_celulas",
    summary: "Há 2 células ativas no tenant autorizado.",
    data: { count: 2, privateMemberName: "não deve sair" },
  };
  const repository = {
    queryCells: async (context: TenantContext) => {
      calls.push({ method: "queryCells", context });
      if (options.queryDelayMs) await new Promise(resolve => setTimeout(resolve, options.queryDelayMs));
      return cellsResult;
    },
    queryReports: async (context: TenantContext) => {
      calls.push({ method: "queryReports", context });
      return { tool: "consultar_relatorios" as const, summary: "Relatórios", data: {} };
    },
    queryAttendance: async (context: TenantContext) => {
      calls.push({ method: "queryAttendance", context });
      return { tool: "consultar_presenca" as const, summary: "Presença", data: {} };
    },
    queryVisitors: async (context: TenantContext) => {
      calls.push({ method: "queryVisitors", context });
      return { tool: "consultar_visitantes" as const, summary: "Visitantes", data: {} };
    },
    queryLeaders: async (context: TenantContext) => {
      calls.push({ method: "queryLeaders", context });
      return { tool: "consultar_lideres" as const, summary: "Líderes", data: {} };
    },
    findVisitor: async () => null,
    appendMessage: async () => {
      throw new Error("M20 não persiste mensagens Telegram.");
    },
    writeFollowup: async () => {
      throw new Error("M20 não executa WRITE Telegram.");
    },
    audit: async () => undefined,
  } satisfies PastoralRepository;
  return { repository, calls };
}

function environment(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    TELEGRAM_PILOT_ENABLED: "true",
    TELEGRAM_PILOT_KILL_SWITCH: "false",
    TELEGRAM_BOT_TOKEN: runtimeToken,
    TELEGRAM_PILOT_EXTERNAL_USER_ID: "1001",
    TELEGRAM_PILOT_EXTERNAL_CHAT_ID: "2001",
    TELEGRAM_PILOT_ORGANIZATION_ID: "42",
    TELEGRAM_PILOT_INTERNAL_USER_ID: "7",
    TELEGRAM_PILOT_VERSION: TELEGRAM_PILOT_DEFAULT_VERSION,
    TELEGRAM_PILOT_POLL_TIMEOUT_SECONDS: "0",
    TELEGRAM_PILOT_REQUEST_TIMEOUT_MS: "1000",
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function update(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    update_id: 101,
    message: {
      message_id: 1,
      from: { id: 1001 },
      chat: { id: 2001, type: "private" },
      text: "/celulas",
      ...overrides,
    },
  };
}

function createFetchSequence(responses: readonly Response[]) {
  const calls: FakeCall[] = [];
  let index = 0;
  const fetchImpl: TelegramBotApiFetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ url: url.replace(runtimeToken, "<redacted>"), method: init?.method ?? "GET", body });
    const next = responses[index++];
    if (!next) throw new Error("fake response exhausted");
    return next;
  };
  return { fetchImpl, calls };
}

function createRuntimeFixture(input: Readonly<{
  responses?: readonly Response[];
  environment?: Readonly<Record<string, string>>;
  environmentRef?: Record<string, string>;
  queryDelayMs?: number;
}>) {
  const fixture = repositoryFixture({ queryDelayMs: input.queryDelayMs });
  const auditEvents: TelegramPilotAuditEvent[] = [];
  const m19Events: TelegramAuditEvent[] = [];
  const fetch = createFetchSequence(input.responses ?? []);
  const runtime = createTelegramRealPilotRuntime({
    repository: fixture.repository,
    environment: input.environmentRef ?? environment(input.environment),
    fetchImpl: fetch.fetchImpl,
    membershipLookup: async binding => binding.organizationId === 42 && binding.internalUserId === 7 ? tenantContext() : null,
    audit: {
      record: async event => m19Events.push(event),
      recordPilot: async event => auditEvents.push(event),
    },
  });
  return { ...fixture, calls: fetch.calls, fetchCalls: fetch.calls, repositoryCalls: fixture.calls, runtime, auditEvents, m19Events };
}

const getMeOk = () => response({ ok: true, result: { id: 99, is_bot: true } });
const webhookEmpty = () => response({ ok: true, result: { url: "" } });
const webhookActive = () => response({ ok: true, result: { url: "https://existing.example.invalid/telegram" } });
const sendMessageOk = () => response({ ok: true, result: { message_id: 201 } });

async function pollWithUpdate(input: Readonly<{
  updateValue?: unknown;
  environment?: Readonly<Record<string, string>>;
  extraResponses?: readonly Response[];
}>) {
  const fixture = createRuntimeFixture({
    environment: input.environment,
    responses: [
      getMeOk(),
      webhookEmpty(),
      response({ ok: true, result: [input.updateValue ?? update({ from: { id: 1001 }, chat: { id: 2001, type: "private" } })] }),
      ...(input.extraResponses ?? [sendMessageOk()]),
    ],
  });
  await fixture.runtime.receiver.preflight();
  const result = await fixture.runtime.receiver.pollOnce();
  return { ...fixture, result };
}

describe("THÁNOS M20 controlled Telegram real-read pilot", () => {
  it("defaults disabled, has no configured binding, and exposes no secret in summary", () => {
    const config = readTelegramPilotConfig({});
    expect(config.enabled).toBe(false);
    expect(config.killSwitch).toBe(false);
    expect(config.botToken).toBe("");
    expect(config.organizationId).toBeUndefined();
    expect(config.internalUserId).toBeUndefined();
    expect(telegramPilotEnvironmentSummary(config)).toEqual(expect.objectContaining({ tokenConfigured: false, bindingConfigured: false }));
    expect(JSON.stringify(telegramPilotEnvironmentSummary(config))).not.toContain("credential");
  });

  it("pilot disabled stops before any Bot API call", async () => {
    const fixture = createRuntimeFixture({
      environment: {
        TELEGRAM_PILOT_ENABLED: "false",
        TELEGRAM_BOT_TOKEN: "",
      },
      responses: [getMeOk()],
    });
    await expect(fixture.runtime.receiver.preflight()).rejects.toMatchObject({ reason: "pilot_disabled" });
    expect(fixture.calls).toHaveLength(0);
  });

  it("kill switch stops before getMe and before any runtime/outbound work", async () => {
    const fixture = createRuntimeFixture({
      environment: { TELEGRAM_PILOT_KILL_SWITCH: "true" },
      responses: [getMeOk()],
    });
    await expect(fixture.runtime.receiver.preflight()).rejects.toMatchObject({ reason: "kill_switch_active" });
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.calls).not.toContainEqual(expect.objectContaining({ body: expect.objectContaining({ chat_id: expect.anything() }) }));
  });

  it("missing token and incomplete binding fail closed", async () => {
    const noToken = createRuntimeFixture({ environment: { TELEGRAM_BOT_TOKEN: "" }, responses: [getMeOk] });
    const noBinding = createRuntimeFixture({ environment: { TELEGRAM_PILOT_EXTERNAL_CHAT_ID: "" }, responses: [getMeOk] });
    await expect(noToken.runtime.receiver.preflight()).rejects.toMatchObject({ reason: "bot_token_missing" });
    await expect(noBinding.runtime.receiver.preflight()).rejects.toMatchObject({ reason: "pilot_binding_incomplete" });
    expect(noToken.calls).toHaveLength(0);
    expect(noBinding.calls).toHaveLength(0);
  });

  it("getMe failure and Telegram ok=false fail closed without exposing the token", async () => {
    const fixture = createRuntimeFixture({ responses: [response({ ok: false, error_code: 401, description: "Unauthorized" }, 401)] });
    await expect(fixture.runtime.receiver.preflight()).rejects.toMatchObject({ reason: "bot_authentication_failed" });
    expect(fixture.calls[0].url).toContain(`https://${TELEGRAM_BOT_API_HOST}/bot`);
    expect(fixture.calls[0].url).not.toContain(runtimeToken);
    const errorFixture = createRuntimeFixture({ responses: [response({ ok: false, error_code: 500 }, 500)] });
    await expect(errorFixture.runtime.client.getMe()).rejects.toBeInstanceOf(TelegramBotApiError);
    await expect(errorFixture.runtime.client.getMe()).rejects.not.toHaveProperty("message", expect.stringContaining(runtimeToken));
  });

  it("getWebhookInfo with active URL blocks polling without deleteWebhook", async () => {
    const fixture = createRuntimeFixture({       responses: [getMeOk(), webhookActive()] });
    await expect(fixture.runtime.receiver.preflight()).rejects.toMatchObject({ reason: "webhook_active" });
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls.map(call => call.url)).not.toContainEqual(expect.stringContaining("deleteWebhook"));
    expect(fixture.auditEvents).toContainEqual(expect.objectContaining({ operation: "preflight", reason: "webhook_active", status: "denied" }));
  });

  it("poll without preflight is denied before getUpdates", async () => {
    const fixture = createRuntimeFixture({ responses: [response({ ok: true, result: [] })] });
    await expect(fixture.runtime.receiver.pollOnce()).rejects.toMatchObject({ reason: "preflight_required" });
    expect(fixture.calls).toHaveLength(0);
  });

  it("getMe preflight failure leaves polling denied and performs zero getUpdates", async () => {
    const fixture = createRuntimeFixture({ responses: [response({ ok: false, error_code: 401 }, 401), response({ ok: true, result: [] })] });
    await expect(fixture.runtime.receiver.preflight()).rejects.toMatchObject({ reason: "bot_authentication_failed" });
    await expect(fixture.runtime.receiver.pollOnce()).rejects.toMatchObject({ reason: "preflight_required" });
    expect(fixture.calls.filter(call => call.url.endsWith("/getUpdates"))).toHaveLength(0);
  });

  it("active webhook leaves polling denied and performs zero getUpdates", async () => {
    const fixture = createRuntimeFixture({ responses: [getMeOk(), webhookActive(), response({ ok: true, result: [] })] });
    await expect(fixture.runtime.receiver.preflight()).rejects.toMatchObject({ reason: "webhook_active" });
    await expect(fixture.runtime.receiver.pollOnce()).rejects.toMatchObject({ reason: "preflight_required" });
    expect(fixture.calls.filter(call => call.url.endsWith("/getUpdates"))).toHaveLength(0);
  });

  it("invalidates the preflight grant when kill switch or pilot state changes", async () => {
    const killSwitchEnvironment = environment();
    const killSwitchFixture = createRuntimeFixture({ environmentRef: killSwitchEnvironment, responses: [getMeOk(), webhookEmpty()] });
    await killSwitchFixture.runtime.receiver.preflight();
    killSwitchEnvironment.TELEGRAM_PILOT_KILL_SWITCH = "true";
    await expect(killSwitchFixture.runtime.receiver.pollOnce()).rejects.toMatchObject({ reason: "kill_switch_active" });
    expect(killSwitchFixture.calls.filter(call => call.url.endsWith("/getUpdates"))).toHaveLength(0);

    const disabledEnvironment = environment();
    const disabledFixture = createRuntimeFixture({ environmentRef: disabledEnvironment, responses: [getMeOk(), webhookEmpty()] });
    await disabledFixture.runtime.receiver.preflight();
    disabledEnvironment.TELEGRAM_PILOT_ENABLED = "false";
    await expect(disabledFixture.runtime.receiver.pollOnce()).rejects.toMatchObject({ reason: "pilot_disabled" });
    expect(disabledFixture.calls.filter(call => call.url.endsWith("/getUpdates"))).toHaveLength(0);
  });

  it("empty webhook makes polling eligible and requests only message updates", async () => {
    const fixture = createRuntimeFixture({ responses: [getMeOk(), webhookEmpty()] });
    await expect(fixture.runtime.receiver.preflight()).resolves.toEqual({ botAuthenticated: true, webhookPresent: false });
    const pollFixture = createRuntimeFixture({ responses: [getMeOk(), webhookEmpty(), response({ ok: true, result: [] })] });
    await pollFixture.runtime.receiver.preflight();
    await pollFixture.runtime.receiver.pollOnce(10);
    expect(pollFixture.calls[2].body).toMatchObject({ offset: 10, timeout: 0, allowed_updates: [...TELEGRAM_ALLOWED_UPDATES] });
  });

  it("start performs exactly getMe, getWebhookInfo and getUpdates after one authoritative preflight", async () => {
    const fixture = createRuntimeFixture({ responses: [getMeOk(), webhookEmpty(), response({ ok: true, result: [] })] });
    let signalChecks = 0;
    const signal = { get aborted() { return signalChecks++ >= 1; } } as AbortSignal;
    await fixture.runtime.receiver.start(signal);
    expect(fixture.calls.map(call => call.url.split("/").pop())).toEqual(["getMe", "getWebhookInfo", "getUpdates"]);
  });

  it("uses only the fixed host and closed Bot API method allowlist", async () => {
    const fixture = createRuntimeFixture({ responses: [getMeOk()] });
    await fixture.runtime.client.getMe();
    expect(fixture.calls[0].url).toMatch(new RegExp(`^https://${TELEGRAM_BOT_API_HOST}/bot[^/]+/getMe$`));
    expect(TELEGRAM_REAL_PILOT_ALLOWED_METHODS).toEqual(["getMe", "getWebhookInfo", "getUpdates", "sendMessage"]);
    expect(TELEGRAM_REAL_PILOT_ALLOWED_TOOLS).toEqual(["consultar_celulas"]);
  });

  it("normalizes private text and never routes groups, media or malformed updates to runtime", async () => {
    const group = await pollWithUpdate({ updateValue: update({ chat: { id: 2001, type: "group" } }) });
    const supergroup = await pollWithUpdate({ updateValue: update({ chat: { id: 2001, type: "supergroup" } }) });
    const channel = await pollWithUpdate({ updateValue: update({ chat: { id: 2001, type: "channel" } }) });
    const media = await pollWithUpdate({ updateValue: update({ text: undefined, photo: [{ file_id: "opaque" }] }) });
    const malformed = await pollWithUpdate({ updateValue: { update_id: 102 } });

    expect(group.calls).toHaveLength(3);
    expect(supergroup.calls).toHaveLength(3);
    expect(channel.calls).toHaveLength(3);
    expect(media.calls).toHaveLength(3);
    expect(malformed.calls).toHaveLength(3);
    expect(group.calls.some(call => call.body.chat_id)).toBe(false);
    expect(supergroup.calls.some(call => call.body.chat_id)).toBe(false);
    expect(channel.calls.some(call => call.body.chat_id)).toBe(false);
    expect(media.calls.some(call => call.body.chat_id)).toBe(false);
    expect(malformed.calls.some(call => call.body.chat_id)).toBe(false);
  });

  it("denies external user or chat mismatch before membership and READ", async () => {
    const user = await pollWithUpdate({ updateValue: update({ from: { id: 999 } }) });
    const chat = await pollWithUpdate({ updateValue: update({ chat: { id: 999, type: "private" } }) });
    expect(user.calls).toHaveLength(3);
    expect(chat.calls).toHaveLength(3);
    expect(user.calls.some(call => call.body.chat_id)).toBe(false);
    expect(chat.calls.some(call => call.body.chat_id)).toBe(false);
    expect(user.calls).not.toContainEqual(expect.objectContaining({ body: expect.objectContaining({ text: expect.stringContaining("Há") }) }));
  });

  it("does not derive tenant, internal user, role or capabilities from Update", async () => {
    const fixture = await pollWithUpdate({
      updateValue: update({
        tenantId: "org:999",
        userId: 999,
        role: "superadmin",
        capabilities: ["platform:all"],
        text: "/celulas",
      }),
    });
    expect(fixture.calls).toContainEqual(expect.objectContaining({ body: expect.objectContaining({ chat_id: "2001" }) }));
    expect(fixture.calls).toHaveLength(4);
    expect(fixture.calls[3].body.text).toBe("Há 2 células ativas no tenant autorizado.");
    expect(fixture.calls[3].body.text).not.toContain("org:999");
    expect(fixture.calls[3].body.text).not.toContain("superadmin");
    expect(fixture.calls[3].body).not.toHaveProperty("tenantId");
    expect(fixture.calls[3].body).not.toHaveProperty("userId");
    expect(fixture.calls[3].body).not.toHaveProperty("role");
    expect(fixture.calls[3].body).not.toHaveProperty("capabilities");
    expect(fixture.calls).toHaveLength(4);
    expect(fixture.calls.every(call => call.url.startsWith(`https://${TELEGRAM_BOT_API_HOST}/bot`))).toBe(true);
  });

  it("/start and unsupported text do not call tools", async () => {
    const start = await pollWithUpdate({ updateValue: update({ text: "/start" }) });
    const unknown = await pollWithUpdate({ updateValue: update({ text: "me ajude" }) });
    expect(start.calls).toHaveLength(4);
    expect(unknown.calls).toHaveLength(4);
    expect(start.calls[3].body.text).toBe("Piloto THÁNOS ativo. Use /celulas.");
    expect(unknown.calls[3].body.text).toBe("Comando não disponível neste piloto.");
    expect(start.calls.every(call => !call.body.tool)).toBe(true);
    expect(unknown.calls.every(call => !call.body.tool)).toBe(true);
    expect(start.calls.length).toBe(4);
    expect(unknown.calls.length).toBe(4);
  });

  it("/celulas executes consultar_celulas exactly once and sends only authorized summary to the bound chat", async () => {
    const fixture = await pollWithUpdate({});
    expect(fixture.calls).toHaveLength(4);
    expect(fixture.calls.filter(call => call.body.chat_id)).toHaveLength(1);
    expect(fixture.calls[3].body).toEqual({ chat_id: "2001", text: "Há 2 células ativas no tenant autorizado." });
    expect(fixture.calls[3].body.text).not.toContain("não deve sair");
    expect(fixture.calls).not.toContainEqual(expect.objectContaining({ body: expect.objectContaining({ chat_id: "tg-chat-forjado" }) }));
    expect(fixture.calls[3].url.endsWith("/sendMessage")).toBe(true);
    expect(fixture.calls[2].body.allowed_updates).toEqual([...TELEGRAM_ALLOWED_UPDATES]);
    expect(fixture.calls).toHaveLength(4);
    expect(fixture.calls.some(call => call.body.method === "consultar_relatorios")).toBe(false);
  });

  it("duplicate update advances cursor and executes READ/outbound at most once", async () => {
    const fixture = createRuntimeFixture({
      responses: [
        getMeOk(),
        webhookEmpty(),
        response({ ok: true, result: [update()] }),
        sendMessageOk(),
        response({ ok: true, result: [update()] }),
      ],
    });
    await fixture.runtime.receiver.preflight();
    const first = await fixture.runtime.receiver.pollOnce();
    const second = await fixture.runtime.receiver.pollOnce(first.nextOffset);
    expect(first.nextOffset).toBe(102);
    expect(second.nextOffset).toBe(102);
    expect(fixture.calls.filter(call => call.body.chat_id)).toHaveLength(1);
    expect(fixture.calls).toHaveLength(5);
    expect(fixture.calls.find(call => call.url.endsWith("/sendMessage"))?.body.text).toBe("Há 2 células ativas no tenant autorizado.");
    expect(fixture.calls.filter(call => call.url.endsWith("/sendMessage"))).toHaveLength(1);
    expect(fixture.calls.filter(call => call.url.endsWith("/getUpdates"))).toHaveLength(2);
    expect(fixture.calls).toHaveLength(5);
    expect(fixture.calls.every(call => !call.url.includes("deleteWebhook"))).toBe(true);
  });

  it("keeps M19 concurrency protection for the same update block", async () => {
    const fixture = createRuntimeFixture({ queryDelayMs: 20 });
    const input = {
      transport: "telegram" as const,
      modality: "text" as const,
      chatType: "private" as const,
      telegramUserId: "1001",
      telegramChatId: "2001",
      text: "/celulas",
      blockId: "telegram:update:777",
    };
    const [first, second] = await Promise.all([
      fixture.runtime.adapter.handle(input),
      fixture.runtime.adapter.handle(input),
    ]);
    expect([first.status, second.status].sort()).toEqual(["completed", "duplicate"]);
    expect(fixture.repositoryCalls).toHaveLength(1);
  });

  it("sanitizes pilot and M19 audit records", async () => {
    const fixture = await pollWithUpdate({});
    expect(fixture.auditEvents.length).toBeGreaterThan(0);
    expect(fixture.m19Events.length).toBeGreaterThan(0);
    expect(fixture.auditEvents.every(event => !auditEventContainsPrivateData(event))).toBe(true);
    const serialized = JSON.stringify([...fixture.auditEvents, ...fixture.m19Events]);
    expect(serialized).not.toContain(runtimeToken);
    expect(serialized).not.toContain("1001");
    expect(serialized).not.toContain("2001");
    expect(serialized).not.toContain("Usuário Interno");
    expect(serialized).not.toContain("não deve sair");
    expect(serialized).not.toMatch(/raw|first_name|last_name|phone|platformCapabilities|capabilities/i);
    expect(fixture.auditEvents).toContainEqual(expect.objectContaining({ operation: "consultar_celulas", evidenceReference: "summary" }));
  });

  it("fails closed on Bot API HTTP, ok=false, malformed JSON and timeout", async () => {
    const httpError = new TelegramBotApiClient({ token: runtimeToken, fetchImpl: async () => response({ ok: false }, 500), timeoutMs: 20 });
    const telegramError = new TelegramBotApiClient({ token: runtimeToken, fetchImpl: async () => response({ ok: false, error_code: 400 }), timeoutMs: 20 });
    const malformed = new TelegramBotApiClient({ token: runtimeToken, fetchImpl: async () => new Response("not-json", { status: 200 }), timeoutMs: 20 });
    const timeout = new TelegramBotApiClient({ token: runtimeToken, fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }), timeoutMs: 5 });
    await expect(httpError.getMe()).rejects.toBeInstanceOf(TelegramBotApiError);
    await expect(telegramError.getMe()).rejects.toBeInstanceOf(TelegramBotApiError);
    await expect(malformed.getMe()).rejects.toBeInstanceOf(TelegramBotApiError);
    await expect(timeout.getMe()).rejects.toMatchObject({ reason: "timeout" });
  });

  it("does not expose token in errors, audit or environment summary", async () => {
    const config = readTelegramPilotConfig(environment());
    expect(JSON.stringify(telegramPilotEnvironmentSummary(config))).not.toContain(runtimeToken);
    const client = new TelegramBotApiClient({ token: runtimeToken, fetchImpl: async () => { throw new Error(runtimeToken); } });
    await expect(client.getMe()).rejects.not.toHaveProperty("message", expect.stringContaining(runtimeToken));
  });

  it("keeps Hermes, n8n and WhatsApp outside the M20 surface", () => {
    expect(TELEGRAM_REAL_PILOT_ALLOWED_METHODS).not.toContain("setWebhook");
    expect(TELEGRAM_REAL_PILOT_ALLOWED_METHODS).not.toContain("deleteWebhook");
    expect(TELEGRAM_REAL_PILOT_ALLOWED_TOOLS).toEqual(["consultar_celulas"]);
    expect(TELEGRAM_ALLOWED_UPDATES).toEqual(["message"]);
  });
});
