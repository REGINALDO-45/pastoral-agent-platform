import { randomUUID } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import { createContext } from "../_core/context";
import { storageGetSignedUrl, storagePut } from "../storage";
import { AgentCore } from "./agentCore";
import { AgentGateway } from "./agentGateway";
import { getOrCreateConversation, getTenantContextForUser, DatabasePastoralRepository } from "./repository";
import { transcribeVoiceInput } from "./voiceGateway";
import { getVoiceProvider } from "./voiceProvider";
import type { PastoralRepository, TenantContext } from "./types";

const ACCEPTED_AUDIO_TYPES = new Set(["audio/webm", "audio/ogg", "audio/wav", "audio/mpeg", "audio/mp4"]);
const VOICE_REQUEST_HEADER = "1";
const REQUEST_WINDOW_MS = 60_000;
const REQUEST_LIMIT_PER_WINDOW = 5;
const voiceRequestTimestamps = new Map<number, number[]>();
const voiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
export const VOICE_HISTORY_LABEL = "Mensagem de voz enviada.";

type VoiceUploadRejection = {
  status: number;
  error: string;
  reason: string;
};

export function normalizeAudioMimeType(value: string | undefined) {
  const mimeType = value?.split(";")[0]?.trim().toLowerCase() || "";
  return ACCEPTED_AUDIO_TYPES.has(mimeType) ? mimeType : null;
}

export function allowVoiceUpload(userId: number, now = Date.now()) {
  const recent = (voiceRequestTimestamps.get(userId) ?? []).filter(timestamp => now - timestamp < REQUEST_WINDOW_MS);
  if (recent.length >= REQUEST_LIMIT_PER_WINDOW) {
    voiceRequestTimestamps.set(userId, recent);
    return false;
  }
  voiceRequestTimestamps.set(userId, [...recent, now]);
  return true;
}

export function validateVoiceUploadRequest(input: {
  requestHeader?: string;
  contentType?: string;
  byteLength: number;
}): VoiceUploadRejection | null {
  if (input.requestHeader !== VOICE_REQUEST_HEADER) return { status: 403, error: "Requisição de voz inválida. Atualize a página e tente novamente.", reason: "missing_client_request_header" };
  if (!normalizeAudioMimeType(input.contentType)) return { status: 415, error: "Formato de áudio não suportado.", reason: "unsupported_mime_type" };
  if (!input.byteLength) return { status: 400, error: "Nenhum áudio foi recebido.", reason: "empty_audio" };
  if (input.byteLength > 16 * 1024 * 1024) return { status: 413, error: "O áudio excede o limite de 16 MB. Grave uma mensagem menor.", reason: "payload_too_large" };
  return null;
}

export function createVoiceHistoryEntry(conversationId: number, context: TenantContext) {
  return {
    conversationId,
    context,
    role: "user" as const,
    messageType: "voice" as const,
    content: VOICE_HISTORY_LABEL,
    model: "voice-input-v1",
  };
}

type VoiceAgentResponder = Pick<AgentGateway, "respond">;

export function respondToVoiceTranscript(input: {
  gateway: VoiceAgentResponder;
  context: TenantContext;
  conversationId: number;
  transcript: string;
  requestId: string;
}) {
  return input.gateway.respond({
    context: input.context,
    conversationId: input.conversationId,
    message: input.transcript,
    persistUserMessage: false,
    requestId: input.requestId,
  });
}

export async function auditVoiceRejection(repository: Pick<PastoralRepository, "audit">, context: TenantContext, reason: string, requestId?: string) {
  await repository.audit({ context, action: "voice.upload", agent: "voice-upload", requestId, status: "denied", metadata: { reason } });
}

async function uploadAndTranscribe(req: Request, res: Response) {
  const requestContext = await createContext({ req, res } as Parameters<typeof createContext>[0]);
  if (!requestContext.user) return res.status(401).json({ error: "Sua sessão expirou. Entre novamente para enviar áudio." });

  try {
    const context = await getTenantContextForUser(requestContext.user.id);
    const requestId = randomUUID();
    const repository = new DatabasePastoralRepository();
    const reject = async (rejection: VoiceUploadRejection) => {
      await auditVoiceRejection(repository, context, rejection.reason, requestId).catch(() => undefined);
      return res.status(rejection.status).json({ error: rejection.error });
    };
    const file = req.file;
    const validation = validateVoiceUploadRequest({ requestHeader: req.header("x-pastoral-voice-request"), contentType: file?.mimetype, byteLength: file?.size ?? 0 });
    if (validation) return reject(validation);
    const mimeType = normalizeAudioMimeType(file?.mimetype);
    if (!mimeType) return reject({ status: 415, error: "Formato de áudio não suportado.", reason: "unsupported_mime_type" });
    if (!allowVoiceUpload(context.userId)) return reject({ status: 429, error: "Muitas tentativas de áudio em pouco tempo. Aguarde um minuto e tente novamente.", reason: "rate_limited" });
    const audioBytes = new Uint8Array(file!.buffer);
    const transcript = await transcribeVoiceInput({
      context,
      requestId,
      audioBytes,
      mimeType,
      storagePut: (key, data, contentType) => storagePut(key, data, contentType),
      getStoredAudioUrl: storageGetSignedUrl,
      getVoice: getVoiceProvider,
      repository,
    });
    const conversation = await getOrCreateConversation(context);
    await repository.appendMessage(createVoiceHistoryEntry(conversation.id, context));
    const agentGateway = new AgentGateway(repository, new AgentCore(repository));
    const agentResponse = await respondToVoiceTranscript({
      gateway: agentGateway,
      context,
      conversationId: conversation.id,
      transcript: transcript.text,
      requestId,
    });
    await repository.audit({
      context,
      action: "voice.respond",
      agent: "voice-upload",
      model: agentResponse.model,
      tool: agentResponse.tool,
      requestId,
      status: "success",
      metadata: {
        mimeType,
        messageType: "voice",
        transcriptionProvider: transcript.provider,
        responseProvider: agentResponse.provider,
        gatewayProvider: agentResponse.gateway?.provider,
        gatewayFallback: agentResponse.gateway?.fallback,
      },
    });
    res.set("Cache-Control", "no-store");
    return res.json({
      conversationId: conversation.id,
      response: {
        content: agentResponse.content,
        provider: agentResponse.provider,
        model: agentResponse.model,
        tool: agentResponse.tool,
        confirmation: agentResponse.confirmation,
      },
    });
  } catch {
    console.warn("[Pastoral Voice] audio processing failed", { userId: requestContext.user.id });
    return res.status(502).json({ error: "Não foi possível processar a mensagem de voz. Tente novamente ou envie a mensagem em texto." });
  }
}

export function registerVoiceUploadRoute(app: Express) {
  app.post("/api/pastoral/voice", voiceUpload.single("audio"), (req, res) => {
    void uploadAndTranscribe(req, res);
  });
  app.use(async (error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/api/pastoral/voice" && error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      try {
        const requestContext = await createContext({ req, res } as Parameters<typeof createContext>[0]);
        if (requestContext.user) {
          const context = await getTenantContextForUser(requestContext.user.id);
          await auditVoiceRejection(new DatabasePastoralRepository(), context, "payload_too_large", randomUUID());
        }
      } catch {
        console.warn("[Pastoral Voice] unable to audit rejected oversized upload");
      }
      res.status(413).json({ error: "O áudio excede o limite de 16 MB. Grave uma mensagem menor." });
      return;
    }
    next(error);
  });
}
