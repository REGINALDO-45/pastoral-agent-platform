import { describe, expect, it } from "vitest";
import { transcribeVoiceInput } from "./voiceGateway";
import type { TenantContext } from "./types";

const context: TenantContext = { organizationId: 1, organizationName: "Igreja Demonstração A", userId: 7, userName: "Pastor Samuel", role: "pastor" };

describe("Voice gateway", () => {
  it("armazena o áudio, retorna a transcrição e audita somente os metadados seguros", async () => {
    const audit: unknown[] = [];
    let transcribedUrl = "";
    const result = await transcribeVoiceInput({
      context,
      requestId: "voice-request-1",
      audioBytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/webm",
      storagePut: async (key) => ({ key, url: `/manus-storage/${key}` }),
      getStoredAudioUrl: async key => `https://signed-storage.local/${key}`,
      getVoice: () => ({ transcribe: async url => { transcribedUrl = url; return { text: "Quantos visitantes temos?", provider: "built-in-whisper" }; } }),
      repository: { audit: async entry => { audit.push(entry); } },
    });
    expect(result).toEqual({ text: "Quantos visitantes temos?", provider: "built-in-whisper" });
    expect(transcribedUrl).toMatch(/^https:\/\/signed-storage\.local\//);
    expect(audit).toContainEqual(expect.objectContaining({ action: "voice.transcribe", status: "success", model: "built-in-whisper", requestId: "voice-request-1" }));
    expect(JSON.stringify(audit)).not.toContain("1,2,3");
  });

  it("audita a falha sem expor o erro interno do provedor", async () => {
    const audit: unknown[] = [];
    await expect(transcribeVoiceInput({
      context,
      audioBytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/webm",
      storagePut: async () => ({ key: "pastoral-audio/audio.webm", url: "/manus-storage/pastoral-audio/audio.webm" }),
      getStoredAudioUrl: async () => "https://signed-storage.local/audio.webm",
      getVoice: () => ({ transcribe: async () => { throw new Error("provider timeout: secret not retained"); } }),
      repository: { audit: async entry => { audit.push(entry); } },
    })).rejects.toThrow("Não foi possível transcrever o áudio");
    expect(audit).toContainEqual(expect.objectContaining({ action: "voice.transcribe", status: "failure" }));
  });

  it("armazena áudio MP4 de navegador móvel com a extensão m4a suportada", async () => {
    let storedKey = "";
    await transcribeVoiceInput({
      context,
      audioBytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/mp4; codecs=mp4a.40.2",
      storagePut: async (key) => { storedKey = key; return { key, url: `/manus-storage/${key}` }; },
      getStoredAudioUrl: async key => `https://signed-storage.local/${key}`,
      getVoice: () => ({ transcribe: async () => ({ text: "Olá, igreja.", provider: "built-in-whisper" }) }),
      repository: { audit: async () => undefined },
    });
    expect(storedKey).toMatch(/\.m4a$/);
  });
});
