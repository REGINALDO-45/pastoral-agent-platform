import { assertThanosCapability } from "./context";
import type { ThanosCapability, ThanosContext } from "./contracts";

export type ThanosConfirmationStatus = "pending" | "confirmed" | "duplicate" | "denied" | "failed";

export type ThanosConfirmationRecord<TPrepared> = Readonly<{
  confirmationId: string;
  idempotencyKey: string;
  operation: string;
  context: ThanosContext;
  prepared: TPrepared;
  status: "pending" | "confirmed" | "duplicate";
  requestId: string;
}>;

export type ThanosConfirmationResult<TResult> = Readonly<{
  confirmationId: string;
  idempotencyKey: string;
  operation: string;
  requestId: string;
  status: "confirmed" | "duplicate";
  result?: TResult;
}>;

export type ThanosConfirmationOperation<TInput, TPrepared, TResult> = Readonly<{
  name: string;
  intent: "WRITE";
  requiredCapability: ThanosCapability;
  prepare(context: ThanosContext, input: TInput): Promise<TPrepared>;
  execute(context: ThanosContext, prepared: TPrepared): Promise<Readonly<{ created: boolean; result?: TResult }>>;
}>;

export type ThanosConfirmationStore<TPrepared, TResult> = Readonly<{
  get(idempotencyKey: string): Promise<ThanosConfirmationRecord<TPrepared> | undefined>;
  save(record: ThanosConfirmationRecord<TPrepared>): Promise<void>;
  update(record: ThanosConfirmationRecord<TPrepared>): Promise<void>;
}>;

export type ThanosConfirmationAuditPort = Readonly<{
  record(event: Readonly<{
    context: ThanosContext;
    action: "thanos.confirm.prepare" | "thanos.confirm.execute" | "thanos.confirm.duplicate" | "thanos.confirm.denied" | "thanos.confirm.failed";
    status: "success" | "denied" | "failure";
    operation: string;
    requestId: string;
    result: string;
  }>): Promise<void>;
}>;

export class ThanosConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThanosConfirmationError";
  }
}

export class ThanosConfirmationEngine<TInput, TPrepared, TResult> {
  private readonly inFlight = new Map<string, Promise<ThanosConfirmationResult<TResult>>>();

  constructor(
    private readonly store: ThanosConfirmationStore<TPrepared, TResult>,
    private readonly audit: ThanosConfirmationAuditPort,
    private readonly createConfirmationId: () => string,
  ) {}

  async prepare(input: Readonly<{
    context: ThanosContext;
    operation: ThanosConfirmationOperation<TInput, TPrepared, TResult>;
    value: TInput;
    idempotencyKey: string;
    requestId: string;
  }>): Promise<ThanosConfirmationRecord<TPrepared>> {
    this.assertInput(input.operation, input.idempotencyKey);
    try {
      assertThanosCapability(input.context, input.operation.requiredCapability);
    } catch (error) {
      await this.audit.record({
        context: input.context,
        action: "thanos.confirm.denied",
        status: "denied",
        operation: input.operation.name,
        requestId: input.requestId,
        result: "capability_not_authorized",
      });
      throw error;
    }

    const existing = await this.store.get(input.idempotencyKey);
    if (existing) {
      await this.audit.record({
        context: input.context,
        action: "thanos.confirm.duplicate",
        status: "success",
        operation: input.operation.name,
        requestId: input.requestId,
        result: "confirmation_already_prepared",
      });
      return existing;
    }

    try {
      const prepared = await input.operation.prepare(input.context, input.value);
      const record: ThanosConfirmationRecord<TPrepared> = Object.freeze({
        confirmationId: this.createConfirmationId(),
        idempotencyKey: input.idempotencyKey,
        operation: input.operation.name,
        context: input.context,
        prepared,
        status: "pending",
        requestId: input.requestId,
      });
      await this.store.save(record);
      await this.audit.record({
        context: input.context,
        action: "thanos.confirm.prepare",
        status: "success",
        operation: input.operation.name,
        requestId: input.requestId,
        result: "confirmation_pending",
      });
      return record;
    } catch (error) {
      await this.audit.record({
        context: input.context,
        action: "thanos.confirm.failed",
        status: "failure",
        operation: input.operation.name,
        requestId: input.requestId,
        result: "preparation_failed",
      });
      throw error;
    }
  }

  async confirm(input: Readonly<{
    context: ThanosContext;
    operation: ThanosConfirmationOperation<TInput, TPrepared, TResult>;
    confirmationId: string;
    idempotencyKey: string;
    requestId: string;
  }>): Promise<ThanosConfirmationResult<TResult>> {
    this.assertInput(input.operation, input.idempotencyKey);
    try {
      assertThanosCapability(input.context, input.operation.requiredCapability);
    } catch (error) {
      await this.audit.record({
        context: input.context,
        action: "thanos.confirm.denied",
        status: "denied",
        operation: input.operation.name,
        requestId: input.requestId,
        result: "capability_not_authorized",
      });
      throw error;
    }

    const running = this.inFlight.get(input.idempotencyKey);
    if (running) return running;

    const work = this.confirmOnce(input);
    this.inFlight.set(input.idempotencyKey, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(input.idempotencyKey);
    }
  }

  private async confirmOnce(input: Readonly<{
    context: ThanosContext;
    operation: ThanosConfirmationOperation<TInput, TPrepared, TResult>;
    confirmationId: string;
    idempotencyKey: string;
    requestId: string;
  }>): Promise<ThanosConfirmationResult<TResult>> {
    const record = await this.store.get(input.idempotencyKey);
    if (!record || record.confirmationId !== input.confirmationId || record.operation !== input.operation.name) {
      await this.audit.record({
        context: input.context,
        action: "thanos.confirm.denied",
        status: "denied",
        operation: input.operation.name,
        requestId: input.requestId,
        result: "confirmation_not_found",
      });
      throw new ThanosConfirmationError("Confirmação não encontrada para esta operação e chave de idempotência.");
    }
    if (record.context.tenantId !== input.context.tenantId || record.context.workspaceKey !== input.context.workspaceKey) {
      await this.audit.record({
        context: input.context,
        action: "thanos.confirm.denied",
        status: "denied",
        operation: input.operation.name,
        requestId: input.requestId,
        result: "confirmation_scope_mismatch",
      });
      throw new ThanosConfirmationError("Confirmação fora do escopo do workspace ou tenant atual.");
    }
    if (record.status !== "pending") {
      await this.audit.record({
        context: input.context,
        action: "thanos.confirm.duplicate",
        status: "success",
        operation: input.operation.name,
        requestId: input.requestId,
        result: "confirmation_already_executed",
      });
      return Object.freeze({
        confirmationId: record.confirmationId,
        idempotencyKey: record.idempotencyKey,
        operation: record.operation,
        requestId: input.requestId,
        status: "duplicate",
      });
    }

    try {
      const execution = await input.operation.execute(input.context, record.prepared);
      const status = execution.created ? "confirmed" : "duplicate";
      await this.store.update(Object.freeze({ ...record, status }));
      await this.audit.record({
        context: input.context,
        action: execution.created ? "thanos.confirm.execute" : "thanos.confirm.duplicate",
        status: "success",
        operation: input.operation.name,
        requestId: input.requestId,
        result: execution.created ? "write_executed" : "write_already_present",
      });
      return Object.freeze({
        confirmationId: record.confirmationId,
        idempotencyKey: record.idempotencyKey,
        operation: record.operation,
        requestId: input.requestId,
        status,
        ...(execution.result === undefined ? {} : { result: execution.result }),
      });
    } catch (error) {
      await this.audit.record({
        context: input.context,
        action: "thanos.confirm.failed",
        status: "failure",
        operation: input.operation.name,
        requestId: input.requestId,
        result: "write_execution_failed",
      });
      throw error;
    }
  }

  private assertInput(operation: ThanosConfirmationOperation<TInput, TPrepared, TResult>, idempotencyKey: string): void {
    if (!operation.name.trim() || operation.intent !== "WRITE") {
      throw new ThanosConfirmationError("Confirmation Engine aceita somente operações WRITE declaradas.");
    }
    if (!idempotencyKey.trim()) {
      throw new ThanosConfirmationError("Operação de confirmação exige chave de idempotência.");
    }
  }
}
