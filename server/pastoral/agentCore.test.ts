import { describe, expect, it } from "vitest";
import { AgentCore } from "./agentCore";
import { AuthorizationError } from "./policy";
import { pastoralToolCatalog } from "./toolCatalog";
import type { ModelGenerationInput, ModelGenerationResult } from "./modelRouter";
import type { PastoralRepository, TenantContext, ToolCatalogEntry, ToolResult } from "./types";
import { createVoiceHistoryEntry, VOICE_HISTORY_LABEL } from "./voiceUploadRoute";

const context: TenantContext = { organizationId: 1, organizationName: "Igreja Demonstração A", userId: 1, userName: "Pastor Samuel", role: "pastor" };

const PII_VISITOR_NAME_DO_NOT_SEND = "PII_VISITOR_NAME_DO_NOT_SEND";
const PII_LEADER_NAME_DO_NOT_SEND = "PII_LEADER_NAME_DO_NOT_SEND";
const PII_ATTENTION_NOTE_DO_NOT_SEND = "PII_ATTENTION_NOTE_DO_NOT_SEND";
const PII_SUPERVISOR_NAME_DO_NOT_SEND = "PII_SUPERVISOR_NAME_DO_NOT_SEND";
const PII_PERSON_ID_DO_NOT_SEND = 999_001;

class FakeRepository implements PastoralRepository {
  audits: Array<{ action: string; status: string; tool?: string; provider?: string; model?: string; requestId?: string; result?: string; confirmationStatus?: string }> = [];
  messages: Array<{ role: string; content: string; messageType?: string }> = [];
  readTools: string[] = [];
  followups = 0;
  private toolResult(tool: ToolResult["tool"], data: Record<string, unknown>): ToolResult {
    return { tool, summary: "Resumo autorizado da Igreja Demonstração A.", data };
  }
  queryCells() {
    this.readTools.push("consultar_celulas");
    return Promise.resolve(this.toolResult("consultar_celulas", {
      cells: [{ name: "Célula Alfa", leader: PII_LEADER_NAME_DO_NOT_SEND, supervisor: PII_SUPERVISOR_NAME_DO_NOT_SEND }],
    }));
  }
  queryReports() {
    this.readTools.push("consultar_relatorios");
    return Promise.resolve(this.toolResult("consultar_relatorios", {
      pendingReports: [{ cellName: "Célula Alfa", weekLabel: "2026-W10" }],
    }));
  }
  queryAttendance() {
    this.readTools.push("consultar_presenca");
    return Promise.resolve(this.toolResult("consultar_presenca", {
      meetings: [], heldCount: 1, missed: ["Célula Beta"], lowAttendance: [],
    }));
  }
  queryVisitors() {
    this.readTools.push("consultar_visitantes");
    return Promise.resolve({
      tool: "consultar_visitantes" as const,
      summary: `Ainda aguardam acompanhamento: **${PII_VISITOR_NAME_DO_NOT_SEND}**.`,
      data: { visitors: [{ id: PII_PERSON_ID_DO_NOT_SEND, name: PII_VISITOR_NAME_DO_NOT_SEND, followedUp: false }] },
    });
  }
  queryLeaders() {
    this.readTools.push("consultar_lideres");
    return Promise.resolve({
      tool: "consultar_lideres" as const,
      summary: `Líderes que merecem atenção: **${PII_LEADER_NAME_DO_NOT_SEND}** — ${PII_ATTENTION_NOTE_DO_NOT_SEND}.`,
      data: { leaders: [{ name: PII_LEADER_NAME_DO_NOT_SEND, attentionNote: PII_ATTENTION_NOTE_DO_NOT_SEND }] },
    });
  }
  findVisitor(_context: TenantContext, name: string) { return Promise.resolve(name === "João" ? { id: 21, name: "João", followedUp: false } : null); }
  appendMessage(input: { role: "user" | "assistant"; content: string; messageType?: "text" | "voice" }) { this.messages.push(input); return Promise.resolve(); }
  writeFollowup() { this.followups += 1; return Promise.resolve({ created: this.followups === 1, visitorName: "João" }); }
  audit(input: { action: string; status: "success" | "failure" | "denied"; tool?: string; provider?: string; model?: string; requestId?: string; result?: string; confirmationStatus?: "not_required" | "pending" | "confirmed" | "duplicate" | "denied" | "failed" }) { this.audits.push(input); return Promise.resolve(); }
}

class SpyModelGenerator {
  calls: ModelGenerationInput[] = [];
  async generate(input: ModelGenerationInput): Promise<ModelGenerationResult> {
    this.calls.push(input);
    return { content: `Resposta externa sobre: ${input.user}`, provider: "hermes", model: "hermes-pilot" };
  }
}

describe("Agent Core pastoral", () => {
  it("responde por ferramenta autorizada e audita sem expor raciocínio", async () => {
    const repository = new FakeRepository();
    const agent = new AgentCore(repository);
    const result = await agent.respond({ context, conversationId: 4, message: "Quais células realizaram reunião esta semana?", requestId: "request-read" });
    expect(result.tool).toBe("consultar_presenca");
    expect(result.content).toContain("Resumo autorizado");
    expect(result).toMatchObject({ requestId: "request-read", confirmationStatus: "not_required" });
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "agent.respond", status: "success", tool: "consultar_presenca", provider: "deterministic", requestId: "request-read", result: "response_generated", confirmationStatus: "not_required" }));
    expect(repository.messages).toHaveLength(2);
  });

  it("não confunde quantidade de igrejas com quantidade de células", async () => {
    const repository = new FakeRepository();
    const agent = new AgentCore(repository);

    const result = await agent.respond({ context, conversationId: 4, message: "Quantas igrejas existem?" });

    expect(result.tool).toBeUndefined();
    expect(result.content).toContain("Igreja Demonstração A");
    expect(result.content).toContain("não contabilizo");
    expect(repository.readTools).toEqual([]);
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "agent.respond", status: "success" }));
  });

  it("mantém a transcrição de voz interna e registra somente a resposta do agente", async () => {
    const repository = new FakeRepository();
    const agent = new AgentCore(repository);

    await agent.respond({
      context,
      conversationId: 4,
      message: "Quantas células realizaram reunião esta semana?",
      persistUserMessage: false,
    });

    expect(repository.messages).toHaveLength(1);
    expect(repository.messages[0]).toMatchObject({ role: "assistant" });
    expect(repository.messages.some(message => message.content.includes("Quantas células"))).toBe(false);
  });

  it("mantém o marcador privado de voz antes da resposta sem persistir a fala reconhecida", async () => {
    const repository = new FakeRepository();
    const agent = new AgentCore(repository);
    const recognizedSpeech = "Quantas células realizaram reunião esta semana?";

    await repository.appendMessage(createVoiceHistoryEntry(4, context));
    await agent.respond({ context, conversationId: 4, message: recognizedSpeech, persistUserMessage: false });

    expect(repository.messages).toHaveLength(2);
    expect(repository.messages[0]).toMatchObject({ role: "user", messageType: "voice", content: VOICE_HISTORY_LABEL });
    expect(repository.messages[1]).toMatchObject({ role: "assistant" });
    expect(repository.messages.some(message => message.content.includes(recognizedSpeech))).toBe(false);
  });

  it("exige confirmação e mantém idempotência da Write Tool", async () => {
    const repository = new FakeRepository();
    const agent = new AgentCore(repository);
    const prepared = await agent.respond({ context, conversationId: 4, message: "Registre que o pastor entrou em contato com João hoje.", requestId: "request-prepare" });
    expect(prepared.confirmation?.visitorName).toBe("João");
    expect(prepared).toMatchObject({ requestId: "request-prepare", confirmationStatus: "pending" });
    expect(repository.followups).toBe(0);
    const first = await agent.confirmFollowup({ context, conversationId: 4, ...prepared.confirmation!, requestId: "request-confirm" });
    const second = await agent.confirmFollowup({ context, conversationId: 4, ...prepared.confirmation!, requestId: "request-confirm-retry" });
    expect(first.content).toContain("registrado com sucesso");
    expect(second.content).toContain("já havia sido registrado");
    expect(first).toMatchObject({ requestId: "request-confirm", confirmationStatus: "confirmed" });
    expect(second).toMatchObject({ requestId: "request-confirm-retry", confirmationStatus: "duplicate" });
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "followup.prepare", requestId: "request-prepare", result: "confirmation_prepared", confirmationStatus: "pending" }));
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "followup.confirm", requestId: "request-confirm", result: "followup_registered", confirmationStatus: "confirmed" }));
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "followup.confirm", requestId: "request-confirm-retry", result: "followup_duplicate", confirmationStatus: "duplicate" }));
    expect(repository.followups).toBe(2);
  });

  it("nega escrita a líder e audita a recusa", async () => {
    const repository = new FakeRepository();
    const agent = new AgentCore(repository);
    await expect(agent.respond({ context: { ...context, role: "leader" }, conversationId: 4, message: "Registre que o pastor entrou em contato com João hoje." })).rejects.toThrow(AuthorizationError);
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "followup.prepare", status: "denied", result: "role_not_authorized", confirmationStatus: "denied" }));
  });

  it("responde com indisponibilidade segura quando uma ferramenta READ está desabilitada", async () => {
    const repository = new FakeRepository();
    const disabledCatalog: ToolCatalogEntry[] = pastoralToolCatalog.map(entry => (
      entry.name === "consultar_celulas" ? { ...entry, enabled: false } : entry
    ));
    const agent = new AgentCore(repository, undefined, async () => disabledCatalog);

    const result = await agent.respond({ context, conversationId: 4, message: "Como estão as células desta semana?" });

    expect(repository.readTools).toEqual([]);
    expect(result.content).toContain("temporariamente indisponível");
    expect(repository.messages).toHaveLength(2);
    expect(repository.messages.at(-1)).toMatchObject({ role: "assistant", content: expect.stringContaining("temporariamente indisponível") });
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "agent.tool.execute", status: "denied", tool: "consultar_celulas", result: "tool_disabled", confirmationStatus: "not_required" }));
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "agent.respond", status: "success", tool: "consultar_celulas", result: "tool_unavailable_response" }));
  });

  it("recusa consulta sensível a papel não autorizado antes de acessar o repositório", async () => {
    const repository = new FakeRepository();
    const agent = new AgentCore(repository);

    await expect(agent.respond({ context: { ...context, role: "leader" }, conversationId: 4, message: "Quais visitantes precisam de acompanhamento?" })).rejects.toThrow(AuthorizationError);

    expect(repository.readTools).toEqual([]);
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "agent.tool.execute", status: "denied", tool: "consultar_visitantes" }));
  });

  describe("proteção de PII pastoral contra provider externo", () => {
    it("nunca envia PII_VISITOR_NAME_DO_NOT_SEND ao provider externo e responde localmente", async () => {
      const repository = new FakeRepository();
      const generator = new SpyModelGenerator();
      const agent = new AgentCore(repository);

      const result = await agent.respond({ context, conversationId: 4, message: "Quais visitantes precisam de acompanhamento?", requestId: "request-visitantes", modelGenerator: generator });

      expect(generator.calls).toHaveLength(0);
      expect(repository.readTools).toEqual(["consultar_visitantes"]);
      expect(result).toMatchObject({ tool: "consultar_visitantes", provider: "deterministic", requestId: "request-visitantes", confirmationStatus: "not_required" });
      expect(result.content).toContain(PII_VISITOR_NAME_DO_NOT_SEND);
      expect(repository.audits).toContainEqual(expect.objectContaining({ action: "agent.respond", status: "success", tool: "consultar_visitantes", provider: "deterministic", requestId: "request-visitantes", result: "no_safe_evidence_projection" }));
    });

    it("nunca envia PII_LEADER_NAME_DO_NOT_SEND nem PII_ATTENTION_NOTE_DO_NOT_SEND ao provider externo e responde localmente", async () => {
      const repository = new FakeRepository();
      const generator = new SpyModelGenerator();
      const agent = new AgentCore(repository);

      const result = await agent.respond({ context, conversationId: 4, message: "Quais líderes precisam de atenção?", requestId: "request-lideres", modelGenerator: generator });

      expect(generator.calls).toHaveLength(0);
      expect(repository.readTools).toEqual(["consultar_lideres"]);
      expect(result).toMatchObject({ tool: "consultar_lideres", provider: "deterministic", requestId: "request-lideres" });
      expect(result.content).toContain(PII_LEADER_NAME_DO_NOT_SEND);
      expect(result.content).toContain(PII_ATTENTION_NOTE_DO_NOT_SEND);
    });

    it("envia apenas evidência agregada segura ao provider externo para consultar_celulas, sem PII_LEADER_NAME_DO_NOT_SEND", async () => {
      const repository = new FakeRepository();
      const generator = new SpyModelGenerator();
      const agent = new AgentCore(repository);

      const result = await agent.respond({ context, conversationId: 4, message: "Como estão as células desta semana?", requestId: "request-celulas", modelGenerator: generator });

      expect(generator.calls).toHaveLength(1);
      const sentPayload = JSON.stringify(generator.calls[0]);
      expect(sentPayload).not.toContain(PII_LEADER_NAME_DO_NOT_SEND);
      expect(sentPayload).not.toContain(PII_SUPERVISOR_NAME_DO_NOT_SEND);
      expect(sentPayload).toContain("Célula Alfa");
      expect(result.content).toContain("Célula Alfa");
    });

    it("envia apenas evidência agregada segura ao provider externo para consultar_relatorios", async () => {
      const repository = new FakeRepository();
      const generator = new SpyModelGenerator();
      const agent = new AgentCore(repository);

      await agent.respond({ context, conversationId: 4, message: "Quais relatórios não entregaram?", requestId: "request-relatorios", modelGenerator: generator });

      expect(generator.calls).toHaveLength(1);
      expect(generator.calls[0].user).toContain("Célula Alfa");
    });

    it("envia apenas evidência agregada segura ao provider externo para consultar_presenca", async () => {
      const repository = new FakeRepository();
      const generator = new SpyModelGenerator();
      const agent = new AgentCore(repository);

      await agent.respond({ context, conversationId: 4, message: "Quais células realizaram reunião esta semana?", requestId: "request-presenca", modelGenerator: generator });

      expect(generator.calls).toHaveLength(1);
      expect(generator.calls[0].user).toContain("Célula Beta");
    });

    it("não reexecuta a ferramenta READ ao decidir não chamar o provider externo", async () => {
      const repository = new FakeRepository();
      const generator = new SpyModelGenerator();
      const agent = new AgentCore(repository);

      await agent.respond({ context, conversationId: 4, message: "Quais visitantes precisam de acompanhamento?", requestId: "request-single-read", modelGenerator: generator });

      expect(repository.readTools).toEqual(["consultar_visitantes"]);
    });

    it("preserva o requestId informado mesmo no caminho fail-closed", async () => {
      const repository = new FakeRepository();
      const agent = new AgentCore(repository);

      const result = await agent.respond({ context, conversationId: 4, message: "Quais líderes precisam de atenção?", requestId: "request-fixed-id" });

      expect(result.requestId).toBe("request-fixed-id");
    });
  });
});
