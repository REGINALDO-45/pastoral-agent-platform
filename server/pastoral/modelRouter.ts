export type ModelProvider = "openai" | "anthropic" | "gemini" | "openrouter" | "hermes" | "deterministic";

export type ModelGenerationInput = {
  system: string;
  user: string;
  fallback: string;
};

export type ModelGenerationResult = {
  content: string;
  provider: ModelProvider;
  model: string;
  gateway?: {
    version: "v1";
    provider: "legacy" | "hermes";
    fallback: boolean;
    fallbackReason?: "gateway_disabled" | "hermes_unavailable" | "hermes_circuit_open" | "hermes_invalid_request";
  };
};

type ProviderConfiguration = {
  provider: Exclude<ModelProvider, "deterministic">;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
};

function configuredProvider(): ProviderConfiguration | null {
  const requested = process.env.AGENT_PROVIDER?.toLowerCase();
  const options: ProviderConfiguration[] = [
    { provider: "openai", apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, baseUrl: process.env.OPENAI_BASE_URL },
    { provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL, baseUrl: process.env.ANTHROPIC_BASE_URL },
    { provider: "gemini", apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL, baseUrl: process.env.GEMINI_BASE_URL },
    { provider: "openrouter", apiKey: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL, baseUrl: process.env.OPENROUTER_BASE_URL },
  ];
  if (!requested || requested === "deterministic") return null;
  return options.find(option => option.provider === requested && option.apiKey) ?? null;
}

async function readJson(response: Response) {
  if (!response.ok) throw new Error(`Provider retornou ${response.status}`);
  return response.json() as Promise<Record<string, any>>;
}

export class ModelRouter {
  async generate(input: ModelGenerationInput): Promise<ModelGenerationResult> {
    const configuration = configuredProvider();
    if (!configuration) {
      return { content: input.fallback, provider: "deterministic", model: "pastoral-rules-v1" };
    }

    try {
      if (configuration.provider === "openai" || configuration.provider === "openrouter") {
        const endpoint = configuration.baseUrl ?? (configuration.provider === "openrouter"
          ? "https://openrouter.ai/api/v1/chat/completions"
          : "https://api.openai.com/v1/chat/completions");
        const payload = await readJson(await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${configuration.apiKey}` },
          body: JSON.stringify({
            model: configuration.model ?? (configuration.provider === "openrouter" ? "openai/gpt-4o-mini" : "gpt-4o-mini"),
            messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }],
            temperature: 0.2,
          }),
        }));
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content === "string" && content.trim()) {
          return { content, provider: configuration.provider, model: configuration.model ?? "configured-model" };
        }
      }

      if (configuration.provider === "anthropic") {
        const endpoint = configuration.baseUrl ?? "https://api.anthropic.com/v1/messages";
        const payload = await readJson(await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": configuration.apiKey!, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: configuration.model ?? "claude-3-5-haiku-latest", max_tokens: 500, system: input.system, messages: [{ role: "user", content: input.user }] }),
        }));
        const content = payload.content?.[0]?.text;
        if (typeof content === "string" && content.trim()) {
          return { content, provider: "anthropic", model: configuration.model ?? "configured-model" };
        }
      }

      if (configuration.provider === "gemini") {
        const model = configuration.model ?? "gemini-1.5-flash";
        const baseUrl = configuration.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
        const endpoint = `${baseUrl}/models/${model}:generateContent?key=${configuration.apiKey}`;
        const payload = await readJson(await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: input.system }] }, contents: [{ parts: [{ text: input.user }] }] }),
        }));
        const content = payload.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("");
        if (typeof content === "string" && content.trim()) {
          return { content, provider: "gemini", model };
        }
      }
    } catch (error) {
      console.warn("[ModelRouter] Provider indisponível; usando resposta determinística.", error instanceof Error ? error.message : error);
    }

    return { content: input.fallback, provider: "deterministic", model: "pastoral-rules-v1" };
  }
}
