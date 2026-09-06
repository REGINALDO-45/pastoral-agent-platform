import type { ReadPastoralToolName, ToolResult } from "./types";

/**
 * Projeção explicitamente allowlisted de um ToolResult para uso em geração
 * externa (Hermes, OpenAI, Anthropic, Gemini, OpenRouter). Só inclui campos
 * agregados/não identificáveis; nunca reaproveita `data` bruto.
 */
export type SafeExternalEvidence = Readonly<{ tool: ReadPastoralToolName; text: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function projectCells(data: Record<string, unknown>): string | null {
  const cells = data.cells;
  if (!Array.isArray(cells)) return null;
  const names: string[] = [];
  for (const cell of cells) {
    if (!isRecord(cell) || typeof cell.name !== "string") return null;
    names.push(cell.name);
  }
  return `Total de células: ${names.length}. Nomes das células: ${names.length ? names.join(", ") : "nenhuma"}.`;
}

function projectReports(data: Record<string, unknown>): string | null {
  const pendingReports = data.pendingReports;
  if (!Array.isArray(pendingReports)) return null;
  const names: string[] = [];
  for (const item of pendingReports) {
    if (!isRecord(item) || typeof item.cellName !== "string") return null;
    names.push(item.cellName);
  }
  return `Células com relatório pendente: ${names.length}. ${names.length ? names.join(", ") : "Nenhuma célula pendente."}`;
}

function projectAttendance(data: Record<string, unknown>): string | null {
  const { heldCount, missed, lowAttendance } = data;
  if (typeof heldCount !== "number" || !isStringArray(missed) || !isStringArray(lowAttendance)) return null;
  return `Células que realizaram reunião: ${heldCount}. Células que não realizaram: ${missed.length ? missed.join(", ") : "nenhuma"}. Células com baixa presença: ${lowAttendance.length ? lowAttendance.join(", ") : "nenhuma"}.`;
}

/**
 * Ferramentas sem projeção segura conhecida. Não são um "blocklist de campos":
 * são as duas ferramentas cujo próprio propósito é retornar identificadores
 * pessoais (nome de visitante/líder, nota de atenção em texto livre), então
 * nenhuma agregação as torna seguras para um provider externo.
 */
const NO_SAFE_PROJECTION = new Set<ReadPastoralToolName>(["consultar_visitantes", "consultar_lideres"]);

const PROJECTORS: Partial<Record<ReadPastoralToolName, (data: Record<string, unknown>) => string | null>> = {
  consultar_celulas: projectCells,
  consultar_relatorios: projectReports,
  consultar_presenca: projectAttendance,
};

/**
 * Retorna uma evidência textual segura para envio a um provider externo, ou
 * `null` quando não há projeção segura disponível — sinal de fail-closed:
 * o chamador não deve invocar nenhum provider externo neste caso.
 */
export function buildSafeExternalEvidence(toolResult: ToolResult): SafeExternalEvidence | null {
  if (NO_SAFE_PROJECTION.has(toolResult.tool)) return null;
  const projector = PROJECTORS[toolResult.tool];
  if (!projector) return null;
  const text = projector(toolResult.data);
  if (!text) return null;
  return { tool: toolResult.tool, text };
}
