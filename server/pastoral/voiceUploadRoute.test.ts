import { describe, expect, it, vi } from "vitest";
import { allowVoiceUpload, auditVoiceRejection, createVoiceHistoryEntry, normalizeAudioMimeType, respondToVoiceTranscript, validateVoiceUploadRequest, VOICE_HISTORY_LABEL } from "./voiceUploadRoute";
import type { TenantContext } from "./types";

const context: TenantContext = { organizationId: 1, organizationName: "Igreja Demonstração A", userId: 990_001, userName: "Teste", role: "pastor" };

describe("rota binária de voz", () => {
  it("aceita os formatos do MediaRecorder, incluindo parâmetros de codec", () => {
    expect(normalizeAudioMimeType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(normalizeAudioMimeType("audio/ogg")).toBe("audio/ogg");
  });

  it("rejeita formatos que não são áudio suportado", () => {
    expect(normalizeAudioMimeType("application/json")).toBeNull();
    expect(normalizeAudioMimeType(undefined)).toBeNull();
  });

  it("limita tentativas de upload por usuário em uma janela curta", () => {
    const userId = 912_345;
    for (let attempt = 0; attempt < 5; attempt += 1) expect(allowVoiceUpload(userId, attempt * 100)).toBe(true);
    expect(allowVoiceUpload(userId, 501)).toBe(false);
    expect(allowVoiceUpload(userId, 60_001)).toBe(true);
  });

  it("classifica explicitamente payload excessivo e requisições inválidas", () => {
    expect(validateVoiceUploadRequest({ requestHeader: "1", contentType: "audio/webm", byteLength: 16 * 1024 * 1024 + 1 })).toMatchObject({ status: 413, reason: "payload_too_large" });
    expect(validateVoiceUploadRequest({ requestHeader: undefined, contentType: "audio/webm", byteLength: 1 })).toMatchObject({ status: 403, reason: "missing_client_request_header" });
    expect(validateVoiceUploadRequest({ requestHeader: "1", contentType: "application/json", byteLength: 1 })).toMatchObject({ status: 415, reason: "unsupported_mime_type" });
  });

  it("audita recusas autenticadas sem salvar o conteúdo do áudio", async () => {
    const audit = vi.fn().mockResolvedValue(undefined);
    await auditVoiceRejection({ audit }, context, "payload_too_large");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ context, action: "voice.upload", agent: "voice-upload", status: "denied", metadata: { reason: "payload_too_large" } }));
  });

  it("cria um marcador de voz sem a transcrição reconhecida", () => {
    const entry = createVoiceHistoryEntry(41, context);
    expect(entry).toEqual(expect.objectContaining({ conversationId: 41, context, role: "user", messageType: "voice", content: VOICE_HISTORY_LABEL, model: "voice-input-v1" }));
    expect(entry.content).not.toContain("Quantas células");
  });

  it("encaminha a transcrição ao gateway com o mesmo requestId e sem persistência duplicada", async () => {
    const respond = vi.fn().mockResolvedValue({ content: "Resposta segura", provider: "legacy", model: "pastoral-rules-v1" });
    await respondToVoiceTranscript({ gateway: { respond }, context, conversationId: 41, transcript: "Quantas células estão ativas?", requestId: "voice-request-2" });
    expect(respond).toHaveBeenCalledWith({ context, conversationId: 41, message: "Quantas células estão ativas?", persistUserMessage: false, requestId: "voice-request-2" });
  });
});
