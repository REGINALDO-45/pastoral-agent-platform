import type { Domain, WorkspaceKey } from "../../thanos/contextIdentity";
import { toDomain, toWorkspaceKey } from "../../thanos/contextIdentity";
import type { SkillDefinition } from "../../thanos/contracts";
import { JMG_READ_TOOL } from "../../thanos/jmgReadContract";

export type JmgWorkspaceDeclaration = Readonly<{
  workspaceKey: WorkspaceKey;
  domain: Domain;
  displayName: string;
}>;

const jmgWorkspaceKey: WorkspaceKey = toWorkspaceKey("jmg");
const jmgDomain: Domain = toDomain("jmg");

/**
 * Declarative metadata only. It is intentionally not a WorkspaceDefinition:
 * this cycle must not resolve an operational ThanosContext or invent a tenant.
 */
export const jmgWorkspaceDeclaration: JmgWorkspaceDeclaration = Object.freeze({
  workspaceKey: jmgWorkspaceKey,
  domain: jmgDomain,
  displayName: "JMG",
});

export const jmgSkillDefinition: SkillDefinition = Object.freeze({
  key: "jmg-readonly",
  workspaceKey: jmgWorkspaceKey,
  domain: jmgDomain,
  description:
    "Declaração JMG para uma única consulta comercial READ-only agregada.",
  allowedTools: Object.freeze([JMG_READ_TOOL]),
  allowedChannels: Object.freeze(["chat"] as const),
  requiredCapabilities: Object.freeze(["agent:read"] as const),
  readOnly: true,
});

export const jmgWorkspaceIdentity = Object.freeze({
  workspaceKey: jmgWorkspaceKey,
  domain: jmgDomain,
});
