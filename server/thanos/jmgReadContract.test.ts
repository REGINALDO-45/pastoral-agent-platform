import { describe, expect, it, vi } from "vitest";
import { createThanosContext } from "./context";
import { toDomain, toTenantId, toWorkspaceKey } from "./contextIdentity";
import {
  thanosSkillRegistry,
  thanosWorkspaceRegistry,
} from "./defaultRegistries";
import {
  InMemoryJmgReadAdapter,
  JMG_DOMAIN,
  JMG_READ_ALLOWLIST,
  JMG_READ_FEATURE_FLAG_ENV,
  JMG_READ_TOOL,
  JMG_READ_TOOL_CONTRACT,
  JMG_TENANT_SCOPE,
  JMG_WORKSPACE_KEY,
  JmgReadAdapterError,
  JmgReadAdapterRegistry,
  JmgReadContractError,
  executeJmgRead,
  resolveJmgReadFeatureFlag,
} from "./jmgReadContract";
import {
  createJmgWorkspaceSource,
  jmgWorkspaceDefinition,
} from "../workspaces/jmg/workspaceDefinition";

const requestId = "jmg-request-1";
const timestampMs = Date.parse("2026-08-18T12:00:00.000Z");
const summary = {
  totalAbertas: 8,
  emNegociacao: 3,
  aguardandoResposta: 2,
  valorPipeline: 12500,
};

function context(overrides: Readonly<Record<string, unknown>> = {}) {
  return createThanosContext({
    workspaceKey: toWorkspaceKey(JMG_WORKSPACE_KEY),
    tenantId: toTenantId(JMG_TENANT_SCOPE),
    domain: toDomain(JMG_DOMAIN),
    userId: 42,
    userName: "JMG READ Test",
    role: "vendedor",
    capabilities: ["agent:read"],
    channel: "chat",
    requestId,
    ...overrides,
  });
}

function adapterRegistry(response: unknown = summary) {
  const registry = new JmgReadAdapterRegistry();
  registry.register(new InMemoryJmgReadAdapter(response));
  return registry;
}

function auditPort() {
  const events: unknown[] = [];
  return {
    events,
    record: vi.fn((event: unknown) => {
      events.push(event);
    }),
  };
}

describe("workspace and contract registration", () => {
  it("resolves JMG server-side with its own scope and no pastoral organization", () => {
    const resolved = jmgWorkspaceDefinition.resolveContext(
      createJmgWorkspaceSource({
        userId: 42,
        userName: "JMG READ Test",
        role: "vendedor",
        channel: "chat",
        requestId,
      })
    );

    expect(resolved).toMatchObject({
      workspaceKey: JMG_WORKSPACE_KEY,
      domain: JMG_DOMAIN,
      tenantId: JMG_TENANT_SCOPE,
      capabilities: ["agent:read"],
      platformRole: "none",
      platformCapabilities: [],
    });
    expect(resolved.tenantId).not.toMatch(/^org:/);
  });

  it("registers JMG as an isolated workspace and declares one READ tool", () => {
    expect(thanosWorkspaceRegistry.list()).toContainEqual({
      workspaceKey: JMG_WORKSPACE_KEY,
      domain: JMG_DOMAIN,
      displayName: "JMG",
    });
    const skill = thanosSkillRegistry.getForWorkspace(
      toWorkspaceKey(JMG_WORKSPACE_KEY),
      "jmg-readonly"
    );
    expect(skill).toMatchObject({
      workspaceKey: JMG_WORKSPACE_KEY,
      domain: JMG_DOMAIN,
      allowedTools: [JMG_READ_TOOL],
      allowedChannels: ["chat"],
      requiredCapabilities: ["agent:read"],
      readOnly: true,
    });
  });

  it("declares an exact READ-only contract and a single allowlist entry", () => {
    expect(JMG_READ_ALLOWLIST).toEqual([JMG_READ_TOOL]);
    expect(JMG_READ_TOOL_CONTRACT).toMatchObject({
      tool: JMG_READ_TOOL,
      category: "READ",
      workspace: JMG_WORKSPACE_KEY,
      confirmation: false,
      sideEffects: "none",
      input: "empty-object-strict",
      authorization: "server-side",
    });
    expect(JMG_READ_TOOL_CONTRACT.output).toEqual([
      "totalAbertas",
      "emNegociacao",
      "aguardandoResposta",
      "valorPipeline",
    ]);
  });

  it("keeps the feature flag fail-closed", () => {
    expect(resolveJmgReadFeatureFlag({})).toBe(false);
    expect(
      resolveJmgReadFeatureFlag({ [JMG_READ_FEATURE_FLAG_ENV]: "false" })
    ).toBe(false);
    expect(
      resolveJmgReadFeatureFlag({ [JMG_READ_FEATURE_FLAG_ENV]: "true" })
    ).toBe(true);
  });
});

describe("executeJmgRead", () => {
  it("calls the fake adapter, validates four metrics, and returns sanitized evidence/audit", async () => {
    const audit = auditPort();
    const adapterExecute = vi.fn(async () => summary);
    const adapters = new JmgReadAdapterRegistry();
    adapters.register({ key: JMG_READ_TOOL, execute: adapterExecute });

    const result = await executeJmgRead({
      context: context(),
      trustedContext: { source: "server", requestId },
      requestId,
      requestedWorkspace: JMG_WORKSPACE_KEY,
      requestedTool: JMG_READ_TOOL,
      input: {},
      featureEnabled: true,
      adapters,
      audit,
      now: () => timestampMs,
    });

    expect(adapterExecute).toHaveBeenCalledOnce();
    expect(adapterExecute.mock.calls[0]?.[0]).toMatchObject({
      requestId,
      input: {},
    });
    expect(result).toMatchObject({
      workspace: JMG_WORKSPACE_KEY,
      tool: JMG_READ_TOOL,
      status: "success",
      sideEffects: "none",
      summary,
    });
    expect(result.evidence).toMatchObject({
      workspace: JMG_WORKSPACE_KEY,
      tool: JMG_READ_TOOL,
      status: "success",
      requestId,
      summary: "sanitized-jmg-proposal-summary",
    });
    expect(result.evidence.evidence.data).toEqual(summary);
    expect(result.audit).toMatchObject({
      requestId,
      workspace: JMG_WORKSPACE_KEY,
      tool: JMG_READ_TOOL,
      status: "success",
      actor: "thanos-server-context",
    });
    expect(audit.record).toHaveBeenCalledOnce();
  });

  it("rejects arbitrary input before the adapter is called", async () => {
    const adapterExecute = vi.fn(async () => summary);
    const adapters = new JmgReadAdapterRegistry();
    adapters.register({ key: JMG_READ_TOOL, execute: adapterExecute });
    const audit = auditPort();

    await expect(
      executeJmgRead({
        context: context(),
        trustedContext: { source: "server", requestId },
        requestId,
        requestedWorkspace: JMG_WORKSPACE_KEY,
        requestedTool: JMG_READ_TOOL,
        input: { userId: 42, role: "admin", tenantId: "org:1" },
        featureEnabled: true,
        adapters,
        audit,
      })
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(adapterExecute).not.toHaveBeenCalled();
    expect(audit.events[0]).toMatchObject({
      status: "denied",
      reason: "invalid-input",
      errorCategory: "contract",
    });
  });

  it.each([
    ["flag disabled", { featureEnabled: false }, "feature-disabled"],
    ["arbitrary tool", { requestedTool: "jmg_create_lead" }, "tool-denied"],
    ["WRITE tool", { requestedTool: "registrar_proposta" }, "tool-denied"],
    ["other workspace", { requestedWorkspace: "pastoral" }, "workspace-denied"],
    [
      "foreign context workspace",
      { context: context({ workspaceKey: toWorkspaceKey("pastoral") }) },
      "workspace-denied",
    ],
    [
      "pastoral organization tenant",
      { context: context({ tenantId: toTenantId("org:1") }) },
      "workspace-denied",
    ],
    [
      "voice channel",
      { context: context({ channel: "voice" }) },
      "workspace-denied",
    ],
    [
      "missing trusted context",
      { trustedContext: undefined },
      "trusted-context-denied",
    ],
    [
      "request mismatch",
      { trustedContext: { source: "server", requestId: "other-request" } },
      "trusted-context-denied",
    ],
    [
      "platform authority",
      { context: context({ platformRole: "superadmin" }) },
      "trusted-context-denied",
    ],
    [
      "missing read capability",
      { context: context({ capabilities: [] }) },
      "capability-denied",
    ],
    [
      "extra write capability",
      { context: context({ capabilities: ["agent:read", "agent:write"] }) },
      "capability-denied",
    ],
  ])("fails closed for %s", async (_label, overrides, code) => {
    const audit = auditPort();
    const adapters = adapterRegistry();
    await expect(
      executeJmgRead({
        context: context(),
        trustedContext: { source: "server", requestId },
        requestId,
        requestedWorkspace: JMG_WORKSPACE_KEY,
        requestedTool: JMG_READ_TOOL,
        input: {},
        featureEnabled: true,
        adapters,
        audit,
        ...overrides,
      })
    ).rejects.toMatchObject({ code });
    expect(audit.events[0]).toMatchObject({ status: "denied" });
  });

  it("denies a missing adapter and never invents a transport", async () => {
    const audit = auditPort();
    await expect(
      executeJmgRead({
        context: context(),
        trustedContext: { source: "server", requestId },
        requestId,
        requestedWorkspace: JMG_WORKSPACE_KEY,
        requestedTool: JMG_READ_TOOL,
        input: {},
        featureEnabled: true,
        adapters: new JmgReadAdapterRegistry(),
        audit,
      })
    ).rejects.toMatchObject({ code: "adapter-not-registered" });
    expect(audit.events[0]).toMatchObject({ reason: "adapter-not-registered" });
  });

  it("rejects extra, PII-like, negative, and non-finite response fields", async () => {
    for (const response of [
      { ...summary, email: "not-used@example.invalid" },
      { ...summary, telefone: "not-used" },
      { ...summary, propostaBruta: {} },
      { ...summary, totalAbertas: -1 },
      { ...summary, valorPipeline: Number.POSITIVE_INFINITY },
    ]) {
      const audit = auditPort();
      await expect(
        executeJmgRead({
          context: context(),
          trustedContext: { source: "server", requestId },
          requestId,
          requestedWorkspace: JMG_WORKSPACE_KEY,
          requestedTool: JMG_READ_TOOL,
          input: {},
          featureEnabled: true,
          adapters: adapterRegistry(response),
          audit,
        })
      ).rejects.toMatchObject({
        code: "invalid-response",
        message: "Resposta JMG inválida.",
      });
      expect(audit.events[0]).toMatchObject({
        status: "failure",
        reason: "invalid-response",
        errorCategory: "contract",
      });
    }
  });

  it("sanitizes adapter exceptions and never returns their message", async () => {
    const audit = auditPort();
    const adapters = new JmgReadAdapterRegistry();
    adapters.register({
      key: JMG_READ_TOOL,
      execute: async () => {
        throw new Error("sensitive adapter detail must not escape");
      },
    });

    await expect(
      executeJmgRead({
        context: context(),
        trustedContext: { source: "server", requestId },
        requestId,
        requestedWorkspace: JMG_WORKSPACE_KEY,
        requestedTool: JMG_READ_TOOL,
        input: {},
        featureEnabled: true,
        adapters,
        audit,
      })
    ).rejects.toMatchObject({
      code: "adapter-failed",
      message: "Adapter JMG indisponível.",
    });
    expect(JSON.stringify(audit.events)).not.toContain(
      "sensitive adapter detail"
    );
    expect(audit.events[0]).toMatchObject({
      status: "failure",
      reason: "adapter-failed",
      errorCategory: "adapter",
    });
  });

  it("rejects adapters outside the fixed allowlist", () => {
    const adapters = new JmgReadAdapterRegistry();
    expect(() =>
      adapters.register({
        key: "jmg_write_proposta" as never,
        execute: async () => summary,
      })
    ).toThrow(JmgReadAdapterError);
  });

  it("keeps audit and evidence free of personal fields and secrets", async () => {
    const audit = auditPort();
    const result = await executeJmgRead({
      context: context(),
      trustedContext: { source: "server", requestId },
      requestId,
      requestedWorkspace: JMG_WORKSPACE_KEY,
      requestedTool: JMG_READ_TOOL,
      input: {},
      featureEnabled: true,
      adapters: adapterRegistry(summary),
      audit,
      now: () => timestampMs,
    });
    const serialized = JSON.stringify({ result, audit: audit.events });
    expect(serialized).not.toContain("email");
    expect(serialized).not.toContain("telefone");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("org:");
  });
});
