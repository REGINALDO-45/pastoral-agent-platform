import { describe, expect, it } from "vitest";
import { buildSafeExternalEvidence } from "./safeExternalEvidence";
import type { ToolResult } from "./types";

function toolResult(tool: ToolResult["tool"], data: Record<string, unknown>): ToolResult {
  return { tool, summary: "resumo local (não utilizado pela projeção)", data };
}

describe("buildSafeExternalEvidence", () => {
  it("projeta células apenas pelo nome, sem expor líder ou supervisor", () => {
    const result = buildSafeExternalEvidence(toolResult("consultar_celulas", {
      cells: [{ name: "Célula Alfa", leader: "PII_LEADER_NAME_DO_NOT_SEND", supervisor: "PII_SUPERVISOR_NAME_DO_NOT_SEND" }],
    }));

    expect(result).not.toBeNull();
    expect(result!.text).toContain("Célula Alfa");
    expect(result!.text).not.toContain("PII_LEADER_NAME_DO_NOT_SEND");
    expect(result!.text).not.toContain("PII_SUPERVISOR_NAME_DO_NOT_SEND");
  });

  it("falha fechado para consultar_celulas quando o formato de dados é inesperado", () => {
    const result = buildSafeExternalEvidence(toolResult("consultar_celulas", { cells: "not-an-array" }));
    expect(result).toBeNull();
  });

  it("projeta relatórios pendentes apenas pelo nome da célula", () => {
    const result = buildSafeExternalEvidence(toolResult("consultar_relatorios", {
      pendingReports: [{ cellName: "Célula Alfa", weekLabel: "2026-W10" }],
    }));

    expect(result).not.toBeNull();
    expect(result!.text).toContain("Célula Alfa");
  });

  it("falha fechado para consultar_relatorios quando o formato de dados é inesperado", () => {
    const result = buildSafeExternalEvidence(toolResult("consultar_relatorios", { pendingReports: [{ cellName: 42 }] }));
    expect(result).toBeNull();
  });

  it("projeta presença apenas com contagens e nomes de célula", () => {
    const result = buildSafeExternalEvidence(toolResult("consultar_presenca", {
      heldCount: 2,
      missed: ["Célula Beta"],
      lowAttendance: ["Célula Gama (5)"],
    }));

    expect(result).not.toBeNull();
    expect(result!.text).toContain("2");
    expect(result!.text).toContain("Célula Beta");
    expect(result!.text).toContain("Célula Gama (5)");
  });

  it("falha fechado para consultar_presenca quando o formato de dados é inesperado", () => {
    const result = buildSafeExternalEvidence(toolResult("consultar_presenca", { heldCount: "dois", missed: [], lowAttendance: [] }));
    expect(result).toBeNull();
  });

  it("nunca projeta consultar_visitantes, mesmo com dados bem formados", () => {
    const result = buildSafeExternalEvidence(toolResult("consultar_visitantes", {
      visitors: [{ id: 1, name: "PII_VISITOR_NAME_DO_NOT_SEND", followedUp: false }],
    }));

    expect(result).toBeNull();
  });

  it("nunca projeta consultar_lideres, mesmo com dados bem formados", () => {
    const result = buildSafeExternalEvidence(toolResult("consultar_lideres", {
      leaders: [{ name: "PII_LEADER_NAME_DO_NOT_SEND", attentionNote: "PII_ATTENTION_NOTE_DO_NOT_SEND" }],
    }));

    expect(result).toBeNull();
  });
});
