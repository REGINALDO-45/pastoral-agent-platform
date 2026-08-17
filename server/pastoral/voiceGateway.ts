import type { PastoralRepository, TenantContext } from "./types";
import type { VoiceProvider } from "./voiceProvider";

type VoiceStorage = (key: string, data: Uint8Array, contentType: string) => Promise<{ key: string; url: string }>;
type VoiceSignedUrl = (key: string) => Promise<string>;

type TranscribeVoiceInput = {
  context: TenantContext;
  requestId?: string;
  audioBytes: Uint8Array;
  mimeType: string;
  storagePut: VoiceStorage;
  getStoredAudioUrl: VoiceSignedUrl;
  getVoice: () => VoiceProvider;
  repository: Pick<PastoralRepository, "audit">;
};

function extensionFor(mimeType: string) {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  if (normalized === "audio/mp4" || normalized === "audio/x-m4a") return "m4a";
  if (normalized === "audio/mpeg") return "mp3";
  if (normalized === "audio/x-wav") return "wav";
  return normalized?.split("/")[1] || "webm";
}

export async function transcribeVoiceInput(input: TranscribeVoiceInput) {
  try {
    const key = `pastoral-audio/${input.context.organizationId}/${input.context.userId}/${Date.now()}.${extensionFor(input.mimeType)}`;
    const stored = await input.storagePut(key, input.audioBytes, input.mimeType);
    const audioUrl = await input.getStoredAudioUrl(stored.key);
    const transcript = await input.getVoice().transcribe(audioUrl);
    await input.repository.audit({
      context: input.context,
      action: "voice.transcribe",
      agent: "voice-gateway",
      model: transcript.provider,
      requestId: input.requestId,
      status: "success",
      metadata: { provider: transcript.provider },
    });
    return transcript;
  } catch (error) {
    try {
      await input.repository.audit({
        context: input.context,
        action: "voice.transcribe",
        agent: "voice-gateway",
        requestId: input.requestId,
        status: "failure",
        metadata: { reason: error instanceof Error ? error.message.slice(0, 120) : "voice_provider_error" },
      });
    } catch {
      // A falha original de transcrição deve continuar sendo reportada mesmo se o audit log também estiver indisponível.
    }
    throw new Error("Não foi possível transcrever o áudio. Tente novamente ou envie a mensagem em texto.");
  }
}
