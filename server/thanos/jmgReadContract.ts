import { z } from "zod";

export const JMG_WORKSPACE_KEY = "jmg" as const;
export const JMG_DOMAIN = "jmg" as const;
export const JMG_READ_TOOL = "jmg_resumo_propostas" as const;
export const JMG_READ_CATEGORY = "READ" as const;
export const JMG_READ_ALLOWLIST = Object.freeze([JMG_READ_TOOL] as const);

const nonNegativeInteger = z.number().int().nonnegative();
const nonNegativeNumber = z.number().finite().nonnegative();

export const jmgReadInputSchema = z.object({}).strict();

export const jmgReadSummarySchema = z
  .object({
    totalAbertas: nonNegativeInteger,
    emNegociacao: nonNegativeInteger,
    aguardandoResposta: nonNegativeInteger,
    valorPipeline: nonNegativeNumber,
  })
  .strict();

export type JmgReadInput = z.infer<typeof jmgReadInputSchema>;
export type JmgReadSummary = z.infer<typeof jmgReadSummarySchema>;

export const JMG_READ_TOOL_CONTRACT = Object.freeze({
  tool: JMG_READ_TOOL,
  category: JMG_READ_CATEGORY,
  workspace: JMG_WORKSPACE_KEY,
  confirmation: false,
  sideEffects: "none",
  input: "empty-object-strict",
  output: Object.freeze([
    "totalAbertas",
    "emNegociacao",
    "aguardandoResposta",
    "valorPipeline",
  ] as const),
});

/**
 * Business port only. Authority, identity, tenant, channel and transport
 * belong to a future THÁNOS composition layer, not to this adapter contract.
 */
export type JmgReadAdapter = Readonly<{
  execute(input: JmgReadInput): Promise<JmgReadSummary>;
}>;

export class InMemoryJmgReadAdapter implements JmgReadAdapter {
  constructor(private readonly response: unknown) {}

  async execute(input: JmgReadInput): Promise<JmgReadSummary> {
    parseJmgReadInput(input);
    return parseJmgReadSummary(this.response);
  }
}

export function parseJmgReadInput(input: unknown): JmgReadInput {
  return jmgReadInputSchema.parse(input ?? {});
}

export function parseJmgReadSummary(input: unknown): JmgReadSummary {
  return jmgReadSummarySchema.parse(input);
}
