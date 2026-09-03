import { z } from "zod";

export const HERMES_HEALTH_PATH = "health" as const;
export const HERMES_CHAT_COMPLETIONS_PATH = "v1/chat/completions" as const;

const hermesRequestIdSchema = z.string().trim().min(1).max(128).regex(/^[\x21-\x7e]+$/);

export const hermesGenerationInputSchema = z
  .object({
    requestId: hermesRequestIdSchema,
    model: z.string().trim().min(1).max(160),
    system: z.string().max(20_000),
    user: z.string().max(20_000),
    fallback: z.string().max(20_000),
  })
  .strict();

export const hermesRequestSchema = z
  .object({
    model: z.string().trim().min(1).max(160),
    messages: z.tuple([
      z.object({ role: z.literal("system"), content: z.string().max(20_000) }).strict(),
      z.object({ role: z.literal("user"), content: z.string().max(20_000) }).strict(),
    ]),
    stream: z.literal(false),
  })
  .strict();

const hermesChoiceSchema = z.object({
  message: z.object({ role: z.literal("assistant"), content: z.string().trim().min(1).max(4_000) }),
});

export const hermesResponseSchema = z
  .object({
    model: z.string().trim().min(1).max(160).optional(),
    choices: z.array(hermesChoiceSchema).min(1),
  })
  .strip();

export type HermesRequest = z.infer<typeof hermesRequestSchema>;
export type HermesResponse = z.infer<typeof hermesResponseSchema>;

export function isSecureHermesBaseUrl(value: string, productionHostDenylist = ""): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (_error) {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  const deniedHosts = new Set(productionHostDenylist.split(",").map(item => item.trim().toLowerCase()).filter(Boolean));
  return parsed.protocol === "https:"
    && Boolean(hostname)
    && !parsed.username
    && !parsed.password
    && !parsed.search
    && !parsed.hash
    && !deniedHosts.has(hostname)
    && !/(^|[.-])(prod|production|live)([.-]|$)/.test(hostname);
}

export function buildHermesEndpoint(baseUrl: string, path: string, productionHostDenylist = ""): string | null {
  if (!isSecureHermesBaseUrl(baseUrl, productionHostDenylist)) return null;
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

export function parseHermesResponse(
  payload: unknown
): { content: string; model: string } | null {
  const parsed = hermesResponseSchema.safeParse(payload);
  if (!parsed.success) return null;
  return {
    content: parsed.data.choices[0].message.content,
    model: parsed.data.model ?? "hermes-configured",
  };
}
