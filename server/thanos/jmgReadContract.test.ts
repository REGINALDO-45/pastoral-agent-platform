import { describe, expect, it, vi } from "vitest";
import { toWorkspaceKey } from "./contextIdentity";
import {
  thanosSkillRegistry,
  thanosWorkspaceRegistry,
} from "./defaultRegistries";
import { SkillNotRegisteredError } from "./skillRegistry";
import { WorkspaceNotRegisteredError } from "./workspaceRegistry";
import {
  InMemoryJmgReadAdapter,
  JMG_DOMAIN,
  JMG_READ_ALLOWLIST,
  JMG_READ_TOOL,
  JMG_READ_TOOL_CONTRACT,
  JMG_WORKSPACE_KEY,
  type JmgReadAdapter,
  parseJmgReadInput,
  parseJmgReadSummary,
} from "./jmgReadContract";
import {
  jmgSkillDefinition,
  jmgWorkspaceDeclaration,
  jmgWorkspaceIdentity,
} from "../workspaces/jmg/workspaceDefinition";

const summary = {
  totalAbertas: 8,
  emNegociacao: 3,
  aguardandoResposta: 2,
  valorPipeline: 12500,
};

describe("JMG declaration and contract", () => {
  it("keeps the workspace as a declaration without operational context", () => {
    expect(jmgWorkspaceDeclaration).toEqual({
      workspaceKey: JMG_WORKSPACE_KEY,
      domain: JMG_DOMAIN,
      displayName: "JMG",
    });
    expect(jmgWorkspaceIdentity).toEqual({
      workspaceKey: JMG_WORKSPACE_KEY,
      domain: JMG_DOMAIN,
    });
    expect("resolveContext" in jmgWorkspaceDeclaration).toBe(false);
    expect(JSON.stringify(jmgWorkspaceDeclaration)).not.toContain("tenant");
  });

  it("declares one READ-only tool without activating a registry", () => {
    expect(JMG_READ_ALLOWLIST).toEqual([JMG_READ_TOOL]);
    expect(jmgSkillDefinition).toMatchObject({
      workspaceKey: JMG_WORKSPACE_KEY,
      domain: JMG_DOMAIN,
      allowedTools: [JMG_READ_TOOL],
      allowedChannels: ["chat"],
      requiredCapabilities: ["agent:read"],
      readOnly: true,
    });
    expect(JMG_READ_TOOL_CONTRACT).toMatchObject({
      tool: JMG_READ_TOOL,
      category: "READ",
      workspace: JMG_WORKSPACE_KEY,
      confirmation: false,
      sideEffects: "none",
      input: "empty-object-strict",
    });
    expect(JMG_READ_TOOL_CONTRACT.output).toEqual([
      "totalAbertas",
      "emNegociacao",
      "aguardandoResposta",
      "valorPipeline",
    ]);
  });

  it("keeps JMG workspace and skill out of the default registries", () => {
    expect(() => thanosWorkspaceRegistry.get(JMG_WORKSPACE_KEY)).toThrow(
      WorkspaceNotRegisteredError
    );
    expect(() =>
      thanosSkillRegistry.getForWorkspace(
        toWorkspaceKey(JMG_WORKSPACE_KEY),
        "jmg-readonly"
      )
    ).toThrow(SkillNotRegisteredError);
    expect(thanosWorkspaceRegistry.list()).not.toContainEqual(
      jmgWorkspaceDeclaration
    );
    expect(
      thanosSkillRegistry.listForWorkspace(toWorkspaceKey(JMG_WORKSPACE_KEY))
    ).toEqual([]);
  });
});

describe("JMG input and output schemas", () => {
  it("accepts the empty object and rejects every extra input field", () => {
    expect(parseJmgReadInput({})).toEqual({});
    for (const input of [
      { requestId: "not-business-input" },
      { workspace: "jmg" },
      { capabilities: ["agent:read"] },
      { authority: "not-allowed" },
    ]) {
      expect(() => parseJmgReadInput(input)).toThrow();
    }
  });

  it("accepts exactly the four non-negative summary metrics", () => {
    expect(parseJmgReadSummary(summary)).toEqual(summary);
  });

  it.each([
    ["extra field", { ...summary, email: "not-used@example.invalid" }],
    ["raw proposal field", { ...summary, propostaBruta: {} }],
    ["negative count", { ...summary, totalAbertas: -1 }],
    ["fractional count", { ...summary, totalAbertas: 1.5 }],
    ["negative pipeline", { ...summary, valorPipeline: -1 }],
    ["NaN pipeline", { ...summary, valorPipeline: Number.NaN }],
    [
      "Infinity pipeline",
      { ...summary, valorPipeline: Number.POSITIVE_INFINITY },
    ],
  ])("rejects %s", (_label, invalid) => {
    expect(() => parseJmgReadSummary(invalid)).toThrow();
  });
});

describe("JmgReadAdapter", () => {
  it("receives only the strict business input and no authority", async () => {
    const execute = vi.fn(async (input: Record<string, never>) => {
      expect(input).toEqual({});
      return summary;
    });
    const adapter: JmgReadAdapter = { execute };

    const result = await adapter.execute({});

    expect(result).toEqual(summary);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]).toEqual([{}]);
  });

  it("does not expose context, capability, workspace, tenant or role in its port", () => {
    const adapter: JmgReadAdapter = {
      execute: async () => summary,
    };
    expect(Object.keys(adapter)).toEqual(["execute"]);
  });

  it("is deterministic in memory and validates its input", async () => {
    const adapter = new InMemoryJmgReadAdapter(summary);

    await expect(adapter.execute({})).resolves.toEqual(summary);
    await expect(
      adapter.execute({ extra: "not-allowed" } as never)
    ).rejects.toThrow();
  });

  it("rejects an output with extra fields through the strict schema", async () => {
    const rawResponse = {
      ...summary,
      email: "not-used@example.invalid",
    };
    const adapter = new InMemoryJmgReadAdapter(rawResponse);

    await expect(adapter.execute({})).rejects.toThrow();
    expect(() => parseJmgReadSummary(rawResponse)).toThrow();
  });
});
