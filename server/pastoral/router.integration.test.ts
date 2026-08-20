import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLogs, conversationMessages, organizationAgentSettings, organizationMemberships, organizationToolSettings, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { appRouter, createAppRouter } from "../routers";
import type { TrpcContext } from "../_core/context";
import { DatabasePastoralRepository } from "./repository";
import { ThanosPilotRouter } from "./thanosPilotRouter";
import { resolveThanosPilotRuntimeConfig } from "./thanosPilotConfig";

function authenticatedContext(): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "gEyVapiwVFwXMYksX5uKiD",
      name: "Reginaldo Medeiros",
      email: "cuecagg@gmail.com",
      loginMethod: "google",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => undefined } as TrpcContext["res"],
  };
}

type TestDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

type MembershipSnapshot = typeof organizationMemberships.$inferSelect;

async function withRestoredMemberships<T>(db: TestDb, userIds: number[], callback: () => Promise<T>) {
  const snapshots: MembershipSnapshot[] = [];
  for (const userId of [...new Set(userIds)]) {
    snapshots.push(...await db.select().from(organizationMemberships).where(eq(organizationMemberships.userId, userId)));
  }

  try {
    return await callback();
  } finally {
    for (const snapshot of snapshots) {
      await db.update(organizationMemberships)
        .set({ role: snapshot.role })
        .where(eq(organizationMemberships.id, snapshot.id));
    }
  }
}

function createPublicPilotCaller(
  config: Record<string, string>,
  options: Readonly<{ failThanos?: boolean }> = {},
) {
  const repository = new DatabasePastoralRepository();
  const legacy = {
    respond: async (input: Readonly<{ context: Awaited<ReturnType<typeof getTenantContextForUser>>; conversationId: number; message: string; persistUserMessage?: boolean; requestId: string }>) => {
      if (input.persistUserMessage !== false) {
        await repository.appendMessage({ conversationId: input.conversationId, context: input.context, role: "user", content: input.message });
      }
      await repository.appendMessage({ conversationId: input.conversationId, context: input.context, role: "assistant", content: "Resposta legado", model: "legacy-test" });
      return { content: "Resposta legado", provider: "legacy", model: "legacy-test", requestId: input.requestId, confirmationStatus: "not_required" as const };
    },
  };
  const thanos = {
    respondRead: async (input: Readonly<{ context: Awaited<ReturnType<typeof getTenantContextForUser>>; conversationId: number; requestId: string; tool: string }>) => {
      if (options.failThanos) throw new Error("falha de execução THÁNOS");
      await repository.appendMessage({ conversationId: input.conversationId, context: input.context, role: "assistant", content: "Resposta THÁNOS", model: "thanos-test", tool: input.tool });
      return { content: "Resposta THÁNOS", provider: "deterministic", model: "thanos-test", tool: input.tool, requestId: input.requestId, confirmationStatus: "not_required" as const };
    },
    respondMultiRead: async (input: Readonly<{ context: Awaited<ReturnType<typeof getTenantContextForUser>>; conversationId: number; requestId: string; tools: readonly string[] }>) => {
      if (options.failThanos) throw new Error("falha de execução THÁNOS");
      const tool = input.tools.join(",");
      await repository.appendMessage({ conversationId: input.conversationId, context: input.context, role: "assistant", content: "Resposta THÁNOS", model: "thanos-test", tool });
      return { content: "Resposta THÁNOS", provider: "deterministic", model: "thanos-test", tool, requestId: input.requestId, confirmationStatus: "not_required" as const };
    },
  };
  const pilotRouter = new ThanosPilotRouter(repository, legacy, thanos, () => resolveThanosPilotRuntimeConfig(config));
  return createAppRouter({ thanosPilotRouter: pilotRouter }).createCaller(authenticatedContext());
}

describe("Consultas pastorais autenticadas", () => {
  it("resolve dashboard, cria conversa e lista mensagens somente no tenant da sessão", async () => {
    const caller = appRouter.createCaller(authenticatedContext());
    const dashboard = await caller.pastoral.dashboard();
    const conversation = await caller.pastoral.currentConversation();
    const messages = await caller.pastoral.messages({ conversationId: conversation.id });

    expect(dashboard.tenant).toMatchObject({ organizationId: 1, organizationName: "Igreja Demonstração A", userId: 1 });
    expect(dashboard.summary.cells).toBeGreaterThan(0);
    expect(dashboard.overview.metrics).toMatchObject({
      activeCells: 4,
      completedCells: 3,
      pendingCells: 2,
      totalAttendance: 31,
      averageAttendancePerCell: expect.closeTo(10.3, 1),
      visitors: 3,
      registeredPeople: 3,
      leaders: 4,
    });
    expect(dashboard.overview.pending).toMatchObject({ pendingReports: 2, missedMeetings: 1, visitorsWithoutFollowup: 2, leadersRequiringAttention: 2 });
    expect(dashboard.overview.intelligence.generativeStatus).toBe("unavailable");
    expect(conversation.organizationId).toBe(dashboard.tenant.organizationId);
    expect(Array.isArray(messages)).toBe(true);
  });

  it("impede que o tenant B leia a conversa e os dados do tenant A", async () => {
    const callerA = appRouter.createCaller(authenticatedContext());
    const conversationA = await callerA.pastoral.currentConversation();
    const db = await getDb();
    if (!db) throw new Error("Banco de teste indisponível.");
    await db.insert(conversationMessages).values({
      conversationId: conversationA.id,
      organizationId: 1,
      userId: 1,
      role: "user",
      messageType: "voice",
      content: "Mensagem de voz enviada.",
      model: "voice-input-v1",
    });
    const messagesA = await callerA.pastoral.messages({ conversationId: conversationA.id });
    const sameChurchUser = (await db.select().from(users).where(eq(users.openId, "router-test-same-org-user")).limit(1))[0] ?? (await db.insert(users).values({ openId: "router-test-same-org-user", name: "Usuário sintético da mesma organização", email: "router-test-same-org-user@example.test", loginMethod: "test", role: "user" }).then(async () => (await db.select().from(users).where(eq(users.openId, "router-test-same-org-user")).limit(1))[0]));
    const demoPastorB = (await db.select().from(users).where(eq(users.openId, "demo-pastor-b")).limit(1))[0];
    if (!sameChurchUser) throw new Error("Usuário da mesma organização não pôde ser criado ou recuperado.");
    if (!demoPastorB) throw new Error("Usuário do tenant B não foi semeado.");
    await db.insert(organizationMemberships).values({ organizationId: conversationA.organizationId, userId: sameChurchUser.id, role: "pastor" }).onDuplicateKeyUpdate({ set: { role: "pastor" } });
    expect(sameChurchUser.id).not.toBe(conversationA.userId);
    const callerSameChurch = appRouter.createCaller({
      ...authenticatedContext(),
      user: { ...authenticatedContext().user!, id: sameChurchUser.id, openId: sameChurchUser.openId, name: sameChurchUser.name, role: "user" },
    });
    const callerB = appRouter.createCaller({
      ...authenticatedContext(),
      user: { ...authenticatedContext().user!, id: demoPastorB.id, openId: demoPastorB.openId, name: demoPastorB.name, role: "user" },
    });
    const dashboardB = await callerB.pastoral.dashboard();

    expect(dashboardB.tenant.organizationName).toBe("Igreja Demonstração B");
    expect(dashboardB.summary.cells).toBe(1);
    expect(dashboardB.overview.metrics).toMatchObject({ activeCells: 1, totalAttendance: 16, registeredPeople: 0, leaders: 1 });
    expect(dashboardB.overview.pending).toMatchObject({ pendingReports: 0, visitorsWithoutFollowup: 1 });
    expect(messagesA).toContainEqual(expect.objectContaining({ role: "user", messageType: "voice", content: "Mensagem de voz enviada." }));
    await expect(callerSameChurch.pastoral.messages({ conversationId: conversationA.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerB.pastoral.messages({ conversationId: conversationA.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("persiste configuração do Gateway pelo admin, a resolve por tenant e nunca devolve segredos", async () => {
    const db = await getDb();
    if (!db) throw new Error("Banco de teste indisponível.");
    const demoPastorB = (await db.select().from(users).where(eq(users.openId, "demo-pastor-b")).limit(1))[0];
    if (!demoPastorB) throw new Error("Usuário do tenant B não foi semeado.");

    await withRestoredMemberships(db, [1, demoPastorB.id], async () => {
      await db.update(organizationMemberships).set({ role: "admin" }).where(eq(organizationMemberships.userId, 1));
      const adminCaller = appRouter.createCaller(authenticatedContext());
      const callerB = appRouter.createCaller({
        ...authenticatedContext(),
        user: { ...authenticatedContext().user!, id: demoPastorB.id, openId: demoPastorB.openId, name: demoPastorB.name, role: "user" },
      });

      const updatedA = await adminCaller.pastoral.updateAgentSettings({
        enabled: true,
        provider: "legacy",
        model: "tenant-a-safe-model",
        fallbackPolicy: "deterministic",
      });
      await db.insert(organizationAgentSettings).values({
        organizationId: 2,
        enabled: false,
        provider: "hermes",
        model: "tenant-b-isolated-model",
        fallbackPolicy: "deterministic",
        updatedByUserId: demoPastorB.id,
      }).onDuplicateKeyUpdate({
        set: { enabled: false, provider: "hermes", model: "tenant-b-isolated-model", fallbackPolicy: "deterministic", updatedByUserId: demoPastorB.id, updatedAt: new Date() },
      });

      await db.update(organizationMemberships).set({ role: "admin" }).where(eq(organizationMemberships.userId, demoPastorB.id));

      const storedB = (await db.select().from(organizationAgentSettings).where(eq(organizationAgentSettings.organizationId, 2)).limit(1))[0];
      const resolvedA = await adminCaller.pastoral.agentSettings();
      const resolvedB = await callerB.pastoral.agentSettings();
      const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "agent_gateway.settings.update"));

      expect(updatedA).toMatchObject({ status: "online", provider: "legacy", model: "tenant-a-safe-model", source: "organization" });
      expect(storedB).toMatchObject({ enabled: false, provider: "hermes", model: "tenant-b-isolated-model" });
      expect(resolvedA).toMatchObject({ provider: "legacy", model: "tenant-a-safe-model", source: "organization" });
      expect(resolvedB).toMatchObject({ status: "disabled", provider: "legacy", model: "tenant-b-isolated-model", source: "organization", hermes: { enabled: false } });
      expect(JSON.stringify(resolvedA)).not.toMatch(/key|token|url/i);
      expect(audits.some(entry => entry.organizationId === 1 && entry.userId === 1)).toBe(true);
      await expect(callerB.pastoral.updateAgentSettings({ enabled: true, provider: "legacy", model: "denied-model", fallbackPolicy: "deterministic" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  it("expõe o catálogo de ferramentas pelo tenant autenticado sem detalhes internos", async () => {
    const db = await getDb();
    if (!db) throw new Error("Banco de teste indisponível.");

    await withRestoredMemberships(db, [1], async () => {
      await db.update(organizationMemberships).set({ role: "admin" }).where(eq(organizationMemberships.userId, 1));
      const caller = appRouter.createCaller(authenticatedContext());
      const catalog = await caller.pastoral.toolCatalog();

      expect(catalog).toContainEqual(expect.objectContaining({ name: "consultar_celulas", category: "READ" }));
      expect(catalog).toContainEqual(expect.objectContaining({ name: "registrar_acompanhamento_visitante", requiresConfirmation: true }));
      expect(JSON.stringify(catalog)).not.toMatch(/execute|repository|secret|token|key|url|organizationId/i);
    });
  });

  it("protege o status de integrações e audita o teste Hermes sem revelar segredos", async () => {
    const db = await getDb();
    if (!db) throw new Error("Banco de teste indisponível.");
    const demoPastorB = (await db.select().from(users).where(eq(users.openId, "demo-pastor-b")).limit(1))[0];
    if (!demoPastorB) throw new Error("Usuário do tenant B não foi semeado.");

    await withRestoredMemberships(db, [1, demoPastorB.id], async () => {
      await db.update(organizationMemberships).set({ role: "admin" }).where(eq(organizationMemberships.userId, 1));
      await db.update(organizationMemberships).set({ role: "pastor" }).where(eq(organizationMemberships.userId, demoPastorB.id));
      const adminCaller = appRouter.createCaller(authenticatedContext());
      const callerB = appRouter.createCaller({
        ...authenticatedContext(),
        user: { ...authenticatedContext().user!, id: demoPastorB.id, openId: demoPastorB.openId, name: demoPastorB.name, role: "user" },
      });

      const status = await adminCaller.pastoral.integrationStatus();
      const probe = await adminCaller.pastoral.testHermes();

      expect(status).toMatchObject({ n8n: { enabled: false, status: "disabled", allowedWorkflows: [] }, hermes: { hermes: { connection: expect.any(String) } } });
      expect(probe).toMatchObject({ connection: expect.any(String), attempts: expect.any(Number) });
      expect(JSON.stringify({ status, probe })).not.toMatch(/api.?key|base.?url|token|secret/i);
      await expect(callerB.pastoral.integrationStatus()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(callerB.pastoral.testHermes()).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  it("persiste a habilitação somente para a organização do administrador e bloqueia mudanças por papéis não administrativos", async () => {
    const db = await getDb();
    if (!db) throw new Error("Banco de teste indisponível.");
    const demoPastorB = (await db.select().from(users).where(eq(users.openId, "demo-pastor-b")).limit(1))[0];
    if (!demoPastorB) throw new Error("Usuário do tenant B não foi semeado.");

    await withRestoredMemberships(db, [1, demoPastorB.id], async () => {
      await db.update(organizationMemberships).set({ role: "admin" }).where(eq(organizationMemberships.userId, 1));
      await db.update(organizationMemberships).set({ role: "pastor" }).where(eq(organizationMemberships.userId, demoPastorB.id));
      const adminCaller = appRouter.createCaller(authenticatedContext());
      const callerB = appRouter.createCaller({
        ...authenticatedContext(),
        user: { ...authenticatedContext().user!, id: demoPastorB.id, openId: demoPastorB.openId, name: demoPastorB.name, role: "user" },
      });

      const updatedA = await adminCaller.pastoral.updateToolStatus({ name: "consultar_celulas", enabled: false });
      await expect(callerB.pastoral.toolCatalog()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await db.update(organizationMemberships).set({ role: "admin" }).where(eq(organizationMemberships.userId, demoPastorB.id));
      const catalogB = await callerB.pastoral.toolCatalog();
      const setting = (await db.select().from(organizationToolSettings).where(eq(organizationToolSettings.organizationId, 1)).limit(1))[0];
      const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "agent_tool.settings.update"));

      expect(updatedA).toContainEqual(expect.objectContaining({ name: "consultar_celulas", enabled: false }));
      expect(catalogB).toContainEqual(expect.objectContaining({ name: "consultar_celulas", enabled: true }));
      expect(setting).toMatchObject({ organizationId: 1, toolName: "consultar_celulas", enabled: false, updatedByUserId: 1 });
      expect(audits.some(entry => entry.organizationId === 1 && entry.userId === 1 && entry.tool === "consultar_celulas")).toBe(true);
      await db.update(organizationMemberships).set({ role: "pastor" }).where(eq(organizationMemberships.userId, demoPastorB.id));
      await expect(callerB.pastoral.updateToolStatus({ name: "consultar_celulas", enabled: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  it("expõe a visão administrativa sanitizada apenas ao admin da própria organização", async () => {
    const db = await getDb();
    if (!db) throw new Error("Banco de teste indisponível.");
    const demoPastorB = (await db.select().from(users).where(eq(users.openId, "demo-pastor-b")).limit(1))[0];
    if (!demoPastorB) throw new Error("Usuário do tenant B não foi semeado.");

    await withRestoredMemberships(db, [1, demoPastorB.id], async () => {
      await db.update(organizationMemberships).set({ role: "admin" }).where(eq(organizationMemberships.userId, 1));
      await db.update(organizationMemberships).set({ role: "pastor" }).where(eq(organizationMemberships.userId, demoPastorB.id));
      const adminCaller = appRouter.createCaller(authenticatedContext());
      const callerB = appRouter.createCaller({
        ...authenticatedContext(),
        user: { ...authenticatedContext().user!, id: demoPastorB.id, openId: demoPastorB.openId, name: demoPastorB.name, role: "user" },
      });

      const access = await adminCaller.pastoral.settingsAccess();
      const overview = await adminCaller.pastoral.settingsOverview();
      const restrictedAccess = await callerB.pastoral.settingsAccess();

      expect(access).toEqual({ allowed: true, role: "admin" });
      expect(overview.organization).toMatchObject({ name: "Igreja Demonstração A", role: "admin" });
      expect(overview.users.length).toBeGreaterThan(0);
      expect(overview.voice).toMatchObject({ provider: "Transcrição integrada" });
      expect(overview.auditEvents.every(event => /^audit-\d+$/.test(event.eventKey))).toBe(true);
      expect(new Set(overview.auditEvents.map(event => event.eventKey)).size).toBe(overview.auditEvents.length);
      expect(JSON.stringify(overview)).not.toMatch(/api.?key|base.?url|token|secret|metadata/i);
      expect(restrictedAccess).toEqual({ allowed: false, role: "pastor" });
      await expect(callerB.pastoral.settingsOverview()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(callerB.pastoral.agentSettings()).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  it("persiste requestId, provedor, resultado e confirmação na auditoria sem cruzar organizações", async () => {
    const caller = appRouter.createCaller(authenticatedContext());
    const db = await getDb();
    if (!db) throw new Error("Banco de teste indisponível.");
    const conversation = await caller.pastoral.currentConversation();
    const response = await caller.pastoral.sendMessage({ conversationId: conversation.id, content: "Quantas igrejas existem?" });
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.requestId, response.requestId!));
    const coreLog = logs.find(log => log.action === "agent.respond");
    const gatewayLog = logs.find(log => log.action === "agent_gateway.respond");

    expect(response).toMatchObject({ confirmationStatus: "not_required" });
    expect(coreLog).toMatchObject({ organizationId: 1, userId: 1, provider: "deterministic", result: "organization_scope_protected", confirmationStatus: "not_required", status: "success" });
    expect(gatewayLog).toMatchObject({ organizationId: 1, userId: 1, provider: "legacy", result: "gateway_response", confirmationStatus: "not_required", status: "success" });
    expect(logs.every(log => log.organizationId === 1 && log.requestId === response.requestId)).toBe(true);
  });

  it("exercita a mutation pública para piloto desligado, elegível, audiência/intenção não elegível, fallback e kill switch sem duplicar histórico", async () => {
    const baseCaller = appRouter.createCaller(authenticatedContext());
    const conversation = await baseCaller.pastoral.currentConversation();
    const sendAndCount = async (caller: ReturnType<typeof createPublicPilotCaller>, content: string) => {
      const before = await caller.pastoral.messages({ conversationId: conversation.id });
      const response = await caller.pastoral.sendMessage({ conversationId: conversation.id, content });
      const after = await caller.pastoral.messages({ conversationId: conversation.id });
      expect(after).toHaveLength(before.length + 2);
      expect(after.slice(-2).map(message => message.role)).toEqual(["user", "assistant"]);
      return response;
    };

    const disabled = createPublicPilotCaller({ enabled: "false", killSwitch: "false", organizationIds: "1", userIds: "1", version: "mutation-test" });
    await expect(sendAndCount(disabled, "Quais células temos?")).resolves.not.toHaveProperty("thanos");

    const eligible = createPublicPilotCaller({ enabled: "true", killSwitch: "false", organizationIds: "1", userIds: "1", version: "mutation-test" });
    await expect(sendAndCount(eligible, "Mostre um resumo de células, presença e relatórios")).resolves.toMatchObject({
      thanos: { mode: "multi_read", tools: ["consultar_celulas", "consultar_presenca", "consultar_relatorios"], fallback: false },
    });

    const outsideAudience = createPublicPilotCaller({ enabled: "true", killSwitch: "false", organizationIds: "2", userIds: "1", version: "mutation-test" });
    await expect(sendAndCount(outsideAudience, "Quais células temos?")).resolves.not.toHaveProperty("thanos");

    await expect(sendAndCount(eligible, "Registre acompanhamento de visitante")).resolves.not.toHaveProperty("thanos");

    const fallback = createPublicPilotCaller({ enabled: "true", killSwitch: "false", organizationIds: "1", userIds: "1", version: "mutation-test" }, { failThanos: true });
    await expect(sendAndCount(fallback, "Quais células temos?")).resolves.toMatchObject({ thanos: { fallback: true, fallbackReason: "thanos_error" } });

    const killed = createPublicPilotCaller({ enabled: "true", killSwitch: "true", organizationIds: "1", userIds: "1", version: "mutation-test" });
    await expect(sendAndCount(killed, "Quais células temos?")).resolves.not.toHaveProperty("thanos");
  });
});
