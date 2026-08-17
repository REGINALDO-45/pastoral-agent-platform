declare const workspaceKeyBrand: unique symbol;
declare const tenantIdBrand: unique symbol;
declare const domainBrand: unique symbol;

export type WorkspaceKey = string & { readonly [workspaceKeyBrand]: "WorkspaceKey" };
export type TenantId = string & { readonly [tenantIdBrand]: "TenantId" };
export type Domain = string & { readonly [domainBrand]: "Domain" };

export type ThanosContextIdentity = Readonly<{
  workspaceKey: WorkspaceKey;
  tenantId: TenantId;
  domain: Domain;
}>;

function normalized(value: string, label: string): string {
  const candidate = value.trim();
  if (!candidate) {
    throw new Error(`${label} é obrigatório.`);
  }
  return candidate;
}

export function toWorkspaceKey(value: string): WorkspaceKey {
  return normalized(value, "workspaceKey") as WorkspaceKey;
}

export function toDomain(value: string): Domain {
  return normalized(value, "domain") as Domain;
}

export function tenantIdFromOrganizationId(organizationId: number): TenantId {
  if (!Number.isSafeInteger(organizationId) || organizationId <= 0) {
    throw new Error("organizationId deve ser um inteiro positivo para derivar tenantId.");
  }
  return `org:${organizationId}` as TenantId;
}

export function toTenantId(value: string): TenantId {
  return normalized(value, "tenantId") as TenantId;
}

export function createThanosContextIdentity(input: {
  workspaceKey: WorkspaceKey;
  tenantId: TenantId;
  domain: Domain;
}): ThanosContextIdentity {
  return Object.freeze({ ...input });
}
