import type { ThanosContext } from "../../thanos/contracts";
import type { ThanosReadTool } from "../../thanos/orchestrator";

export const syntheticPendingReadTool: ThanosReadTool = Object.freeze({
  name: "listar_pendencias_sinteticas",
  requiredCapability: "agent:read",
  async execute(context: ThanosContext) {
    return {
      summary: `O workspace ${context.workspaceKey} possui 2 pendências sintéticas.`,
      data: {
        pending: 2,
        workspaceKey: String(context.workspaceKey),
        tenantId: String(context.tenantId),
        domain: String(context.domain),
      },
    };
  },
});
