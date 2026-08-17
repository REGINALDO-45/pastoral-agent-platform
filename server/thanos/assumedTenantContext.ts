import { assertThanosPlatformCapability } from "./context";
import type { TenantId } from "./contextIdentity";
import type { ThanosContext } from "./contracts";

export type AssumedTenantAuditEvent = Readonly<{
  action: "thanos.tenant.assume" | "thanos.tenant.exit";
  status: "success" | "denied" | "failure";
  requestId: string;
  actorUserId: number;
  originalTenantId: TenantId;
  targetTenantId: TenantId;
  platformCapability: "platform:tenant:assume";
  context: "original" | "assumed";
  reason?: "platform_capability_missing" | "tenant_not_found" | "already_exited";
}>;

export type TenantDirectoryPort = Readonly<{
  exists(tenantId: TenantId): Promise<boolean>;
}>;

export type AssumedTenantAuditPort = Readonly<{
  record(event: AssumedTenantAuditEvent): Promise<void>;
}>;

export type AssumedTenantContext = Readonly<{
  assumed: true;
  actorUserId: number;
  originalContext: ThanosContext;
  targetTenantId: TenantId;
  platformCapability: "platform:tenant:assume";
  requestId: string;
  exit(): Promise<ThanosContext>;
}>;

export class TenantAssumptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantAssumptionError";
  }
}

async function recordDenied(
  audit: AssumedTenantAuditPort,
  context: ThanosContext,
  targetTenantId: TenantId,
  reason: AssumedTenantAuditEvent["reason"],
): Promise<never> {
  await audit.record({
    action: "thanos.tenant.assume",
    status: "denied",
    requestId: context.requestId,
    actorUserId: context.userId,
    originalTenantId: context.tenantId,
    targetTenantId,
    platformCapability: "platform:tenant:assume",
    context: "original",
    reason,
  });
  throw new TenantAssumptionError(reason === "tenant_not_found" ? "Tenant alvo não encontrado." : "Platform capability de assunção não autorizada.");
}

export async function assumeTenantContext(input: Readonly<{
  context: ThanosContext;
  targetTenantId: TenantId;
  directory: TenantDirectoryPort;
  audit: AssumedTenantAuditPort;
}>): Promise<AssumedTenantContext> {
  try {
    assertThanosPlatformCapability(input.context, "platform:tenant:assume");
  } catch {
    return recordDenied(input.audit, input.context, input.targetTenantId, "platform_capability_missing");
  }

  if (!(await input.directory.exists(input.targetTenantId))) {
    return recordDenied(input.audit, input.context, input.targetTenantId, "tenant_not_found");
  }

  await input.audit.record({
    action: "thanos.tenant.assume",
    status: "success",
    requestId: input.context.requestId,
    actorUserId: input.context.userId,
    originalTenantId: input.context.tenantId,
    targetTenantId: input.targetTenantId,
    platformCapability: "platform:tenant:assume",
    context: "assumed",
  });

  let exited = false;
  const exit = async (): Promise<ThanosContext> => {
    if (exited) {
      await input.audit.record({
        action: "thanos.tenant.exit",
        status: "denied",
        requestId: input.context.requestId,
        actorUserId: input.context.userId,
        originalTenantId: input.context.tenantId,
        targetTenantId: input.targetTenantId,
        platformCapability: "platform:tenant:assume",
        context: "assumed",
        reason: "already_exited",
      });
      return input.context;
    }

    exited = true;
    await input.audit.record({
      action: "thanos.tenant.exit",
      status: "success",
      requestId: input.context.requestId,
      actorUserId: input.context.userId,
      originalTenantId: input.context.tenantId,
      targetTenantId: input.targetTenantId,
      platformCapability: "platform:tenant:assume",
      context: "original",
    });
    return input.context;
  };

  return Object.freeze({
    assumed: true as const,
    actorUserId: input.context.userId,
    originalContext: input.context,
    targetTenantId: input.targetTenantId,
    platformCapability: "platform:tenant:assume" as const,
    requestId: input.context.requestId,
    exit,
  });
}
