import { randomUUID } from "node:crypto";
import { ModelRouter, type ModelGenerationInput, type ModelGenerationResult } from "./modelRouter";
import { assertToolExecutionPermission, ToolUnavailableError } from "./policy";
import { buildSafeExternalEvidence } from "./safeExternalEvidence";
import { getToolCatalogEntry } from "./toolCatalog";
import { getTenantToolCatalog } from "./tenantToolConfig";
import { chooseReadTool, executeReadTool, extractVisitorName, isFollowupIntent, isOrganizationCountIntent } from "./toolRegistry";
import type { AgentResponse, PastoralRepository, TenantContext, ToolCatalogEntry } from "./types";

const AGENT_NAME = "assistente-pastoral";

export class AgentCore {
  constructor(
    private readonly repository: PastoralRepository,
    private readonly modelRouter = new ModelRouter(),
    private readonly resolveToolCatalog: (context: TenantContext) => Promise<readonly ToolCatalogEntry[]> = getTenantToolCatalog,
  ) {}

  async respond(input: {
    context: TenantContext;
    conversationId: number;
    message: string;
    persistUserMessage?: boolean;
    requestId?: string;
    modelGenerator?: { generate(input: ModelGenerationInput): Promise<ModelGenerationResult> };
  }): Promise<AgentResponse> {
    const { context, conversationId, message } = input;
    const requestId = input.requestId ?? randomUUID();
    if (input.persistUserMessage !== false) {
      await this.repository.appendMessage({ conversationId, context, role: "user", content: message });
    }

    if (isFollowupIntent(message)) {
      try {
        const toolCatalog = await this.resolveToolCatalog(context);
        assertToolExecutionPermission(context, getToolCatalogEntry("registrar_acompanhamento_visitante", toolCatalog));
      } catch (error) {
        await this.repository.audit({
          context,
          action: "followup.prepare",
          agent: AGENT_NAME,
          provider: "deterministic",
          model: "pastoral-rules-v1",
          tool: "registrar_acompanhamento_visitante",
          requestId,
          result: error instanceof ToolUnavailableError ? "tool_disabled" : "role_not_authorized",
          confirmationStatus: "denied",
          status: "denied",
          metadata: { reason: error instanceof ToolUnavailableError ? "tool_disabled" : "role_not_allowed" },
        });
        throw error;
      }
      const visitorName = extractVisitorName(message);
      const visitor = visitorName ? await this.repository.findVisitor(context, visitorName) : null;
      if (!visitor) {
        const content = "Não consegui identificar um visitante desta igreja pelo nome informado. Informe o nome completo para preparar o acompanhamento.";
        await this.repository.appendMessage({ conversationId, context, role: "assistant", content, model: "pastoral-rules-v1" });
        await this.repository.audit({ context, action: "followup.prepare", agent: AGENT_NAME, provider: "deterministic", model: "pastoral-rules-v1", requestId, result: "visitor_not_found", confirmationStatus: "failed", status: "failure" });
        return { content, provider: "deterministic", model: "pastoral-rules-v1", requestId, confirmationStatus: "failed" };
      }
      const note = `Acompanhamento solicitado por ${context.userName}: ${message}`;
      const content = `Encontrei **${visitor.name}**. Posso registrar este acompanhamento agora? A confirmação gravará uma única operação auditável.`;
      const idempotencyKey = randomUUID();
      await this.repository.appendMessage({ conversationId, context, role: "assistant", content, model: "pastoral-rules-v1", tool: "registrar_acompanhamento_visitante" });
      await this.repository.audit({ context, action: "followup.prepare", agent: AGENT_NAME, provider: "deterministic", model: "pastoral-rules-v1", tool: "registrar_acompanhamento_visitante", requestId, result: "confirmation_prepared", confirmationStatus: "pending", status: "success", metadata: { visitorId: visitor.id } });
      return {
        content,
        provider: "deterministic",
        model: "pastoral-rules-v1",
        tool: "registrar_acompanhamento_visitante",
        requestId,
        confirmationStatus: "pending",
        confirmation: { visitorId: visitor.id, visitorName: visitor.name, note, idempotencyKey },
      };
    }

    if (isOrganizationCountIntent(message)) {
      const content = `Você está consultando a **${context.organizationName}**. Para preservar a privacidade entre organizações, eu não contabilizo nem revelo outras igrejas. Posso informar dados autorizados da igreja atual, como células, relatórios, presença, visitantes e líderes.`;
      await this.repository.appendMessage({ conversationId, context, role: "assistant", content, model: "pastoral-rules-v1" });
      await this.repository.audit({
        context,
        action: "agent.respond",
        agent: AGENT_NAME,
        model: "pastoral-rules-v1",
        provider: "deterministic",
        requestId,
        result: "organization_scope_protected",
        confirmationStatus: "not_required",
        status: "success",
        metadata: { provider: "deterministic", intent: "organization_count_out_of_scope" },
      });
      return { content, provider: "deterministic", model: "pastoral-rules-v1", requestId, confirmationStatus: "not_required" };
    }

    const tool = chooseReadTool(message);
    let toolResult;
    try {
      const toolCatalog = await this.resolveToolCatalog(context);
      toolResult = await executeReadTool(this.repository, context, tool, toolCatalog);
    } catch (error) {
      await this.repository.audit({
        context,
        action: "agent.tool.execute",
        agent: AGENT_NAME,
        tool,
        provider: "deterministic",
        model: "pastoral-rules-v1",
        requestId,
        result: error instanceof ToolUnavailableError ? "tool_disabled" : "role_not_authorized",
        confirmationStatus: "not_required",
        status: "denied",
        metadata: { reason: error instanceof ToolUnavailableError ? "tool_disabled" : "role_not_allowed" },
      });
      if (error instanceof ToolUnavailableError) {
        const content = "Esta consulta está temporariamente indisponível para esta igreja. Tente novamente mais tarde ou fale com um administrador para verificar as ferramentas autorizadas.";
        await this.repository.appendMessage({ conversationId, context, role: "assistant", content, model: "pastoral-rules-v1", tool });
        await this.repository.audit({
          context,
          action: "agent.respond",
          agent: AGENT_NAME,
          tool,
          provider: "deterministic",
          model: "pastoral-rules-v1",
          requestId,
          result: "tool_unavailable_response",
          confirmationStatus: "not_required",
          status: "success",
        });
        return { content, provider: "deterministic", model: "pastoral-rules-v1", tool, requestId, confirmationStatus: "not_required" };
      }
      throw error;
    }
    const safeEvidence = buildSafeExternalEvidence(toolResult);
    if (!safeEvidence) {
      // Fail closed: sem uma projeção explicitamente allowlisted e livre de PII para esta
      // ferramenta, nenhum provider externo (Hermes/OpenRouter/OpenAI/Anthropic/Gemini) é
      // chamado. A utilidade é preservada respondendo com o resumo determinístico local,
      // que só é entregue ao usuário já autorizado para este tenant/workspace.
      const content = toolResult.summary;
      await this.repository.appendMessage({ conversationId, context, role: "assistant", content, model: "pastoral-rules-v1", tool });
      await this.repository.audit({ context, action: "agent.respond", agent: AGENT_NAME, model: "pastoral-rules-v1", provider: "deterministic", tool, requestId, result: "no_safe_evidence_projection", confirmationStatus: "not_required", status: "success" });
      return { content, provider: "deterministic", model: "pastoral-rules-v1", tool, requestId, confirmationStatus: "not_required" };
    }

    const model = await (input.modelGenerator ?? this.modelRouter).generate({
      system: "Você é um assistente pastoral. Responda em português, de forma objetiva, usando exclusivamente a evidência fornecida. Não invente dados, não exponha dados de outra organização e não revele raciocínio interno.",
      user: `Pergunta: ${message}\n\nEvidência autorizada da ferramenta ${tool}: ${safeEvidence.text}`,
      fallback: toolResult.summary,
    });

    await this.repository.appendMessage({ conversationId, context, role: "assistant", content: model.content, model: model.model, tool });
    await this.repository.audit({ context, action: "agent.respond", agent: AGENT_NAME, model: model.model, provider: model.provider, tool, requestId, result: "response_generated", confirmationStatus: "not_required", status: "success" });
    return { content: model.content, provider: model.provider, model: model.model, tool, requestId, confirmationStatus: "not_required" };
  }

  async confirmFollowup(input: { context: TenantContext; conversationId: number; visitorId: number; note: string; idempotencyKey: string; requestId?: string }): Promise<AgentResponse> {
    const requestId = input.requestId ?? randomUUID();
    try {
      const toolCatalog = await this.resolveToolCatalog(input.context);
      assertToolExecutionPermission(input.context, getToolCatalogEntry("registrar_acompanhamento_visitante", toolCatalog));
    } catch (error) {
      await this.repository.audit({
        context: input.context,
        action: "followup.confirm",
        agent: AGENT_NAME,
        provider: "deterministic",
        model: "pastoral-rules-v1",
        tool: "registrar_acompanhamento_visitante",
        requestId,
        result: error instanceof ToolUnavailableError ? "tool_disabled" : "role_not_authorized",
        confirmationStatus: "denied",
        status: "denied",
        metadata: { reason: error instanceof ToolUnavailableError ? "tool_disabled" : "role_not_allowed" },
      });
      throw error;
    }
    const result = await this.repository.writeFollowup(input);
    const content = result.created
      ? `Acompanhamento de **${result.visitorName}** registrado com sucesso e incluído no histórico de auditoria.`
      : `O acompanhamento de **${result.visitorName}** já havia sido registrado; nenhuma duplicação foi criada.`;
    await this.repository.appendMessage({ conversationId: input.conversationId, context: input.context, role: "assistant", content, model: "pastoral-rules-v1", tool: "registrar_acompanhamento_visitante" });
    await this.repository.audit({ context: input.context, action: "followup.confirm", agent: AGENT_NAME, model: "pastoral-rules-v1", provider: "deterministic", tool: "registrar_acompanhamento_visitante", requestId, result: result.created ? "followup_registered" : "followup_duplicate", confirmationStatus: result.created ? "confirmed" : "duplicate", status: "success", metadata: { visitorId: input.visitorId } });
    return { content, provider: "deterministic", model: "pastoral-rules-v1", tool: "registrar_acompanhamento_visitante", requestId, confirmationStatus: result.created ? "confirmed" : "duplicate" };
  }
}
