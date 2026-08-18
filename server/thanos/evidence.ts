import type { ThanosContext } from "./contracts";

export type ThanosEvidenceSource = "tool" | "connector" | "synthetic" | "cache" | "composite";

export type ThanosEvidenceProvenance = Readonly<{
  source: ThanosEvidenceSource;
  workspaceKey: string;
  tenantId: string;
  requestId: string;
  tool?: string;
  step?: number;
}>;

export type ThanosEvidence = Readonly<{
  summary: string;
  data: Record<string, unknown>;
  provenance?: ThanosEvidenceProvenance;
}>;

export function normalizeThanosEvidence(
  evidence: ThanosEvidence,
  context: ThanosContext,
  input: Readonly<{ source: ThanosEvidenceSource; tool?: string; step?: number }>,
): ThanosEvidence {
  if (!evidence.summary.trim()) {
    throw new Error("Evidência THÁNOS exige summary não vazio.");
  }
  if (input.step !== undefined && (!Number.isSafeInteger(input.step) || input.step <= 0)) {
    throw new Error("A etapa da evidência THÁNOS deve ser um inteiro positivo.");
  }

  return Object.freeze({
    summary: evidence.summary,
    data: Object.freeze({ ...evidence.data }),
    provenance: Object.freeze({
      source: input.source,
      workspaceKey: context.workspaceKey,
      tenantId: context.tenantId,
      requestId: context.requestId,
      ...(input.tool === undefined ? {} : { tool: input.tool }),
      ...(input.step === undefined ? {} : { step: input.step }),
    }),
  });
}

export function composeThanosEvidence(
  steps: readonly Readonly<{ tool: string; evidence: ThanosEvidence }>[],
  context: ThanosContext,
): ThanosEvidence {
  if (steps.length === 0) {
    return normalizeThanosEvidence(
      { summary: "Nenhuma etapa READ foi concluída.", data: { steps: [] } },
      context,
      { source: "composite" },
    );
  }

  return normalizeThanosEvidence(
    {
      summary: steps.map(step => step.evidence.summary).join(" "),
      data: {
        steps: steps.map(step => ({
          tool: step.tool,
          data: step.evidence.data,
          provenance: step.evidence.provenance,
        })),
      },
    },
    context,
    { source: "composite" },
  );
}
