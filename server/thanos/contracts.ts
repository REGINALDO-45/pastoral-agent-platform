import type { Domain, TenantId, ThanosContextIdentity, WorkspaceKey } from "./contextIdentity";
import type { PlatformCapability, PlatformRole } from "./platformAccess";

export type ThanosCapability = "agent:read" | "agent:write" | "dashboard:read" | "settings:manage";
export type ThanosChannel = "chat" | "voice";

export type ThanosContext = Readonly<
  ThanosContextIdentity & {
    userId: number;
    userName: string;
    /** Role resolvido pela membership do tenant atual. */
    role: string;
    /** Capabilities concedidas no workspace/tenant atual. */
    capabilities: readonly ThanosCapability[];
    /** Role de plataforma, resolvido separadamente e deny-by-default. */
    platformRole: PlatformRole;
    /** Capabilities globais explícitas; nunca derivadas de `role`. */
    platformCapabilities: readonly PlatformCapability[];
    channel: ThanosChannel;
    conversationId?: number;
    requestId: string;
  }
>;

export type WorkspaceDefinition<TSourceContext> = Readonly<{
  workspaceKey: WorkspaceKey;
  domain: Domain;
  displayName: string;
  resolveContext(source: TSourceContext): ThanosContext;
}>;

export type SkillDefinition = Readonly<{
  key: string;
  workspaceKey: WorkspaceKey;
  domain: Domain;
  description: string;
  allowedTools: readonly string[];
  allowedChannels: readonly ThanosChannel[];
  requiredCapabilities: readonly ThanosCapability[];
  readOnly: boolean;
}>;

export type WorkspaceRegistration<TSourceContext> = WorkspaceDefinition<TSourceContext>;

export type ResolvedWorkspace = Readonly<{
  workspaceKey: WorkspaceKey;
  domain: Domain;
}>;

export type ContextIdentityFields = Readonly<{
  workspaceKey: WorkspaceKey;
  tenantId: TenantId;
  domain: Domain;
}>;
