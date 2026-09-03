import { describe, expect, it } from "vitest";
import { HermesClient, HermesUnavailableError } from "./hermesClient";
import { buildHermesEndpoint, hermesGenerationInputSchema, hermesRequestSchema, hermesResponseSchema, isSecureHermesBaseUrl, parseHermesResponse } from "./hermesContract";

const config = {
  enabled: true,
  provider: "hermes" as const,
  hermesOrganizationIds: [1],
  model: "hermes-pilot",
  hermes: {
    enabled: true,
    configured: true,
    model: "hermes-pilot",
    timeoutMs: 25,
    retries: 0,
    circuitFailureThreshold: 3,
    circuitCooldownMs: 100,
  },
};

describe("contrato Hermes M19", () => {
  it("converte somente a entrada governada no request OpenAI-compatible allowlisted", () => {
    expect(hermesGenerationInputSchema.safeParse({
      requestId: "request-1",
      model: "hermes-agent",
      system: "instrução sanitizada",
      user: "evidência necessária",
      fallback: "resposta local",
    }).success).toBe(true);
    const valid = hermesRequestSchema.safeParse({
      model: "hermes-agent",
      messages: [
        { role: "system", content: "instrução sanitizada" },
        { role: "user", content: "evidência necessária" },
      ],
      stream: false,
    });
    const forbidden = hermesRequestSchema.safeParse({
      model: "hermes-agent",
      messages: [
        { role: "system", content: "instrução sanitizada" },
        { role: "user", content: "evidência necessária" },
      ],
      stream: false,
      apiKey: "secret",
    });

    expect(valid.success).toBe(true);
    expect(forbidden.success).toBe(false);
  });

  it("extrai somente choices[0].message.content e descarta metadados extras", () => {
    const payload = {
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "hermes-agent",
      choices: [{ index: 0, message: { role: "assistant", content: "Resposta segura" }, finish_reason: "stop" }],
      usage: { total_tokens: 10 },
      stackTrace: "private",
    };
    expect(hermesResponseSchema.safeParse(payload).success).toBe(true);
    expect(parseHermesResponse(payload)).toEqual({ content: "Resposta segura", model: "hermes-agent" });
    expect(JSON.stringify(parseHermesResponse(payload))).not.toMatch(/stackTrace|private|usage/i);
  });

  it("aceita somente base HTTPS sem credenciais, query ou host produtivo", () => {
    expect(isSecureHermesBaseUrl("https://hermes-thanos-163-176-174-128.sslip.io")).toBe(true);
    expect(buildHermesEndpoint("https://hermes-thanos-163-176-174-128.sslip.io", "v1/chat/completions")).toBe("https://hermes-thanos-163-176-174-128.sslip.io/v1/chat/completions");
    expect(isSecureHermesBaseUrl("http://hermes.example")).toBe(false);
    expect(isSecureHermesBaseUrl("ftp://hermes.example")).toBe(false);
    expect(isSecureHermesBaseUrl("wss://hermes.example")).toBe(false);
    expect(isSecureHermesBaseUrl("https://user:pass@hermes.example")).toBe(false);
    expect(isSecureHermesBaseUrl("https://hermes.example?token=private")).toBe(false);
    expect(isSecureHermesBaseUrl("https://hermes-prod.example")).toBe(false);
    expect(isSecureHermesBaseUrl("https://hermes.example", "hermes.example")).toBe(false);
  });

  it("não envia secrets e classifica schema inválido como falha transportável", async () => {
    const attempts: unknown[] = [];
    const client = new HermesClient(
      async (_url, init) => {
        expect(init?.headers).toEqual({
          "Content-Type": "application/json",
          Authorization: "Bearer secret-not-returned",
          "Idempotency-Key": "request-invalid-response",
        });
        const request = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        expect(request).not.toHaveProperty("apiKey");
        expect(request).not.toHaveProperty("promptPrivate");
        return new Response(
          JSON.stringify({
            model: "hermes-agent",
            choices: [{ message: { role: "assistant", content: "" } }],
          }),
          { status: 200 }
        );
      },
      () => 100,
      "https://hermes.example/",
      "secret-not-returned"
    );

    await expect(
      client.generate(
        config,
        {
          requestId: "request-invalid-response",
          system: "sanitizado",
          user: "evidência",
          fallback: "local",
          isolationKey: "organization:1",
        },
        attempt => attempts.push(attempt)
      )
    ).rejects.toEqual(expect.any(HermesUnavailableError));
    expect(attempts).toEqual([
      expect.objectContaining({ success: false, failure: "response_error" }),
    ]);
  });
});
