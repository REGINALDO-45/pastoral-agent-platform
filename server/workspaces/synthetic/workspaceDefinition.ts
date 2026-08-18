import { createThanosContext } from "../../thanos/context";
import type { SkillDefinition, ThanosCapability, ThanosChannel, WorkspaceDefinition } from "../../thanos/contracts";
import { toDomain, toTenantId, toWorkspaceKey, type Domain, type TenantId, type WorkspaceKey } from "../../thanos/contextIdentity";

export type SyntheticWorkspaceSource = Readonly<{
  tenantId: TenantId;
  userId: number;
  userName: string;
  role: string;
  channel: ThanosChannel;
  conversationId?: number;
  requestId: string;
}>;

const syntheticWorkspaceKey: WorkspaceKey = toWorkspaceKey("synthetic-operations");
const syntheticDomain: Domain = toDomain("synthetic-operations");

function capabilitiesForSyntheticWorkspace(): readonly ThanosCapability[] {
  return Object.freeze(["agent:read", "agent:write"] as const);
}

export const syntheticWorkspaceDefinition: WorkspaceDefinition<SyntheticWorkspaceSource> = Object.freeze({
  workspaceKey: syntheticWorkspaceKey,
  domain: syntheticDomain,
  displayName: "Operações Sintéticas",
  resolveContext(source) {
    return createThanosContext({
      workspaceKey: syntheticWorkspaceKey,
      tenantId: source.tenantId,
      domain: syntheticDomain,
      userId: source.userId,
      userName: source.userName,
      role: source.role,
      capabilities: capabilitiesForSyntheticWorkspace(),
      channel: source.channel,
      ...(source.conversationId === undefined ? {} : { conversationId: source.conversationId }),
      requestId: source.requestId,
    });
  },
});

export const syntheticSkillDefinition: SkillDefinition = Object.freeze({
  key: "synthetic-operations-readonly",
  workspaceKey: syntheticWorkspaceKey,
  domain: syntheticDomain,
  description: "Skill sintética para provar consultas READ sem dependência do domínio Pastoral.",
  allowedTools: Object.freeze(["listar_pendencias_sinteticas"]),
  allowedChannels: Object.freeze(["chat"] as const),
  requiredCapabilities: Object.freeze(["agent:read"] as const),
  readOnly: true,
});

export const syntheticWriteSkillDefinition: SkillDefinition = Object.freeze({
  key: "synthetic-operations-governed-write",
  workspaceKey: syntheticWorkspaceKey,
  domain: syntheticDomain,
  description: "Skill sintética para provar WRITE determinístico com confirmação governada e grant consumível.",
  allowedTools: Object.freeze(["synthetic:item:create"]),
  allowedChannels: Object.freeze(["chat"] as const),
  requiredCapabilities: Object.freeze(["agent:write"] as const),
  readOnly: false,
});

export const syntheticWorkspaceIdentity = Object.freeze({ workspaceKey: syntheticWorkspaceKey, domain: syntheticDomain });

export function createSyntheticWorkspaceSource(input: Readonly<{
  tenantId: string;
  userId: number;
  userName: string;
  role: string;
  channel: ThanosChannel;
  conversationId?: number;
  requestId: string;
}>): SyntheticWorkspaceSource {
  return Object.freeze({
    tenantId: toTenantId(input.tenantId),
    userId: input.userId,
    userName: input.userName,
    role: input.role,
    channel: input.channel,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    requestId: input.requestId,
  });
}
