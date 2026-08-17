import { assertThanosCapability } from "./context";
import type { ThanosCapability, ThanosContext } from "./contracts";
import type { ThanosAuditPort, ThanosGeneratorPort, ThanosReadTool } from "./orchestrator";
import { composeThanosEvidence, normalizeThanosEvidence, type ThanosEvidence } from "./evidence";

export type ThanosReadPlanIntent = "READ" | "WRITE";

export type ThanosReadPlanStep = Readonly<{
  tool: ThanosReadTool;
  capability: ThanosCapability;
  intent: ThanosReadPlanIntent;
}>;

export type ThanosReadPlan = Readonly<{
  planId: string;
  steps: readonly ThanosReadPlanStep[];
}>;

export type ThanosReadPlanResult = Readonly<{
  planId: string;
  content: string;
  provider: string;
  model: string;
  tools: readonly string[];
  requestId: string;
  evidence: ThanosEvidence;
  fallback: boolean;
}>;

export class ThanosReadPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThanosReadPlanError";
  }
}

const knownCapabilities = new Set<ThanosCapability>([
  "agent:read",
  "agent:write",
  "dashboard:read",
  "settings:manage",
]);

function assertDeclaredPlan(plan: ThanosReadPlan): void {
  if (!plan.planId.trim()) {
    throw new ThanosReadPlanError("O plano READ exige um planId.");
  }
  if (plan.steps.length < 2 || plan.steps.length > 5) {
    throw new ThanosReadPlanError("O planner READ exige entre dois e cinco passos declarados.");
  }

  for (let offset = 0; offset < plan.steps.length; offset += 1) {
    const step = plan.steps[offset];
    const stepNumber = offset + 1;
    if (!step.tool?.name?.trim()) {
      throw new ThanosReadPlanError(`O passo ${stepNumber} exige uma ferramenta declarada.`);
    }
    if (!knownCapabilities.has(step.capability)) {
      throw new ThanosReadPlanError(`O passo ${stepNumber} exige uma capability THÁNOS conhecida.`);
    }
    if (step.intent !== "READ") {
      throw new ThanosReadPlanError(`O passo ${stepNumber} foi recusado: o planner aceita somente intenção READ.`);
    }
    if (step.tool.requiredCapability !== step.capability) {
      throw new ThanosReadPlanError(`O passo ${stepNumber} declara capability diferente da ferramenta.`);
    }
  }
}

function composePlanEvidence(
  completed: readonly Readonly<{ tool: ThanosReadTool; evidence: ThanosEvidence }>[],
  context: ThanosContext,
): ThanosEvidence {
  return composeThanosEvidence(completed.map(step => ({ tool: step.tool.name, evidence: step.evidence })), context);
}

function deterministicPlanFallback(evidence: ThanosEvidence): string {
  const prefix = evidence.summary === "Nenhuma etapa READ foi concluída." ? "" : `${evidence.summary} `;
  return `${prefix}Não foi possível concluir todas as etapas READ solicitadas no momento.`;
}

function isolatedStepContext(context: ThanosContext): ThanosContext {
  return Object.freeze({ ...context });
}

export class ThanosReadPlanner {
  constructor(private readonly audit: ThanosAuditPort, private readonly now: () => number = Date.now) {}

  async run(input: Readonly<{
    context: ThanosContext;
    plan: ThanosReadPlan;
    system: string;
    user: string;
    generator: ThanosGeneratorPort;
  }>): Promise<ThanosReadPlanResult> {
    assertDeclaredPlan(input.plan);

    for (let offset = 0; offset < input.plan.steps.length; offset += 1) {
      const step = input.plan.steps[offset];
      try {
        assertThanosCapability(input.context, step.capability);
      } catch (error) {
        await this.audit.record({
          context: input.context,
          action: "thanos.read.denied",
          status: "denied",
          result: "plan_step_capability_not_authorized",
          tool: step.tool.name,
          step: offset + 1,
          durationMs: 0,
        });
        throw error;
      }
    }

    const completed: Array<Readonly<{ tool: ThanosReadTool; evidence: ThanosEvidence }>> = [];
    for (let offset = 0; offset < input.plan.steps.length; offset += 1) {
      const step = input.plan.steps[offset];
      const stepNumber = offset + 1;
      const startedAt = this.now();
      const stepContext = isolatedStepContext(input.context);
      try {
        const rawEvidence = await step.tool.execute(stepContext);
        const evidence = normalizeThanosEvidence(rawEvidence, stepContext, { source: "tool", tool: step.tool.name, step: stepNumber });
        completed.push(Object.freeze({ tool: step.tool, evidence }));
        await this.audit.record({
          context: stepContext,
          action: "thanos.read.step",
          status: "success",
          result: "plan_step_completed",
          tool: step.tool.name,
          step: stepNumber,
          durationMs: Math.max(0, this.now() - startedAt),
        });
      } catch {
        const evidence = composePlanEvidence(completed, input.context);
        await this.audit.record({
          context: stepContext,
          action: "thanos.read.step.failed",
          status: "failure",
          result: "plan_step_failed",
          tool: step.tool.name,
          step: stepNumber,
          durationMs: Math.max(0, this.now() - startedAt),
        });
        await this.audit.record({
          context: input.context,
          action: "thanos.read.failed",
          status: "failure",
          result: "plan_partial_fallback",
          tool: step.tool.name,
        });
        return Object.freeze({
          planId: input.plan.planId,
          content: deterministicPlanFallback(evidence),
          provider: "deterministic",
          model: "thanos-read-plan-fallback-v1",
          tools: Object.freeze(input.plan.steps.map(candidate => candidate.tool.name)),
          requestId: input.context.requestId,
          evidence,
          fallback: true,
        });
      }
    }

    const evidence = composePlanEvidence(completed, input.context);
    const generation = await input.generator.generate({
      context: input.context,
      system: input.system,
      user: input.user,
      fallback: evidence.summary,
      evidence,
    });
    await this.audit.record({
      context: input.context,
      action: "thanos.read",
      status: "success",
      result: "plan_response_generated",
      tool: input.plan.steps.map(step => step.tool.name).join(","),
      provider: generation.provider,
      model: generation.model,
    });

    return Object.freeze({
      planId: input.plan.planId,
      ...generation,
      tools: Object.freeze(input.plan.steps.map(step => step.tool.name)),
      requestId: input.context.requestId,
      evidence,
      fallback: false,
    });
  }
}
