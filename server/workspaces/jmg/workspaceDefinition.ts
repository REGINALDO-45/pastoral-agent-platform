import { createThanosContext } from "../../thanos/context";
import type {
  SkillDefinition,
  ThanosCapability,
  ThanosChannel,
  WorkspaceDefinition,
} from "../../thanos/contracts";
import {
  toDomain,
  toTenantId,
  toWorkspaceKey,
  type Domain,
  type TenantId,
  type WorkspaceKey,
} from "../../thanos/contextIdentity";
import { JMG_READ_TOOL } from "../../thanos/jmgReadContract";

export type JmgWorkspaceSource = Readonly<{
  userId: number;
  userName: string;
  role: string;
  channel: ThanosChannel;
  requestId: string;
}>;

const jmgWorkspaceKey: WorkspaceKey = toWorkspaceKey("jmg");
const jmgDomain: Domain = toDomain("jmg");
const jmgTenantScope: TenantId = toTenantId("workspace:jmg");

function capabilitiesForJmgWorkspace(): readonly ThanosCapability[] {
  return Object.freeze(["agent:read"] as const);
}

export const jmgWorkspaceDefinition: WorkspaceDefinition<JmgWorkspaceSource> =
  Object.freeze({
    workspaceKey: jmgWorkspaceKey,
    domain: jmgDomain,
    displayName: "JMG",
    resolveContext(source) {
      return createThanosContext({
        workspaceKey: jmgWorkspaceKey,
        tenantId: jmgTenantScope,
        domain: jmgDomain,
        userId: source.userId,
        userName: source.userName,
        role: source.role,
        capabilities: capabilitiesForJmgWorkspace(),
        channel: source.channel,
        requestId: source.requestId,
      });
    },
  });

export const jmgSkillDefinition: SkillDefinition = Object.freeze({
  key: "jmg-readonly",
  workspaceKey: jmgWorkspaceKey,
  domain: jmgDomain,
  description:
    "Skill JMG governada para uma única consulta comercial READ-only agregada.",
  allowedTools: Object.freeze([JMG_READ_TOOL]),
  allowedChannels: Object.freeze(["chat"] as const),
  requiredCapabilities: Object.freeze(["agent:read"] as const),
  readOnly: true,
});

export const jmgWorkspaceIdentity = Object.freeze({
  workspaceKey: jmgWorkspaceKey,
  domain: jmgDomain,
  tenantId: jmgTenantScope,
});

export function createJmgWorkspaceSource(
  input: Readonly<{
    userId: number;
    userName: string;
    role: string;
    channel: ThanosChannel;
    requestId: string;
  }>
): JmgWorkspaceSource {
  return Object.freeze({
    userId: input.userId,
    userName: input.userName,
    role: input.role,
    channel: input.channel,
    requestId: input.requestId,
  });
}
