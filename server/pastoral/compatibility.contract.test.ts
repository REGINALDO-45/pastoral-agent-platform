import { describe, expect, it } from "vitest";
import { AgentCore } from "./agentCore";
import { TenantIsolationError, assertTenantScope } from "./policy";
import { pastoralToolCatalog } from "./toolCatalog";
import type { PastoralRepository, TenantContext, ToolResult } from "./types";
import { createVoiceHistoryEntry, VOICE_HISTORY_LABEL } from "./voiceUploadRoute";

const context: TenantContext = {
  organizationId: 41,
  organizationName: "Igreja de Compatibilidade",
  userId: 7,
  userName: "Pessoa Pastoral",
  role: "pastor",
};

class CompatibilityRepository implements PastoralRepository {
  messages: Array<{ role: "user" | "assistant"; content: string; messageType?: "text" | "voice" }> = [];
  audits: Array<{ action: string; requestId?: string; result?: string; confirmationStatus?: string; status: string }> = [];
  writes = 0;

  private result(tool: ToolResult["tool"], data: Record<string, unknown>): ToolResult {
    return { tool, summary: "Evidência autorizada da igreja atual.", data };
  }

  queryCells() {
    return Promise.resolve(this.result("consultar_celulas", {
      cells: [{ name: "Célula Compatibilidade", leader: "Líder Fixture", supervisor: "Supervisor Fixture" }],
    }));
  }
  queryReports() {
    return Promise.resolve(this.result("consultar_relatorios", {
      pendingReports: [{ cellName: "Célula Compatibilidade", weekLabel: "2026-W10" }],
    }));
  }
  queryAttendance() {
    return Promise.resolve(this.result("consultar_presenca", {
      meetings: [], heldCount: 1, missed: [], lowAttendance: [],
    }));
  }
  queryVisitors() {
    return Promise.resolve(this.result("consultar_visitantes", {
      visitors: [{ id: 14, name: "Ana", followedUp: false }],
    }));
  }
  queryLeaders() {
    return Promise.resolve(this.result("consultar_lideres", {
      leaders: [{ name: "Líder Fixture", attentionNote: "Nota de exemplo" }],
    }));
  }
  findVisitor(_context: TenantContext, name: string) { return Promise.resolve(name === "Ana" ? { id: 14, name: "Ana", followedUp: false } : null); }
  appendMessage(input: { role: "user" | "assistant"; content: string; messageType?: "text" | "voice" }) { this.messages.push(input); return Promise.resolve(); }
  writeFollowup() { this.writes += 1; return Promise.resolve({ created: this.writes === 1, visitorName: "Ana" }); }
  audit(input: { action: string; requestId?: string; result?: string; confirmationStatus?: string; status: "success" | "failure" | "denied" }) { this.audits.push(input); return Promise.resolve(); }
}

function createAgent(repository: CompatibilityRepository) {
  return new AgentCore(repository, undefined, async () => pastoralToolCatalog);
}

describe("contratos de compatibilidade pastoral para THÁNOS", () => {
  it("mantém identidade de tenant, resposta READ e auditoria correlacionada", async () => {
    const repository = new CompatibilityRepository();
    const response = await createAgent(repository).respond({
      context,
      conversationId: 50,
      message: "Como estão as células desta semana?",
      requestId: "compat-read-1",
    });

    expect(response).toMatchObject({
      tool: "consultar_celulas",
      requestId: "compat-read-1",
      confirmationStatus: "not_required",
    });
    expect(repository.messages).toHaveLength(2);
    expect(repository.audits).toContainEqual(expect.objectContaining({
      action: "agent.respond",
      requestId: "compat-read-1",
      result: "response_generated",
      confirmationStatus: "not_required",
      status: "success",
    }));
  });

  it("preserva a barreira interorganizacional e o escopo seguro de pergunta sobre igrejas", async () => {
    const repository = new CompatibilityRepository();
    const response = await createAgent(repository).respond({
      context,
      conversationId: 51,
      message: "Quantas igrejas existem?",
      requestId: "compat-scope-1",
    });

    expect(response.tool).toBeUndefined();
    expect(response.content).toContain("Igreja de Compatibilidade");
    expect(response.content).toContain("não contabilizo");
    expect(() => assertTenantScope(context, 42)).toThrow(TenantIsolationError);
  });

  it("preserva privacidade de voz e a máquina de estados de confirmação idempotente", async () => {
    const repository = new CompatibilityRepository();
    const agent = createAgent(repository);
    const recognizedSpeech = "Registre que foi feito contato com Ana";

    await repository.appendMessage(createVoiceHistoryEntry(52, context));
    const prepared = await agent.respond({
      context,
      conversationId: 52,
      message: recognizedSpeech,
      persistUserMessage: false,
      requestId: "compat-prepare-1",
    });
    const first = await agent.confirmFollowup({ context, conversationId: 52, ...prepared.confirmation!, requestId: "compat-confirm-1" });
    const second = await agent.confirmFollowup({ context, conversationId: 52, ...prepared.confirmation!, requestId: "compat-confirm-2" });

    expect(repository.messages[0]).toMatchObject({ content: VOICE_HISTORY_LABEL, messageType: "voice" });
    expect(repository.messages.some(message => message.content.includes(recognizedSpeech))).toBe(false);
    expect(prepared.confirmationStatus).toBe("pending");
    expect(first.confirmationStatus).toBe("confirmed");
    expect(second.confirmationStatus).toBe("duplicate");
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "followup.prepare", requestId: "compat-prepare-1", confirmationStatus: "pending" }));
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "followup.confirm", requestId: "compat-confirm-1", confirmationStatus: "confirmed" }));
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "followup.confirm", requestId: "compat-confirm-2", confirmationStatus: "duplicate" }));
  });
});
