import type { ThanosChannel, ThanosContext } from "./contracts";
import { createPlatformAccess, assertPlatformCapability, type PlatformCapability, type PlatformRole } from "./platformAccess";
import { createThanosContextIdentity, type Domain, type TenantId, type WorkspaceKey } from "./contextIdentity";

export type CreateThanosContextInput = Readonly<{
  workspaceKey: WorkspaceKey;
  tenantId: TenantId;
  domain: Domain;
  userId: number;
  userName: string;
  role: string;
  capabilities: readonly string[];
  platformRole?: PlatformRole;
  platformCapabilities?: readonly string[];
  channel: ThanosChannel;
  conversationId?: number;
  requestId: string;
}>;

function uniqueCapabilities(capabilities: readonly string[]): readonly string[] {
  return Object.freeze(Array.from(new Set(capabilities)).sort());
}

export function createThanosContext(input: CreateThanosContextInput): ThanosContext {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) {
    throw new Error("userId deve ser um inteiro positivo no ThanosContext.");
  }
  if (!input.requestId.trim()) {
    throw new Error("requestId é obrigatório no ThanosContext.");
  }
  if (input.conversationId !== undefined && (!Number.isSafeInteger(input.conversationId) || input.conversationId <= 0)) {
    throw new Error("conversationId deve ser um inteiro positivo quando informado.");
  }

  const platformAccess = createPlatformAccess({ role: input.platformRole, capabilities: input.platformCapabilities });

  return Object.freeze({
    ...createThanosContextIdentity(input),
    userId: input.userId,
    userName: input.userName,
    role: input.role,
    capabilities: uniqueCapabilities(input.capabilities) as ThanosContext["capabilities"],
    platformRole: platformAccess.role,
    platformCapabilities: platformAccess.capabilities,
    channel: input.channel,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    requestId: input.requestId,
  });
}

export function assertThanosCapability(context: ThanosContext, capability: string): void {
  if (!context.capabilities.includes(capability as ThanosContext["capabilities"][number])) {
    throw new Error("Capability não autorizada para o contexto THÁNOS.");
  }
}

export function assertThanosPlatformCapability(context: ThanosContext, capability: PlatformCapability): void {
  assertPlatformCapability({ role: context.platformRole, capabilities: context.platformCapabilities }, capability);
}
