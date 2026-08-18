import { createHash, randomUUID } from "node:crypto";
import { assertThanosCapability } from "./context";
import type { ThanosCapability, ThanosContext } from "./contracts";

export type ThanosConfirmationStatus = "pending" | "confirmed" | "duplicate" | "denied" | "failed";

export type ThanosConfirmationGrant = Readonly<{
  grantId: string;
  confirmationId: string;
  idempotencyKey: string;
  operation: string;
  connectorKey: string;
  payloadFingerprint: string;
  userId: number;
  conversationId?: number;
  tenantId: string;
  workspaceKey: string;
  originRequestId: string;
  issuedAt: number;
  expiresAt: number;
}>;

export type ThanosConfirmationRecord<TPrepared> = Readonly<{
  confirmationId: string;
  idempotencyKey: string;
  operation: string;
  connectorKey: string;
  payloadFingerprint: string;
  context: ThanosContext;
  prepared: TPrepared;
  status: "pending" | "confirmed" | "duplicate";
  requestId: string;
  createdAt: number;
  expiresAt: number;
  grant?: ThanosConfirmationGrant;
  grantConsumedAt?: number;
}>;

export type ThanosConfirmationResult<TResult> = Readonly<{
  confirmationId: string;
  idempotencyKey: string;
  operation: string;
  requestId: string;
  status: "confirmed" | "duplicate";
  grant?: ThanosConfirmationGrant;
  result?: TResult;
}>;

export type ThanosConfirmationOperation<TInput, TPrepared, TResult> = Readonly<{
  name: string;
  connectorKey: string;
  intent: "WRITE";
  requiredCapability: ThanosCapability;
  fingerprint(input: TInput): string;
  prepare(context: ThanosContext, input: TInput): Promise<TPrepared>;
  execute(context: ThanosContext, prepared: TPrepared): Promise<Readonly<{ created: boolean; result?: TResult }>>;
}>;

export type ThanosConfirmationStore<TPrepared, TResult> = Readonly<{
  get(idempotencyKey: string): Promise<ThanosConfirmationRecord<TPrepared> | undefined>;
  save(record: ThanosConfirmationRecord<TPrepared>): Promise<void>;
  update(record: ThanosConfirmationRecord<TPrepared>): Promise<void>;
}>;

export type ThanosConfirmationGrantPort = Readonly<{
  consumeGrant(input: Readonly<{
    context: ThanosContext;
    operation: string;
    connectorKey: string;
    payloadFingerprint: string;
    grant: ThanosConfirmationGrant;
    requestId: string;
  }>): Promise<ThanosConfirmationGrant>;
}>;

export type ThanosConfirmationAuditPort = Readonly<{
  record(event: Readonly<{
    context: ThanosContext;
    action: "thanos.confirm.prepare" | "thanos.confirm.grant_issued" | "thanos.confirm.grant_consumed" | "thanos.confirm.execute" | "thanos.confirm.duplicate" | "thanos.confirm.denied" | "thanos.confirm.replay_denied" | "thanos.confirm.failed";
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

export function fingerprintThanosPayload(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function isThanosConfirmationGrantExpired(grant: ThanosConfirmationGrant, now: number): boolean {
  return !Number.isSafeInteger(now) || now >= grant.expiresAt;
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalize(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
  }
  throw new ThanosConfirmationError("Payload de confirmação contém tipo não suportado.");
}

export class ThanosConfirmationEngine<TInput, TPrepared, TResult> {
  private readonly confirmationInFlight = new Map<string, Promise<ThanosConfirmationResult<TResult>>>();
  private readonly grantInFlight = new Map<string, Promise<ThanosConfirmationGrant>>();

  constructor(
    private readonly store: ThanosConfirmationStore<TPrepared, TResult>,
    private readonly audit: ThanosConfirmationAuditPort,
    private readonly createConfirmationId: () => string = randomUUID,
    private readonly createGrantId: () => string = randomUUID,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 5 * 60 * 1000,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new ThanosConfirmationError("TTL da confirmação deve ser um inteiro positivo.");
    }
  }

  async prepare(input: Readonly<{
    context: ThanosContext;
    operation: ThanosConfirmationOperation<TInput, TPrepared, TResult>;
    value: TInput;
    idempotencyKey: string;
    requestId: string;
  }>): Promise<ThanosConfirmationRecord<TPrepared>> {
    this.assertInput(input.operation, input.idempotencyKey, input.requestId);
    const payloadFingerprint = this.assertFingerprint(input.operation.fingerprint(input.value));
    try {
      assertThanosCapability(input.context, input.operation.requiredCapability);
    } catch (error) {
      await this.record(input.context, "thanos.confirm.denied", "denied", input.operation.name, input.requestId, "capability_not_authorized");
      throw error;
    }

    const existing = await this.store.get(input.idempotencyKey);
    if (existing) {
      await this.assertRecordBinding(existing, input.context, input.operation, payloadFingerprint);
      await this.assertNotExpired(existing.expiresAt, input.context, input.operation.name, input.requestId);
      await this.record(input.context, "thanos.confirm.duplicate", "success", input.operation.name, input.requestId, "confirmation_already_prepared");
      return existing;
    }

    try {
      const prepared = await input.operation.prepare(input.context, input.value);
      const createdAt = this.now();
      const record: ThanosConfirmationRecord<TPrepared> = Object.freeze({
        confirmationId: this.createConfirmationId(),
        idempotencyKey: input.idempotencyKey,
        operation: input.operation.name,
        connectorKey: input.operation.connectorKey,
        payloadFingerprint,
        context: input.context,
        prepared,
        status: "pending",
        requestId: input.requestId,
        createdAt,
        expiresAt: createdAt + this.ttlMs,
      });
      await this.store.save(record);
      await this.record(input.context, "thanos.confirm.prepare", "success", input.operation.name, input.requestId, "confirmation_pending");
      return record;
    } catch (error) {
      await this.record(input.context, "thanos.confirm.failed", "failure", input.operation.name, input.requestId, "preparation_failed");
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
    this.assertInput(input.operation, input.idempotencyKey, input.requestId);
    try {
      assertThanosCapability(input.context, input.operation.requiredCapability);
    } catch (error) {
      await this.record(input.context, "thanos.confirm.denied", "denied", input.operation.name, input.requestId, "capability_not_authorized");
      throw error;
    }

    const lockKey = `${input.idempotencyKey}:${input.context.userId}:${input.context.tenantId}:${input.context.workspaceKey}:${input.context.conversationId ?? "none"}`;
    const running = this.confirmationInFlight.get(lockKey);
    if (running) return running;

    const work = this.confirmOnce(input);
    this.confirmationInFlight.set(lockKey, work);
    try {
      return await work;
    } finally {
      this.confirmationInFlight.delete(lockKey);
    }
  }

  async verifyGrant(input: Readonly<{
    context: ThanosContext;
    operation: string;
    connectorKey: string;
    payloadFingerprint: string;
    grant: ThanosConfirmationGrant;
    requestId: string;
  }>): Promise<ThanosConfirmationGrant> {
    const record = await this.loadAndValidateGrant(input);
    if (record.grantConsumedAt !== undefined) {
      throw new ThanosConfirmationError("Grant de confirmação já foi consumido.");
    }
    return record.grant!;
  }

  async consumeGrant(input: Readonly<{
    context: ThanosContext;
    operation: string;
    connectorKey: string;
    payloadFingerprint: string;
    grant: ThanosConfirmationGrant;
    requestId: string;
  }>): Promise<ThanosConfirmationGrant> {
    const running = this.grantInFlight.get(input.grant.grantId);
    if (running) await running;
    const work = this.consumeGrantOnce(input);
    this.grantInFlight.set(input.grant.grantId, work);
    try {
      return await work;
    } finally {
      this.grantInFlight.delete(input.grant.grantId);
    }
  }

  async executeWithGrant(input: Readonly<{
    context: ThanosContext;
    operation: ThanosConfirmationOperation<TInput, TPrepared, TResult>;
    value: TInput;
    grant: ThanosConfirmationGrant;
    requestId: string;
  }>): Promise<ThanosConfirmationResult<TResult>> {
    this.assertInput(input.operation, input.grant.idempotencyKey, input.requestId);
    try {
      assertThanosCapability(input.context, input.operation.requiredCapability);
      await this.consumeGrant({
        context: input.context,
        operation: input.operation.name,
        connectorKey: input.operation.connectorKey,
        payloadFingerprint: input.operation.fingerprint(input.value),
        grant: input.grant,
        requestId: input.requestId,
      });
      const record = await this.store.get(input.grant.idempotencyKey);
      if (!record) throw new ThanosConfirmationError("Confirmação não encontrada para execução.");
      const execution = await input.operation.execute(input.context, record.prepared);
      const status = execution.created ? "confirmed" : "duplicate";
      await this.store.update(Object.freeze({ ...record, status }));
      await this.record(input.context, execution.created ? "thanos.confirm.execute" : "thanos.confirm.duplicate", "success", input.operation.name, input.requestId, execution.created ? "write_executed" : "write_already_present");
      return Object.freeze({ confirmationId: record.confirmationId, idempotencyKey: record.idempotencyKey, operation: record.operation, requestId: input.requestId, status, grant: input.grant, ...(execution.result === undefined ? {} : { result: execution.result }) });
    } catch (error) {
      await this.record(input.context, "thanos.confirm.failed", "failure", input.operation.name, input.requestId, "write_execution_failed");
      throw error;
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
    if (!record || record.confirmationId !== input.confirmationId || record.operation !== input.operation.name || record.connectorKey !== input.operation.connectorKey) {
      await this.record(input.context, "thanos.confirm.denied", "denied", input.operation.name, input.requestId, "confirmation_not_found");
      throw new ThanosConfirmationError("Confirmação não encontrada para esta operação e chave de idempotência.");
    }
    await this.assertRecordContextBinding(record, input.context, input.operation.name, input.requestId);
    await this.assertNotExpired(record.expiresAt, input.context, input.operation.name, input.requestId);

    if (record.status !== "pending") {
      await this.record(input.context, "thanos.confirm.duplicate", "success", input.operation.name, input.requestId, "confirmation_already_approved");
      return Object.freeze({ confirmationId: record.confirmationId, idempotencyKey: record.idempotencyKey, operation: record.operation, requestId: input.requestId, status: "duplicate", ...(record.grantConsumedAt === undefined && record.grant === undefined ? {} : { grant: record.grant }) });
    }

    const issuedAt = this.now();
    const grant: ThanosConfirmationGrant = Object.freeze({
      grantId: this.createGrantId(),
      confirmationId: record.confirmationId,
      idempotencyKey: record.idempotencyKey,
      operation: record.operation,
      connectorKey: record.connectorKey,
      payloadFingerprint: record.payloadFingerprint,
      userId: record.context.userId,
      ...(record.context.conversationId === undefined ? {} : { conversationId: record.context.conversationId }),
      tenantId: record.context.tenantId,
      workspaceKey: record.context.workspaceKey,
      originRequestId: record.requestId,
      issuedAt,
      expiresAt: record.expiresAt,
    });
    const updated = Object.freeze({ ...record, status: "confirmed" as const, grant });
    await this.store.update(updated);
    await this.record(input.context, "thanos.confirm.grant_issued", "success", input.operation.name, input.requestId, "confirmation_grant_issued");
    return Object.freeze({ confirmationId: record.confirmationId, idempotencyKey: record.idempotencyKey, operation: record.operation, requestId: input.requestId, status: "confirmed", grant });
  }

  private async consumeGrantOnce(input: Readonly<{
    context: ThanosContext;
    operation: string;
    connectorKey: string;
    payloadFingerprint: string;
    grant: ThanosConfirmationGrant;
    requestId: string;
  }>): Promise<ThanosConfirmationGrant> {
    const record = await this.loadAndValidateGrant(input);
    if (record.grantConsumedAt !== undefined) {
      await this.record(input.context, "thanos.confirm.replay_denied", "denied", input.operation, input.requestId, "confirmation_grant_replayed");
      throw new ThanosConfirmationError("Grant de confirmação já foi consumido.");
    }
    const consumedAt = this.now();
    await this.store.update(Object.freeze({ ...record, grantConsumedAt: consumedAt }));
    await this.record(input.context, "thanos.confirm.grant_consumed", "success", input.operation, input.requestId, "confirmation_grant_consumed");
    return record.grant!;
  }

  private async loadAndValidateGrant(input: Readonly<{
    context: ThanosContext;
    operation: string;
    connectorKey: string;
    payloadFingerprint: string;
    grant: ThanosConfirmationGrant;
    requestId: string;
  }>): Promise<ThanosConfirmationRecord<TPrepared>> {
    const record = await this.store.get(input.grant.idempotencyKey);
    const persistedGrant = record?.grant;
    const grantMatchesPersisted = persistedGrant !== undefined &&
      persistedGrant.grantId === input.grant.grantId &&
      persistedGrant.confirmationId === input.grant.confirmationId &&
      persistedGrant.idempotencyKey === input.grant.idempotencyKey &&
      persistedGrant.operation === input.grant.operation &&
      persistedGrant.connectorKey === input.grant.connectorKey &&
      persistedGrant.payloadFingerprint === input.grant.payloadFingerprint &&
      persistedGrant.userId === input.grant.userId &&
      persistedGrant.conversationId === input.grant.conversationId &&
      persistedGrant.tenantId === input.grant.tenantId &&
      persistedGrant.workspaceKey === input.grant.workspaceKey &&
      persistedGrant.originRequestId === input.grant.originRequestId &&
      persistedGrant.issuedAt === input.grant.issuedAt &&
      persistedGrant.expiresAt === input.grant.expiresAt;
    if (!record || !persistedGrant || !grantMatchesPersisted || record.grant.operation !== input.operation || record.grant.connectorKey !== input.connectorKey || record.grant.payloadFingerprint !== input.payloadFingerprint || input.grant.payloadFingerprint !== input.payloadFingerprint) {
      await this.record(input.context, "thanos.confirm.denied", "denied", input.operation, input.requestId, "confirmation_grant_binding_mismatch");
      throw new ThanosConfirmationError("Grant de confirmação não corresponde à operação, connector ou payload.");
    }
    await this.assertRecordContextBinding(record, input.context, input.operation, input.requestId);
    if (isThanosConfirmationGrantExpired(record.grant, this.now()) || record.expiresAt <= this.now()) {
      await this.record(input.context, "thanos.confirm.denied", "denied", input.operation, input.requestId, "confirmation_grant_expired");
      throw new ThanosConfirmationError("Grant de confirmação expirado.");
    }
    return record;
  }

  private async assertRecordBinding(record: ThanosConfirmationRecord<TPrepared>, context: ThanosContext, operation: ThanosConfirmationOperation<TInput, TPrepared, TResult>, payloadFingerprint: string): Promise<void> {
    if (record.operation !== operation.name || record.connectorKey !== operation.connectorKey || record.payloadFingerprint !== payloadFingerprint) {
      throw new ThanosConfirmationError("Chave de idempotência já está vinculada a outra operação ou payload.");
    }
    await this.assertRecordContextBinding(record, context, operation.name, context.requestId);
  }

  private async assertRecordContextBinding(record: ThanosConfirmationRecord<TPrepared>, context: ThanosContext, operation: string, requestId: string): Promise<void> {
    if (record.context.userId !== context.userId) {
      await this.record(context, "thanos.confirm.denied", "denied", operation, requestId, "confirmation_user_mismatch");
      throw new ThanosConfirmationError("Confirmação vinculada a outro usuário.");
    }
    if (record.context.conversationId !== context.conversationId) {
      await this.record(context, "thanos.confirm.denied", "denied", operation, requestId, "confirmation_conversation_mismatch");
      throw new ThanosConfirmationError("Confirmação vinculada a outra conversa.");
    }
    if (record.context.tenantId !== context.tenantId || record.context.workspaceKey !== context.workspaceKey) {
      await this.record(context, "thanos.confirm.denied", "denied", operation, requestId, "confirmation_scope_mismatch");
      throw new ThanosConfirmationError("Confirmação fora do escopo do workspace ou tenant atual.");
    }
  }

  private async assertNotExpired(expiresAt: number, context: ThanosContext, operation: string, requestId: string): Promise<void> {
    if (this.now() >= expiresAt) {
      await this.record(context, "thanos.confirm.denied", "denied", operation, requestId, "confirmation_expired");
      throw new ThanosConfirmationError("Confirmação expirada.");
    }
  }

  private assertInput(operation: ThanosConfirmationOperation<TInput, TPrepared, TResult>, idempotencyKey: string, requestId: string): void {
    if (!operation.name.trim() || !operation.connectorKey.trim() || operation.intent !== "WRITE") {
      throw new ThanosConfirmationError("Confirmation Engine aceita somente operações WRITE declaradas.");
    }
    if (!idempotencyKey.trim() || !requestId.trim()) {
      throw new ThanosConfirmationError("Operação de confirmação exige chave de idempotência e requestId.");
    }
  }

  private assertFingerprint(value: string): string {
    if (!value.trim()) throw new ThanosConfirmationError("Operação de confirmação exige fingerprint de payload.");
    return value;
  }

  private async record(context: ThanosContext, action: "thanos.confirm.prepare" | "thanos.confirm.grant_issued" | "thanos.confirm.grant_consumed" | "thanos.confirm.execute" | "thanos.confirm.duplicate" | "thanos.confirm.denied" | "thanos.confirm.replay_denied" | "thanos.confirm.failed", status: "success" | "denied" | "failure", operation: string, requestId: string, result: string): Promise<void> {
    await this.audit.record({ context, action, status, operation, requestId, result });
  }
}
