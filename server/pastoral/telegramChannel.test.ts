import { describe, expect, it } from "vitest";
import {
  InMemoryTelegramIdentityResolver,
  TelegramChannelAdapter,
  TELEGRAM_POLICY,
  type TelegramAuditEvent,
  type TelegramLinkedIdentity,
} from "./telegramChannel";
import type { PastoralRepository, TenantContext, ToolResult } from "./types";

function tenantContext(): TenantContext {
  return {
    organizationId: 42,
    organizationName: "Igreja Teste",
    userId: 7,
    userName: "Usuário Linked",
    role: "admin",
  };
}

function linkedIdentity(): TelegramLinkedIdentity {
  return {
    telegramUserId: "tg-user-1",
    telegramChatId: "tg-chat-1",
    tenantContext: tenantContext(),
    conversationId: 101,
  };
}

function repositoryFixture() {
  const calls: Array<{ method: string; context: TenantContext }> = [];
  const cellsResult: ToolResult = {
    tool: "consultar_celulas",
    summary: "Há 2 células ativas no tenant atual.",
    data: { count: 2, rawMemberNames: ["não deve sair"] },
  };
  const repository = {
    queryCells: async (context: TenantContext) => {
      calls.push({ method: "queryCells", context });
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
      throw new Error("Telegram M19 não pode persistir mensagens nesta fase.");
    },
    writeFollowup: async () => {
      throw new Error("Telegram M19 não pode executar WRITE nesta fase.");
    },
    audit: async () => undefined,
  } satisfies PastoralRepository;
  return { repository, calls };
}

function createAdapter(options: Readonly<{ enabled?: boolean; linked?: readonly TelegramLinkedIdentity[]; events?: TelegramAuditEvent[] }> = {}) {
  const events = options.events ?? [];
  const fixture = repositoryFixture();
  const identityResolver = new InMemoryTelegramIdentityResolver(options.linked ?? [linkedIdentity()], options.enabled ?? true);
  const adapter = new TelegramChannelAdapter({
    repository: fixture.repository,
    identityResolver,
    audit: { record: async event => events.push(event) },
    requestIdFactory: () => "telegram-request-1",
  });
  return { adapter, events, calls: fixture.calls };
}

const validInput = {
  transport: "telegram" as const,
  modality: "text" as const,
  telegramUserId: "tg-user-1",
  telegramChatId: "tg-chat-1",
  text: "Quais células temos?",
};

describe("Telegram M19 synthetic governed channel", () => {
  it("expõe uma policy fechada, readonly e sem ingressão pública", () => {
    expect(TELEGRAM_POLICY).toMatchObject({
      transport: "telegram",
      modality: "text",
      intent: "READ",
      allowedTools: ["consultar_celulas"],
      writeEnabled: false,
      sensitiveEnabled: false,
      publicIngress: false,
    });
  });

  it("executa um READ real com identidade linked, tenant server-side e requestId correlacionado", async () => {
    const fixture = createAdapter();
    const result = await fixture.adapter.handle(validInput);

    expect(result).toMatchObject({
      status: "completed",
      requestId: "telegram-request-1",
      transport: "telegram",
      modality: "text",
      tool: "consultar_celulas",
      provider: "deterministic",
      model: "telegram-read-sandbox-v1",
      content: "Há 2 células ativas no tenant atual.",
    });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0].method).toBe("queryCells");
    expect(fixture.calls[0].context).toMatchObject({ organizationId: 42, userId: 7, role: "admin" });
    expect(fixture.calls[0].context).not.toHaveProperty("telegramUserId");
    expect(fixture.events.map(event => event.action)).toEqual(["telegram.ingress.accepted", "telegram.read.completed"]);
    expect(fixture.events.every(event => event.requestId === "telegram-request-1")).toBe(true);
    expect(JSON.stringify(fixture.events)).not.toContain("não deve sair");
  });

  it("deduplica retry pelo block_id sem repetir o READ", async () => {
    const fixture = createAdapter();
    const first = await fixture.adapter.handle({ ...validInput, blockId: "block-1" });
    const duplicate = await fixture.adapter.handle({ ...validInput, blockId: "block-1" });

    expect(first).toMatchObject({ status: "completed", requestId: "telegram-request-1" });
    expect(duplicate).toMatchObject({ status: "duplicate", reason: "duplicate_block_id" });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.events.filter(event => event.action === "telegram.read.completed")).toHaveLength(1);
  });

  it("nega identidade unlinked antes de consultar o repositório", async () => {
    const fixture = createAdapter({ linked: [] });
    const result = await fixture.adapter.handle(validInput);

    expect(result).toMatchObject({ status: "denied", reason: "identity_not_linked" });
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.events).toContainEqual(expect.objectContaining({ action: "telegram.ingress.denied", reason: "identity_not_linked" }));
  });

  it("nega integração disabled sem revelar se a identidade existe", async () => {
    const fixture = createAdapter({ enabled: false });
    const result = await fixture.adapter.handle(validInput);

    expect(result).toMatchObject({ status: "denied", reason: "integration_disabled" });
    expect(result.content).toBe("A mensagem não pôde ser processada por esta integração.");
    expect(fixture.calls).toHaveLength(0);
  });

  it("nega transport, modality e payload oversized antes do resolver", async () => {
    const fixture = createAdapter();

    await expect(fixture.adapter.handle({ ...validInput, transport: "whatsapp" as never })).resolves.toMatchObject({ status: "denied", reason: "transport_not_allowed" });
    await expect(fixture.adapter.handle({ ...validInput, modality: "voice" as never })).resolves.toMatchObject({ status: "denied", reason: "modality_not_allowed" });
    await expect(fixture.adapter.handle({ ...validInput, text: "x".repeat(4097) })).resolves.toMatchObject({ status: "denied", reason: "text_too_long" });
    expect(fixture.calls).toHaveLength(0);
  });

  it("nega qualquer tentativa de declarar autoridade no payload", async () => {
    const fixture = createAdapter();
    const result = await fixture.adapter.handle({ ...validInput, tenantId: "org:999" });
    const forgedPlatform = await fixture.adapter.handle({ ...validInput, platformCapabilities: ["platform:tenant:assume"] });

    expect(result).toMatchObject({ status: "denied", reason: "untrusted_authority_field:tenantId" });
    expect(forgedPlatform).toMatchObject({ status: "denied", reason: "untrusted_authority_field:platformCapabilities" });
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.events.filter(event => event.action === "telegram.ingress.accepted")).toHaveLength(0);
  });

  it("não persiste mensagem, não chama WRITE e mantém o retorno genérico em falha de READ", async () => {
    const events: TelegramAuditEvent[] = [];
    const fixture = createAdapter({ events });
    fixture.calls.length = 0;
    const result = await fixture.adapter.handle({ ...validInput, text: "Quais células temos?" });

    expect(result.status).toBe("completed");
    expect(fixture.calls.map(call => call.method)).toEqual(["queryCells"]);
    expect(events.some(event => event.action === "telegram.read.completed")).toBe(true);
    expect(events.some(event => event.action.includes("write"))).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/appendMessage|writeFollowup|secret|token/i);
  });
});
