import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRouter } from "./modelRouter";

describe("ModelRouter OpenAI", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses GPT-6.1 Sol through Responses API with low reasoning by default", async () => {
    vi.stubEnv("AGENT_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "fixture-key");

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));

      expect(body).toMatchObject({
        model: "gpt-6.1-sol",
        instructions: "system",
        input: "user",
        reasoning: { effort: "low" },
        store: false,
      });
      expect(body.temperature).toBeUndefined();

      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Resposta segura" }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ModelRouter().generate({
        system: "system",
        user: "user",
        fallback: "fallback",
      }),
    ).resolves.toEqual({
      content: "Resposta segura",
      provider: "openai",
      model: "gpt-6.1-sol",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
  });

  it("concatenates every output_text part in Responses order", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: [
            { content: [{ type: "output_text", text: "Primeira parte" }] },
            { content: [
              { type: "output_text", text: "Segunda parte" },
              { type: "output_text", text: "Terceira parte" },
            ] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubEnv("AGENT_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "fixture-key");
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ModelRouter().generate({ system: "system", user: "user", fallback: "fallback" }),
    ).resolves.toEqual({
      content: "Primeira parte\nSegunda parte\nTerceira parte",
      provider: "openai",
      model: "gpt-6.1-sol",
    });
  });

  it("allows explicit higher reasoning effort and model override", async () => {
    vi.stubEnv("AGENT_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "fixture-key");
    vi.stubEnv("OPENAI_MODEL", "gpt-6-astra");
    vi.stubEnv("OPENAI_REASONING_EFFORT", "high");

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("gpt-6-astra");
      expect(body.reasoning).toEqual({ effort: "high" });

      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Revisão crítica" }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await new ModelRouter().generate({
      system: "system",
      user: "user",
      fallback: "fallback",
    });

    expect(result).toEqual({
      content: "Revisão crítica",
      provider: "openai",
      model: "gpt-6-astra",
    });
  });

  it("keeps a configured legacy OpenAI endpoint on the Chat Completions contract", async () => {
    vi.stubEnv("AGENT_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "fixture-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://fixture.example/v1/chat/completions");

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe("https://fixture.example/v1/chat/completions");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "gpt-6.1-sol",
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "user" },
        ],
      });
      expect(body).not.toHaveProperty("input");
      expect(body).not.toHaveProperty("reasoning_effort");

      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Compatível" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ModelRouter().generate({ system: "system", user: "user", fallback: "fallback" }),
    ).resolves.toEqual({
      content: "Compatível",
      provider: "openai",
      model: "gpt-6.1-sol",
    });
  });

  it("sends reasoning_effort to a legacy endpoint only when explicitly configured", async () => {
    vi.stubEnv("AGENT_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "fixture-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://fixture.example/v1/chat/completions");
    vi.stubEnv("OPENAI_REASONING_EFFORT", "high");

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.reasoning_effort).toBe("high");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Compatível com reasoning" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ModelRouter().generate({ system: "system", user: "user", fallback: "fallback" }),
    ).resolves.toMatchObject({ content: "Compatível com reasoning", provider: "openai" });
  });

  it("falls back deterministically when OpenAI is unavailable", async () => {
    vi.stubEnv("AGENT_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "fixture-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );

    await expect(
      new ModelRouter().generate({
        system: "system",
        user: "user",
        fallback: "fallback seguro",
      }),
    ).resolves.toEqual({
      content: "fallback seguro",
      provider: "deterministic",
      model: "pastoral-rules-v1",
    });
  });
});
