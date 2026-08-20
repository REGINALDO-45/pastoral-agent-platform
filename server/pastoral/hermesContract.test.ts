import { describe, expect, it } from "vitest";
import { HermesClient, HermesUnavailableError } from "./hermesClient";
import { hermesRequestSchema, hermesResponseSchema } from "./hermesContract";

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
  it("aceita somente request v1 allowlisted e rejeita secrets ou campos adicionais", () => {
    const valid = hermesRequestSchema.safeParse({
      version: "v1",
      requestId: "request-1",
      model: "hermes-pilot",
      system: "instrução sanitizada",
      user: "evidência necessária",
      fallback: "resposta local",
    });
    const forbidden = hermesRequestSchema.safeParse({
      version: "v1",
      requestId: "request-1",
      model: "hermes-pilot",
      system: "instrução sanitizada",
      user: "evidência necessária",
      fallback: "resposta local",
      apiKey: "secret",
      promptPrivate: "não enviar",
    });

    expect(valid.success).toBe(true);
    expect(forbidden.success).toBe(false);
  });

  it("rejeita response com campos não allowlisted", () => {
    expect(
      hermesResponseSchema.safeParse({
        content: "Resposta segura",
        model: "hermes-pilot",
      }).success
    ).toBe(true);
    expect(
      hermesResponseSchema.safeParse({
        content: "Resposta segura",
        model: "hermes-pilot",
        stackTrace: "private",
      }).success
    ).toBe(false);
  });

  it("não envia secrets e classifica schema inválido como falha transportável", async () => {
    const attempts: unknown[] = [];
    const client = new HermesClient(
      async (_url, init) => {
        expect(init?.headers).toEqual({
          "Content-Type": "application/json",
          Authorization: "Bearer secret-not-returned",
        });
        const request = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        expect(request).not.toHaveProperty("apiKey");
        expect(request).not.toHaveProperty("promptPrivate");
        return new Response(
          JSON.stringify({
            content: "Resposta segura",
            model: "hermes-pilot",
            stackTrace: "private",
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
