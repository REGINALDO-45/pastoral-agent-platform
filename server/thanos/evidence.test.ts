import { describe, expect, it } from "vitest";
import { createThanosContext } from "./context";
import { toDomain, toTenantId, toWorkspaceKey } from "./contextIdentity";
import { composeThanosEvidence, normalizeThanosEvidence } from "./evidence";

function createContext() {
  return createThanosContext({
    workspaceKey: toWorkspaceKey("synthetic-operations"),
    tenantId: toTenantId("synthetic-tenant-a"),
    domain: toDomain("synthetic-operations"),
    userId: 12,
    userName: "Evidence Test",
    role: "reader",
    capabilities: ["agent:read"],
    channel: "chat",
    requestId: "evidence-request-1",
  });
}

describe("evidência THÁNOS", () => {
  it("normaliza evidência com proveniência sanitizada e campos de correlação", () => {
    const context = createContext();
    const sourceData = { count: 2, secretLikeField: "não deve virar metadado" };
    const evidence = normalizeThanosEvidence(sourceData ? { summary: "Dois registros.", data: sourceData } : { summary: "", data: {} }, context, {
      source: "synthetic",
      tool: "listar_pendencias_sinteticas",
      step: 1,
    });

    expect(evidence).toEqual({
      summary: "Dois registros.",
      data: { count: 2, secretLikeField: "não deve virar metadado" },
      provenance: {
        source: "synthetic",
        workspaceKey: "synthetic-operations",
        tenantId: "synthetic-tenant-a",
        requestId: "evidence-request-1",
        tool: "listar_pendencias_sinteticas",
        step: 1,
      },
    });
    expect(evidence.provenance).not.toHaveProperty("secretLikeField");
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.data)).toBe(true);
  });

  it("compõe etapas e preserva a proveniência individual e agregada", () => {
    const context = createContext();
    const first = normalizeThanosEvidence({ summary: "Primeira.", data: { value: 1 } }, context, { source: "tool", tool: "one", step: 1 });
    const second = normalizeThanosEvidence({ summary: "Segunda.", data: { value: 2 } }, context, { source: "connector", tool: "two", step: 2 });
    const composite = composeThanosEvidence([{ tool: "one", evidence: first }, { tool: "two", evidence: second }], context);

    expect(composite.summary).toBe("Primeira. Segunda.");
    expect(composite.provenance).toMatchObject({ source: "composite", workspaceKey: "synthetic-operations", tenantId: "synthetic-tenant-a", requestId: "evidence-request-1" });
    expect(composite.data.steps).toEqual([
      { tool: "one", data: { value: 1 }, provenance: first.provenance },
      { tool: "two", data: { value: 2 }, provenance: second.provenance },
    ]);
  });

  it("recusa summary vazio e etapa inválida", () => {
    const context = createContext();
    expect(() => normalizeThanosEvidence({ summary: " ", data: {} }, context, { source: "tool" })).toThrow("summary não vazio");
    expect(() => normalizeThanosEvidence({ summary: "ok", data: {} }, context, { source: "tool", step: 0 })).toThrow("inteiro positivo");
  });
});
