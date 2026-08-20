import { ENV } from "../_core/env";
import type { AgentGatewayRuntimeConfig } from "./gatewayConfig";
import { HERMES_HEALTH_PATH, HERMES_RESPOND_PATH, hermesRequestSchema, parseHermesResponse } from "./hermesContract";

export type HermesFailureCode = "disabled" | "unconfigured" | "circuit_open" | "timeout" | "network_error" | "response_error";
export type HermesConnectionStatus = "disabled" | "unconfigured" | "unknown" | "connected" | "degraded" | "circuit_open";

export type HermesSanitizedStatus = {
  enabled: boolean;
  configured: boolean;
  connection: HermesConnectionStatus;
  model: string;
  timeoutMs: number;
  retries: number;
  latencyMs: number | null;
  lastFailure: HermesFailureCode | null;
};

type HermesProbeResult = {
  connected: boolean;
  attempts: number;
  latencyMs: number | null;
  failure: HermesFailureCode | null;
};

export type HermesAttempt = {
  attempt: number;
  success: boolean;
  latencyMs: number | null;
  failure: HermesFailureCode | null;
};

export class HermesUnavailableError extends Error {
  constructor(readonly failure: HermesFailureCode) {
    super(`Hermes indisponível: ${failure}`);
    this.name = "HermesUnavailableError";
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type AttemptListener = (attempt: HermesAttempt) => void | Promise<void>;
type HermesCircuitState = {
  failures: number;
  openUntil: number;
  latencyMs: number | null;
  lastFailure: HermesFailureCode | null;
  lastConnection: HermesConnectionStatus;
};

function createCircuitState(): HermesCircuitState {
  return { failures: 0, openUntil: 0, latencyMs: null, lastFailure: null, lastConnection: "unknown" };
}

export class HermesClient {
  private readonly circuitStates = new Map<string, HermesCircuitState>();

  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly now: () => number = Date.now,
    private readonly baseUrl = ENV.hermesBaseUrl,
    private readonly apiKey = ENV.hermesApiKey,
  ) {}

  getStatus(config: AgentGatewayRuntimeConfig, isolationKey: string): HermesSanitizedStatus {
    const base = config.hermes;
    const state = this.circuitState(isolationKey);
    if (!base.enabled) return { enabled: false, configured: base.configured, connection: "disabled", model: base.model, timeoutMs: base.timeoutMs, retries: base.retries, latencyMs: null, lastFailure: null };
    if (!base.configured) return { enabled: true, configured: false, connection: "unconfigured", model: base.model, timeoutMs: base.timeoutMs, retries: base.retries, latencyMs: null, lastFailure: "unconfigured" };
    if (this.now() < state.openUntil) return { enabled: true, configured: true, connection: "circuit_open", model: base.model, timeoutMs: base.timeoutMs, retries: base.retries, latencyMs: state.latencyMs, lastFailure: "circuit_open" };
    return { enabled: true, configured: true, connection: state.lastConnection, model: base.model, timeoutMs: base.timeoutMs, retries: base.retries, latencyMs: state.latencyMs, lastFailure: state.lastFailure };
  }

  async probe(config: AgentGatewayRuntimeConfig, onAttempt: AttemptListener | undefined, isolationKey: string): Promise<HermesProbeResult> {
    const state = this.circuitState(isolationKey);
    const status = this.getStatus(config, isolationKey);
    if (status.connection === "disabled") return { connected: false, attempts: 0, latencyMs: null, failure: "disabled" };
    if (status.connection === "unconfigured") return { connected: false, attempts: 0, latencyMs: null, failure: "unconfigured" };
    if (status.connection === "circuit_open") return { connected: false, attempts: 0, latencyMs: status.latencyMs, failure: "circuit_open" };

    let lastFailure: HermesFailureCode = "network_error";
    const attempts = config.hermes.retries + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const startedAt = this.now();
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), config.hermes.timeoutMs);
      try {
        const endpoint = new URL(HERMES_HEALTH_PATH, this.baseUrl).toString();
        const response = await this.fetcher(endpoint, { method: "GET", headers: { Authorization: `Bearer ${this.apiKey}` }, signal: abort.signal });
        if (!response.ok) {
          lastFailure = "response_error";
          await this.notifyAttempt(onAttempt, { attempt, success: false, latencyMs: null, failure: lastFailure });
          continue;
        }
        state.latencyMs = Math.max(0, this.now() - startedAt);
        state.failures = 0;
        state.openUntil = 0;
        state.lastFailure = null;
        state.lastConnection = "connected";
        await this.notifyAttempt(onAttempt, { attempt, success: true, latencyMs: state.latencyMs, failure: null });
        return { connected: true, attempts: attempt, latencyMs: state.latencyMs, failure: null };
      } catch (error) {
        lastFailure = error instanceof DOMException && error.name === "AbortError" ? "timeout" : "network_error";
        await this.notifyAttempt(onAttempt, { attempt, success: false, latencyMs: null, failure: lastFailure });
      } finally {
        clearTimeout(timer);
      }
    }

    state.failures += 1;
    state.lastFailure = lastFailure;
    state.lastConnection = "degraded";
    if (state.failures >= config.hermes.circuitFailureThreshold) state.openUntil = this.now() + config.hermes.circuitCooldownMs;
    return { connected: false, attempts, latencyMs: state.latencyMs, failure: lastFailure };
  }

  async generate(
    config: AgentGatewayRuntimeConfig,
    input: { requestId: string; system: string; user: string; fallback: string; isolationKey: string },
    onAttempt?: AttemptListener,
  ): Promise<{ content: string; provider: "hermes"; model: string }> {
    const isolationKey = input.isolationKey;
    const state = this.circuitState(isolationKey);
    const status = this.getStatus(config, isolationKey);
    if (status.connection === "disabled") throw new HermesUnavailableError("disabled");
    if (status.connection === "unconfigured") throw new HermesUnavailableError("unconfigured");
    if (status.connection === "circuit_open") throw new HermesUnavailableError("circuit_open");

    let lastFailure: HermesFailureCode = "network_error";
    const attempts = config.hermes.retries + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const startedAt = this.now();
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), config.hermes.timeoutMs);
      try {
        const endpoint = new URL(HERMES_RESPOND_PATH, this.baseUrl).toString();
        const response = await this.fetcher(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          signal: abort.signal,
          body: JSON.stringify(hermesRequestSchema.parse({ version: "v1", requestId: input.requestId, model: config.model, system: input.system, user: input.user, fallback: input.fallback })),
        });
        if (!response.ok) {
          lastFailure = "response_error";
          await this.notifyAttempt(onAttempt, { attempt, success: false, latencyMs: null, failure: lastFailure });
          continue;
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") throw error;
          lastFailure = "response_error";
          await this.notifyAttempt(onAttempt, { attempt, success: false, latencyMs: null, failure: lastFailure });
          continue;
        }
        const generated = parseHermesResponse(payload);
        if (!generated) {
          lastFailure = "response_error";
          await this.notifyAttempt(onAttempt, { attempt, success: false, latencyMs: null, failure: lastFailure });
          continue;
        }
        state.latencyMs = Math.max(0, this.now() - startedAt);
        state.failures = 0;
        state.openUntil = 0;
        state.lastFailure = null;
        state.lastConnection = "connected";
        await this.notifyAttempt(onAttempt, { attempt, success: true, latencyMs: state.latencyMs, failure: null });
        return { content: generated.content, provider: "hermes", model: generated.model };
      } catch (error) {
        lastFailure = error instanceof DOMException && error.name === "AbortError" ? "timeout" : "network_error";
        await this.notifyAttempt(onAttempt, { attempt, success: false, latencyMs: null, failure: lastFailure });
      } finally {
        clearTimeout(timer);
      }
    }

    state.failures += 1;
    state.lastFailure = lastFailure;
    state.lastConnection = "degraded";
    if (state.failures >= config.hermes.circuitFailureThreshold) state.openUntil = this.now() + config.hermes.circuitCooldownMs;
    throw new HermesUnavailableError(lastFailure);
  }

  private circuitState(isolationKey: string): HermesCircuitState {
    const existing = this.circuitStates.get(isolationKey);
    if (existing) return existing;
    const created = createCircuitState();
    this.circuitStates.set(isolationKey, created);
    return created;
  }

  private async notifyAttempt(listener: AttemptListener | undefined, attempt: HermesAttempt) {
    try {
      await listener?.(attempt);
    } catch (_error) {
      // Telemetria não altera o resultado nem a classificação do transporte Hermes.
    }
  }
}
