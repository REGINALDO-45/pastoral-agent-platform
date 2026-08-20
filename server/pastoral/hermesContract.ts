import { z } from "zod";

export const HERMES_HEALTH_PATH = "health" as const;
export const HERMES_RESPOND_PATH = "v1/agent/respond" as const;

export const hermesRequestSchema = z
  .object({
    version: z.literal("v1"),
    requestId: z.string().trim().min(1).max(128),
    model: z.string().trim().min(1).max(160),
    system: z.string().max(20_000),
    user: z.string().max(20_000),
    fallback: z.string().max(20_000),
  })
  .strict();

export const hermesResponseSchema = z
  .object({
    content: z.string().trim().min(1).max(4_000),
    model: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export type HermesRequest = z.infer<typeof hermesRequestSchema>;
export type HermesResponse = z.infer<typeof hermesResponseSchema>;

export function parseHermesResponse(
  payload: unknown
): { content: string; model: string } | null {
  const parsed = hermesResponseSchema.safeParse(payload);
  if (!parsed.success) return null;
  return {
    content: parsed.data.content,
    model: parsed.data.model ?? "hermes-configured",
  };
}
