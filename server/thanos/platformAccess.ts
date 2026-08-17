export const platformCapabilityNames = [
  "platform:tenant:list",
  "platform:tenant:read",
  "platform:tenant:assume",
  "platform:audit:read",
] as const;

export type PlatformCapability = (typeof platformCapabilityNames)[number];
export type PlatformRole = "none" | "superadmin";

export type PlatformAccess = Readonly<{
  role: PlatformRole;
  capabilities: readonly PlatformCapability[];
}>;

export class PlatformAuthorizationError extends Error {
  constructor(message = "Platform capability não autorizada.") {
    super(message);
    this.name = "PlatformAuthorizationError";
  }
}

const knownPlatformCapabilities = new Set<string>(platformCapabilityNames);

function uniquePlatformCapabilities(capabilities: readonly string[]): readonly PlatformCapability[] {
  const unknown = capabilities.find(capability => !knownPlatformCapabilities.has(capability));
  if (unknown) {
    throw new PlatformAuthorizationError(`Platform capability desconhecida: ${unknown}.`);
  }

  return Object.freeze(Array.from(new Set(capabilities)).sort() as PlatformCapability[]);
}

export function createPlatformAccess(input: Readonly<{
  role?: PlatformRole;
  capabilities?: readonly string[];
}> = {}): PlatformAccess {
  const role = input.role ?? "none";
  const capabilities = uniquePlatformCapabilities(input.capabilities ?? []);

  if (role === "none" && capabilities.length > 0) {
    throw new PlatformAuthorizationError("Platform capabilities exigem um platform role explícito.");
  }
  if (role === "superadmin" && capabilities.length === 0) {
    return Object.freeze({ role, capabilities });
  }

  return Object.freeze({ role, capabilities });
}

export function assertPlatformCapability(access: PlatformAccess, capability: PlatformCapability): void {
  if (access.role !== "superadmin" || !access.capabilities.includes(capability)) {
    throw new PlatformAuthorizationError();
  }
}

export function hasPlatformCapability(access: PlatformAccess, capability: PlatformCapability): boolean {
  return access.role === "superadmin" && access.capabilities.includes(capability);
}

export const noPlatformAccess: PlatformAccess = Object.freeze({ role: "none", capabilities: Object.freeze([]) });
