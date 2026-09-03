import { describe, expect, it } from "vitest";
import { HermesClient, HermesUnavailableError } from "./hermesClient";

const config = {
  enabled: true,
  provider: "hermes" as const,
  model: "hermes-pilot",
  hermesOrganizationIds: [1],
  hermes: { enabled: true, configured: true, model: "hermes-pilot", timeoutMs: 25, retries: 1, circuitFailureThreshold: 2, circuitCooldownMs: 100 },
};

function chatCompletion(content: string, model = "hermes-agent") {
  return { id: "chatcmpl-test", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] };
}

describe("cliente Hermes resiliente", () => {
  it("tenta novamente uma falha transitória e mantém apenas estado sanitizado", async () => {
    let calls = 0;
    const client = new HermesClient(async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return new Response(null, { status: 204 });
    }, () => 100, "https://hermes.example/", "secret-not-returned");

    const result = await client.probe(config, undefined, "organization:1");
    const status = client.getStatus(config, "organization:1");

    expect(result).toEqual({ connected: true, attempts: 2, latencyMs: 0, failure: null });
    expect(status).toMatchObject({ connection: "connected", retries: 1, lastFailure: null });
    expect(JSON.stringify(status)).not.toMatch(/secret|example|url|key|token/i);
  });

  it("abre o circuito após falhas consecutivas e evita novas chamadas até o cooldown", async () => {
    let calls = 0;
    let clock = 100;
    const client = new HermesClient(async () => {
      calls += 1;
      throw new Error("offline");
    }, () => clock, "https://hermes.example/", "secret-not-returned");
    const noRetryConfig = { ...config, hermes: { ...config.hermes, retries: 0 } };

    await client.probe(noRetryConfig, undefined, "organization:1");
    await client.probe(noRetryConfig, undefined, "organization:1");
    const blocked = await client.probe(noRetryConfig, undefined, "organization:1");

    expect(blocked).toMatchObject({ connected: false, attempts: 0, failure: "circuit_open" });
    expect(calls).toBe(2);
    clock += 101;
    expect(client.getStatus(noRetryConfig, "organization:1").connection).toBe("degraded");
  });

  it.each([
    ["network_error", async () => { throw new Error("private network detail"); }],
    ["response_error", async () => new Response(JSON.stringify({ error: "private upstream detail" }), { status: 503 })],
    ["response_error", async () => new Response(JSON.stringify(chatCompletion("")), { status: 200 })],
    ["response_error", async () => new Response("{invalid-json", { status: 200 })],
  ] as const)("classifica %s na geração sem expor o erro bruto", async (failure, fetcher) => {
    const attempts: unknown[] = [];
    const client = new HermesClient(fetcher, () => 100, "https://hermes.example/", "secret-not-returned");
    const noRetryConfig = { ...config, hermes: { ...config.hermes, retries: 0 } };

    let captured: unknown;
    try {
      await client.generate(noRetryConfig, { requestId: "failure-request", system: "Sistema", user: "Resumo autorizado", fallback: "Fallback", isolationKey: "organization:1" }, attempt => {
        attempts.push(attempt);
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(HermesUnavailableError);
    expect(captured).toMatchObject({ failure });
    expect(attempts).toEqual([expect.objectContaining({ attempt: 1, success: false, failure })]);
    expect(JSON.stringify({ captured: String(captured), attempts, status: client.getStatus(noRetryConfig, "organization:1") })).not.toMatch(/private|secret-not-returned|hermes\.example/i);
  });

  const validInput = {
    requestId: "valid-request",
    system: "Sistema sintético",
    user: "Resumo autorizado",
    fallback: "Fallback local",
    isolationKey: "organization:1",
  };

  async function expectInvalidRequest(input: typeof validInput, model = config.model) {
    let calls = 0;
    const attempts: unknown[] = [];
    const client = new HermesClient(async () => {
      calls += 1;
      return new Response(JSON.stringify(chatCompletion("unexpected")), { status: 200 });
    }, () => 100, "https://hermes.example/", "secret-not-returned");
    const requestConfig = { ...config, model, hermes: { ...config.hermes, retries: 2 } };

    let captured: unknown;
    try {
      await client.generate(requestConfig, input, attempt => {
        attempts.push(attempt);
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(HermesUnavailableError);
    expect(captured).toMatchObject({ failure: "invalid_request" });
    expect(calls).toBe(0);
    expect(attempts).toEqual([]);
    expect(JSON.stringify({ captured, attempts })).not.toMatch(/secret-not-returned|private|zod|stack/i);
  }

  it("classifica requestId vazio como invalid_request sem fetch nem retry", async () => {
    await expectInvalidRequest({ ...validInput, requestId: "" });
  });

  it("classifica requestId acima do limite como invalid_request sem fetch nem retry", async () => {
    await expectInvalidRequest({ ...validInput, requestId: "x".repeat(129) });
  });

  it("classifica requestId inseguro para header como invalid_request sem fetch nem retry", async () => {
    await expectInvalidRequest({ ...validInput, requestId: "unsafe\r\nheader" });
  });

  it("classifica model inválido como invalid_request sem fetch nem retry", async () => {
    await expectInvalidRequest(validInput, "x".repeat(161));
  });

  it("classifica system acima do limite como invalid_request sem fetch nem retry", async () => {
    await expectInvalidRequest({ ...validInput, system: "x".repeat(20_001) });
  });

  it("classifica user acima do limite como invalid_request sem fetch nem retry", async () => {
    await expectInvalidRequest({ ...validInput, user: "x".repeat(20_001) });
  });

  it("classifica fallback acima do limite como invalid_request sem fetch nem retry", async () => {
    await expectInvalidRequest({ ...validInput, fallback: "x".repeat(20_001) });
  });

  it("usa o endpoint e o contrato oficiais sem enviar fallback ou autoridade THÁNOS", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new HermesClient(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(chatCompletion("HERMES_THANOS_OK")), { status: 200 });
    }, () => 100, "https://hermes.example/", "secret-not-returned");

    const generated = await client.generate(config, validInput);

    expect(generated).toEqual({ content: "HERMES_THANOS_OK", provider: "hermes", model: "hermes-agent" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://hermes.example/v1/chat/completions");
    expect(calls[0].init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer secret-not-returned",
      "Idempotency-Key": "valid-request",
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      model: "hermes-pilot",
      messages: [
        { role: "system", content: "Sistema sintético" },
        { role: "user", content: "Resumo autorizado" },
      ],
      stream: false,
    });
    expect(String(calls[0].init?.body)).not.toMatch(/fallback|requestId|tenant|workspace|capabilit/i);
  });

  it("recusa base não HTTPS antes do fetch", async () => {
    let calls = 0;
    const client = new HermesClient(async () => {
      calls += 1;
      return new Response(JSON.stringify(chatCompletion("unexpected")), { status: 200 });
    }, () => 100, "http://hermes.example/", "secret-not-returned");

    await expect(client.generate(config, validInput)).rejects.toMatchObject({ failure: "invalid_request" });
    expect(calls).toBe(0);
  });

  it("classifica timeout e encerra a tentativa pelo AbortSignal", async () => {
    const client = new HermesClient((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("private timeout detail", "AbortError")), { once: true });
    }), Date.now, "https://hermes.example/", "secret-not-returned");
    const timeoutConfig = { ...config, hermes: { ...config.hermes, timeoutMs: 5, retries: 0 } };

    await expect(client.generate(timeoutConfig, {
      requestId: "timeout-request",
      system: "Sistema",
      user: "Resumo autorizado",
      fallback: "Fallback",
      isolationKey: "organization:1",
    })).rejects.toMatchObject({ failure: "timeout" });
    expect(client.getStatus(timeoutConfig, "organization:1")).toMatchObject({ connection: "degraded", lastFailure: "timeout" });
  });

  it("mantém o timeout ativo enquanto consome o corpo da resposta", async () => {
    const client = new HermesClient((_url, init) => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("private body timeout", "AbortError")), { once: true });
      },
    }))), Date.now, "https://hermes.example/", "secret-not-returned");
    const timeoutConfig = { ...config, hermes: { ...config.hermes, timeoutMs: 5, retries: 0 } };
    const generation = client.generate(timeoutConfig, {
      requestId: "body-timeout-request",
      system: "Sistema",
      user: "Resumo autorizado",
      fallback: "Fallback",
      isolationKey: "organization:1",
    }).then(() => "unexpected_success", error => error instanceof HermesUnavailableError ? error.failure : "unexpected_error");

    const outcome = await Promise.race([
      generation,
      new Promise<string>(resolve => setTimeout(() => resolve("body_timeout_not_enforced"), 50)),
    ]);

    expect(outcome).toBe("timeout");
  });

  it("abre o circuito também na geração e bloqueia a chamada seguinte", async () => {
    let calls = 0;
    const client = new HermesClient(async () => {
      calls += 1;
      throw new Error("private network detail");
    }, () => 100, "https://hermes.example/", "secret-not-returned");
    const noRetryConfig = { ...config, hermes: { ...config.hermes, retries: 0 } };
    const input = { requestId: "circuit-request", system: "Sistema", user: "Resumo autorizado", fallback: "Fallback", isolationKey: "organization:1" };

    await expect(client.generate(noRetryConfig, input)).rejects.toMatchObject({ failure: "network_error" });
    await expect(client.generate(noRetryConfig, input)).rejects.toMatchObject({ failure: "network_error" });
    await expect(client.generate(noRetryConfig, input)).rejects.toMatchObject({ failure: "circuit_open" });
    expect(calls).toBe(2);
  });
});
