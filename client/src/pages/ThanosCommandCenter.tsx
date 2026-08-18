import { VoiceRecorder } from "@/components/VoiceRecorder";
import { AIChatBox, type Message } from "@/components/AIChatBox";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/_core/hooks/useAuth";
import { invalidateActiveConversationMessages } from "@/lib/conversationCache";
import { trpc } from "@/lib/trpc";
import { canUseVoiceSynthesis, extractVoiceAgentReply, playVoiceResponse, type VoiceAgentReply } from "@/lib/voiceInteraction";
import { Activity, ArrowUpRight, Check, ChevronRight, CircleHelp, Database, FileCheck2, Gem, LayoutGrid, LockKeyhole, MessageCircle, Mic2, MoreHorizontal, Network, Radio, ShieldCheck, Sparkles, Volume2, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ThanosExperienceLayout, type ExperienceMode, type ExperienceSection } from "@/components/thanos/ThanosExperienceLayout";
import { ThanosConfirmationCard, ThanosEmptyIcon, ThanosEvidenceCard, ThanosJewel, ThanosLockedNotice, ThanosPower, StatusBadge, StatusDot } from "@/components/thanos/ThanosPrimitives";



type SanitizedConfirmation = { title: string; summary: string; workspace: string };
type VoiceState = "idle" | "processing" | "responding" | "error";

function ErrorNotice({ onRetry }: { onRetry?: () => void }) {
  return <div className="thanos-error-notice" role="alert"><div className="flex items-start gap-3"><div className="thanos-icon-box thanos-icon-box-warning"><CircleHelp className="size-4" /></div><div><p className="font-medium">Não foi possível sincronizar agora.</p><p className="mt-1 text-sm leading-5 text-muted-foreground">A sessão continua protegida. Tente novamente sem expor detalhes técnicos.</p></div></div>{onRetry ? <Button variant="outline" size="sm" onClick={onRetry} className="mt-3 sm:mt-0">Tentar novamente</Button> : null}</div>;
}

function CommandHeader({ title, workspaceName, mode, onWorkspaceInfo }: { title: string; workspaceName: string; mode: ExperienceMode; onWorkspaceInfo: () => void }) {
  return <header className="flex flex-col gap-5 border-b border-border/60 pb-6 sm:flex-row sm:items-end sm:justify-between"><div><p className="thanos-eyebrow flex items-center gap-2"><span className="thanos-kicker-dot" aria-hidden="true" />THÁNOS / {mode === "admin" ? "CONTROL ROOM" : "COMMAND CENTER"}</p><h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl lg:text-5xl">{title}</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">Uma inteligência operacional clara, protegida e pronta para transformar contexto autorizado em próximos passos.</p></div><button type="button" onClick={onWorkspaceInfo} className="thanos-workspace-pill" aria-label={`Workspace ativo: ${workspaceName}. Ver informações.`}><span className="flex size-8 items-center justify-center rounded-xl bg-primary/12 text-primary"><ShieldCheck className="size-4" /></span><span className="text-left"><span className="block text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Workspace ativo</span><span className="mt-0.5 block text-sm font-semibold">{workspaceName}</span></span><ChevronRight className="ml-1 size-4 text-muted-foreground" /></button></header>;
}

function VoiceStateChip({ state }: { state: VoiceState }) {
  const copy: Record<VoiceState, string> = { idle: "Pronto para ouvir", processing: "Processando voz", responding: "THÁNOS falando", error: "Voz indisponível" };
  const status = state === "idle" ? "available" : state === "error" ? "disabled" : "pending";
  return <StatusBadge status={status} label={copy[state]} />;
}

function UserChat({ workspaceName, onWorkspaceInfo }: { workspaceName: string; onWorkspaceInfo: () => void }) {
  const { user, isAuthenticated } = useAuth();
  const utils = trpc.useUtils();
  const conversationQuery = trpc.pastoral.currentConversation.useQuery(undefined, { enabled: Boolean(user && isAuthenticated) });
  const conversationId = conversationQuery.data?.id;
  const messagesQuery = trpc.pastoral.messages.useQuery({ conversationId: conversationId ?? 0 }, { enabled: Boolean(conversationId) });
  const [pendingConfirmation, setPendingConfirmation] = useState<SanitizedConfirmation | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceSynthesisAvailable] = useState(() => canUseVoiceSynthesis(typeof window === "undefined" ? undefined : window.speechSynthesis) && typeof SpeechSynthesisUtterance !== "undefined");
  const [voicePlaybackIssue, setVoicePlaybackIssue] = useState<string | null>(null);

  const messages = useMemo<Message[]>(() => (messagesQuery.data ?? []).map(message => ({ role: message.role, content: message.content, messageType: message.messageType })), [messagesQuery.data]);
  const latestAnswer = [...messages].reverse().find(message => message.role === "assistant")?.content;
  const isBusy = conversationQuery.isLoading || messagesQuery.isLoading;

  const applyAgentReply = (result: VoiceAgentReply) => {
    if (result.confirmation) {
      setPendingConfirmation({ title: "registrar este acompanhamento", summary: `Uma ação sensível foi preparada para ${result.confirmation.visitorName}. Revise o pedido antes de decidir.`, workspace: workspaceName });
    }
    invalidateActiveConversationMessages(conversationId, input => utils.pastoral.messages.invalidate(input));
  };

  const sendMutation = trpc.pastoral.sendMessage.useMutation({
    onSuccess: applyAgentReply,
    onError: () => toast.error("Não foi possível enviar sua mensagem. Tente novamente."),
  });
  const sendMessage = (content: string) => {
    if (!conversationId) return;
    sendMutation.mutate({ conversationId, content });
  };

  const speak = async (content: string) => {
    if (!voiceSynthesisAvailable || !canUseVoiceSynthesis(window.speechSynthesis)) return false;
    return playVoiceResponse({ content, synthesis: window.speechSynthesis, createUtterance: text => new SpeechSynthesisUtterance(text) });
  };

  const transcribeAudio = async (audio: Blob, mimeType: string) => {
    if (!conversationId) return;
    setVoiceState("processing");
    try {
      const extension = mimeType.split("/")[1] || "webm";
      const formData = new FormData();
      formData.append("audio", audio, `thanos-voice.${extension}`);
      const response = await fetch("/api/pastoral/voice", { method: "POST", credentials: "include", headers: { "x-pastoral-voice-request": "1" }, body: formData });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      const agentReply = extractVoiceAgentReply(payload);
      if (!response.ok || !agentReply) throw new Error("voice");
      applyAgentReply(agentReply);
      setVoiceState("responding");
      const startedSpeech = await speak(agentReply.content);
      setVoicePlaybackIssue(startedSpeech ? null : "A resposta chegou, mas a leitura não começou neste navegador.");
      toast.success(startedSpeech ? "THÁNOS respondeu por voz." : "Resposta recebida. Você pode ouvir quando quiser.");
    } catch {
      setVoiceState("error");
      toast.error("Não foi possível processar a voz agora.");
    } finally {
      window.setTimeout(() => setVoiceState("idle"), 700);
    }
  };

  const speakLatest = async () => {
    if (!latestAnswer) return;
    setVoiceState("responding");
    const startedSpeech = await speak(latestAnswer);
    setVoicePlaybackIssue(startedSpeech ? null : "A leitura não foi iniciada neste navegador.");
    if (!startedSpeech) toast.error("A resposta está disponível no histórico.");
    window.setTimeout(() => setVoiceState("idle"), 700);
  };

  const confirmVisualAction = () => {
    setPendingConfirmation(null);
    toast.success("Confirmação visual registrada. A execução pública WRITE continua desativada nesta fase.");
  };

  return <div className="space-y-5" data-testid="thanos-user-chat"><CommandHeader title="Converse com THÁNOS." workspaceName={workspaceName} mode="user" onWorkspaceInfo={onWorkspaceInfo} />
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4">
        {pendingConfirmation ? <ThanosConfirmationCard title={pendingConfirmation.title} summary={pendingConfirmation.summary} workspace={pendingConfirmation.workspace} onCancel={() => setPendingConfirmation(null)} onConfirm={confirmVisualAction} blocked={false} /> : null}
        <Card className="thanos-card overflow-hidden" data-testid="thanos-conversation-card"><CardHeader className="border-b border-border/60 px-5 py-4 sm:px-6"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-3"><div className="thanos-icon-box thanos-icon-box-primary"><Sparkles className="size-4" /></div><div><CardTitle className="text-base">Conversa principal</CardTitle><p className="mt-0.5 text-xs text-muted-foreground">Pergunte em linguagem natural. O contexto é decidido no servidor.</p></div></div><div className="hidden items-center gap-2 sm:flex"><StatusDot label="Online" /><button type="button" aria-label="Mais informações sobre a conversa" className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><MoreHorizontal className="size-4" /></button></div></div></CardHeader><CardContent className="p-0">
          {conversationQuery.isError ? <div className="p-5"><ErrorNotice onRetry={() => conversationQuery.refetch()} /></div> : conversationQuery.isLoading ? <div className="space-y-3 p-5"><Skeleton className="h-14 w-3/4 rounded-2xl" /><Skeleton className="ml-auto h-12 w-1/2 rounded-2xl" /><Skeleton className="h-20 w-4/5 rounded-2xl" /></div> : <AIChatBox messages={messages} onSendMessage={sendMessage} isLoading={isBusy || sendMutation.isPending} height="min(58vh, 590px)" placeholder="Pergunte a THÁNOS sobre seu workspace..." emptyStateMessage="Estou pronto para transformar dados autorizados em clareza." suggestedPrompts={["O que merece atenção hoje?", "Resuma os principais indicadores.", "Quais próximos passos estão disponíveis?"]} className="thanos-command-chat min-h-[470px] rounded-none border-0 shadow-none" />}
        </CardContent></Card>
        <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-card/70 p-3 shadow-sm sm:flex-row sm:items-center"><VoiceRecorder disabled={!conversationId || sendMutation.isPending} onAudio={transcribeAudio} /><div className="flex min-w-0 flex-1 items-center gap-3 px-1"><div className="thanos-icon-box thanos-icon-box-muted"><Mic2 className="size-4" /></div><div className="min-w-0"><p className="text-sm font-medium">Falar com THÁNOS</p><p className="truncate text-xs text-muted-foreground">{voicePlaybackIssue ?? "Sua mensagem de voz é processada com privacidade."}</p></div></div><VoiceStateChip state={voiceState} />{latestAnswer ? <Button variant="outline" size="sm" onClick={speakLatest} disabled={voiceState === "processing"} className="shrink-0"><Volume2 className="mr-2 size-4" />Ouvir resposta</Button> : null}</div>
      </div>
      <aside className="space-y-4"><Card className="thanos-card"><CardHeader className="pb-3"><p className="thanos-eyebrow">Contexto</p><CardTitle className="mt-1 text-base">Você está em {workspaceName}</CardTitle></CardHeader><CardContent className="space-y-3 pt-0"><div className="flex items-start gap-3"><div className="thanos-icon-box thanos-icon-box-success"><ShieldCheck className="size-4" /></div><p className="text-sm leading-6 text-muted-foreground">Tenant, capabilities e ferramentas são validados pelo backend. Esta área apenas mostra o contexto ativo.</p></div><Button variant="outline" className="w-full justify-between" onClick={onWorkspaceInfo}>Ver contexto <ArrowUpRight className="size-4" /></Button></CardContent></Card><ThanosEvidenceCard source={workspaceName} action="Consulta assistida" /><Card className="thanos-card"><CardHeader className="pb-3"><p className="thanos-eyebrow">Poderes utilizados</p><CardTitle className="mt-1 text-base">O essencial, sem ruído</CardTitle></CardHeader><CardContent className="space-y-1 pt-0"><ThanosPower name="Consulta contextual" description="Acesso somente ao que sua sessão permite." used /><ThanosPower name="Auditoria sanitizada" description="Cada resposta preserva proveniência permitida." used /></CardContent></Card></aside>
    </div>
  </div>;
}

function UserHistory({ workspaceName }: { workspaceName: string }) {
  return <div className="space-y-5" data-testid="thanos-history"><CommandHeader title="Suas conversas, em um só lugar." workspaceName={workspaceName} mode="user" onWorkspaceInfo={() => toast.info("A troca de workspace continua sujeita à decisão server-side.")} /><Card className="thanos-card"><CardContent className="flex min-h-[360px] flex-col items-center justify-center px-6 py-12 text-center"><ThanosEmptyIcon /><h2 className="mt-5 text-xl font-semibold">O histórico cresce com você.</h2><p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">As conversas autorizadas aparecem aqui quando disponíveis para esta sessão. Nenhum dado é inventado nesta experiência.</p><Button className="mt-6" onClick={() => toast.info("Abra um novo chat pela navegação lateral.")}><MessageCircle className="mr-2 size-4" />Começar uma conversa</Button></CardContent></Card></div>;
}

function UserWorkspace({ workspaceName }: { workspaceName: string }) {
  return <div className="space-y-5" data-testid="thanos-workspace"><CommandHeader title="Seu contexto de trabalho." workspaceName={workspaceName} mode="user" onWorkspaceInfo={() => undefined} /><div className="grid gap-5 md:grid-cols-2"><Card className="thanos-card"><CardHeader><p className="thanos-eyebrow">Workspace ativo</p><CardTitle className="mt-1 text-xl">{workspaceName}</CardTitle></CardHeader><CardContent className="space-y-4"><div className="flex items-center gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4"><div className="thanos-icon-box thanos-icon-box-success"><ShieldCheck className="size-4" /></div><div><p className="font-medium">Contexto protegido</p><p className="mt-1 text-sm leading-5 text-muted-foreground">O backend determina tenant, membership e capabilities antes de qualquer ação.</p></div></div><div className="grid grid-cols-2 gap-3"><div className="rounded-2xl bg-muted/40 p-4"><p className="text-xs text-muted-foreground">Disponibilidade</p><p className="mt-1 font-semibold">Ativo</p></div><div className="rounded-2xl bg-muted/40 p-4"><p className="text-xs text-muted-foreground">Canais</p><p className="mt-1 font-semibold">Web seguro</p></div></div></CardContent></Card><Card className="thanos-card"><CardHeader><p className="thanos-eyebrow">Privacidade por design</p><CardTitle className="mt-1 text-xl">Você não precisa operar a infraestrutura.</CardTitle></CardHeader><CardContent className="space-y-3 text-sm leading-6 text-muted-foreground"><p>Providers, registries, grants e endpoints permanecem internos.</p><p>O que você vê é uma resposta clara, uma fonte sanitizada e o próximo passo seguro.</p><ThanosLockedNotice description="Trocas de workspace solicitadas pela UI passam por validação server-side. O seletor não muda autoridade sozinho." /></CardContent></Card></div></div>;
}

function UserVoice({ workspaceName }: { workspaceName: string }) {
  return <div className="space-y-5" data-testid="thanos-voice"><CommandHeader title="Fale com THÁNOS." workspaceName={workspaceName} mode="user" onWorkspaceInfo={() => undefined} /><div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]"><Card className="thanos-card thanos-voice-hero"><CardContent className="flex min-h-[360px] flex-col items-center justify-center px-6 py-12 text-center"><div className="thanos-voice-orb"><div className="thanos-voice-orb-core"><Mic2 className="size-7" /></div></div><p className="thanos-eyebrow mt-8">Entrada de voz</p><h2 className="mt-2 text-2xl font-semibold">Fale naturalmente.</h2><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">Na conversa principal, use o microfone para enviar uma mensagem de voz sem exibir a transcrição no histórico.</p><Button className="mt-6" onClick={() => toast.info("Use o microfone no campo da conversa para começar.")}><Mic2 className="mr-2 size-4" />Ir para conversa</Button></CardContent></Card><div className="space-y-4"><ThanosEvidenceCard source={workspaceName} action="Entrada de voz" status="Privado" /><Card className="thanos-card"><CardHeader><CardTitle className="text-base">Estados da voz</CardTitle></CardHeader><CardContent className="space-y-3 pt-0"><div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">Pronto</span><StatusBadge status="available" label="Disponível" /></div><div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">Processando</span><StatusBadge status="pending" label="Transcrevendo" /></div><div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">Resposta</span><StatusBadge status="available" label="Ouvir quando quiser" /></div></CardContent></Card></div></div></div>;
}

function AdminOverview({ workspaceName, accessData, overviewData, integrationData, catalogData }: { workspaceName: string; accessData?: { role?: string | null }; overviewData?: any; integrationData?: any; catalogData?: any[] }) {
  const toolsCount = catalogData?.length ?? 0;
  const hermes = integrationData?.hermes?.hermes;
  const org = overviewData?.organization?.name ?? workspaceName;
  return <div className="space-y-5" data-testid="thanos-admin-overview"><CommandHeader title="Control room THÁNOS." workspaceName={org} mode="admin" onWorkspaceInfo={() => toast.info("Contexto administrativo exibido de forma sanitizada.")} /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><AdminMetric icon={Activity} label="Status THÁNOS" value="Online" detail="Governado" tone="positive" /><AdminMetric icon={LayoutGrid} label="Workspace ativo" value={org} detail="Contexto server-side" tone="primary" /><AdminMetric icon={Gem} label="Ferramentas aprovadas" value={toolsCount || "—"} detail="Catálogo fechado" tone="violet" /><AdminMetric icon={Radio} label="Hermes" value={hermes?.enabled ? "Opt-in" : "Desativado"} detail="Sem segredos visíveis" tone="amber" /></div><div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]"><Card className="thanos-card"><CardHeader><p className="thanos-eyebrow">Leitura rápida</p><CardTitle className="mt-1 text-xl">Operação sob controle.</CardTitle></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2"><AdminFeature icon={ShieldCheck} title="Acesso administrativo" value={accessData?.role ?? "Autorizado"} description="Permissões decididas pelo servidor." /><AdminFeature icon={Database} title="Evidence" value="Sanitizada" description="Proveniência permitida, sem payload bruto." /><AdminFeature icon={Network} title="Connectors" value="Allowlisted" description="Sem criação livre pela UI." /><AdminFeature icon={Workflow} title="WRITE público" value="Desativado" description="Confirmação visual sem ativação externa." /></CardContent></Card><ThanosEvidenceCard source={org} action="Overview administrativa" status="Concluído" /></div></div>;
}

function AdminMetric({ icon: Icon, label, value, detail, tone }: { icon: typeof Activity; label: string; value: string | number; detail: string; tone: "positive" | "primary" | "violet" | "amber" }) {
  return <Card className="thanos-card"><CardContent className="p-5"><div className={`thanos-icon-box thanos-icon-box-${tone}`}><Icon className="size-4" /></div><p className="mt-5 text-xs text-muted-foreground">{label}</p><p className="mt-1 truncate text-lg font-semibold tracking-tight">{value}</p><p className="mt-1 text-xs text-muted-foreground">{detail}</p></CardContent></Card>;
}

function AdminFeature({ icon: Icon, title, value, description }: { icon: typeof ShieldCheck; title: string; value: string; description: string }) {
  return <div className="rounded-2xl border border-border/70 bg-muted/25 p-4"><div className="flex items-center gap-2 text-primary"><Icon className="size-4" /><span className="text-xs font-semibold uppercase tracking-[0.12em]">{title}</span></div><p className="mt-3 text-base font-semibold">{value}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div>;
}

function AdminCatalog({ catalogData, type }: { catalogData?: any[]; type: "jewels" | "powers" }) {
  const items = catalogData ?? [];
  const title = type === "jewels" ? "Joias registradas." : "Poderes disponíveis.";
  return <div className="space-y-5"><CommandHeader title={title} workspaceName="Workspace autorizado" mode="admin" onWorkspaceInfo={() => undefined} /><Card className="thanos-card"><CardHeader><p className="thanos-eyebrow">Catálogo fechado</p><CardTitle className="mt-1 text-xl">Somente o que existe aparece aqui.</CardTitle></CardHeader><CardContent className="space-y-2">{items.length ? items.map((item, index) => type === "jewels" ? <ThanosJewel key={item.name ?? index} name={item.name ?? "Ferramenta registrada"} description={item.description ?? "Skill registrada no catálogo seguro."} status={item.enabled === false ? "disabled" : "available"} icon={Gem} /> : <ThanosPower key={item.name ?? index} name={item.name ?? "Poder registrado"} description={item.description ?? "Connector allowlisted."} />) : <ThanosLockedNotice title="Catálogo indisponível" description="Não há dados sanitizados para exibir neste momento." />}</CardContent></Card></div>;
}

function AdminStatusPanel({ section, integrationData, overviewData }: { section: "providers" | "channels" | "audit" | "system"; integrationData?: any; overviewData?: any }) {
  const hermes = integrationData?.hermes?.hermes;
  const org = overviewData?.organization?.name ?? "Workspace autorizado";
  const titles: Record<typeof section, { title: string; eyebrow: string }> = { providers: { title: "Providers sanitizados.", eyebrow: "Providers" }, channels: { title: "Canais sob controle.", eyebrow: "Canais" }, audit: { title: "Auditoria recente.", eyebrow: "Auditoria" }, system: { title: "Sistema THÁNOS.", eyebrow: "Sistema" } };
  const current = titles[section];
  return <div className="space-y-5"><CommandHeader title={current.title} workspaceName={org} mode="admin" onWorkspaceInfo={() => undefined} /><div className="grid gap-5 lg:grid-cols-2"><Card className="thanos-card"><CardHeader><p className="thanos-eyebrow">{current.eyebrow}</p><CardTitle className="mt-1 text-xl">Visibilidade com limites.</CardTitle></CardHeader><CardContent className="space-y-3"><SanitizedRow icon={Radio} label="Hermes" value={section === "providers" ? (hermes?.enabled ? "Opt-in" : "Desativado") : "Desativado por padrão"} /><SanitizedRow icon={Network} label="Canais externos" value="Não ativados" /><SanitizedRow icon={ShieldCheck} label="Segredos e URLs" value="Nunca exibidos" /><SanitizedRow icon={FileCheck2} label="Evidence" value={section === "audit" ? "Sanitizada" : "Disponível"} /></CardContent></Card><ThanosEvidenceCard source={org} action={current.eyebrow} status="Concluído" /></div></div>;
}

function SanitizedRow({ icon: Icon, label, value }: { icon: typeof Radio; label: string; value: string }) {
  return <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-muted/20 p-4"><div className="thanos-icon-box thanos-icon-box-muted"><Icon className="size-4" /></div><div className="min-w-0 flex-1"><p className="text-sm font-medium">{label}</p><p className="mt-0.5 text-xs text-muted-foreground">{value}</p></div><Check className="size-4 text-emerald-400" /></div>;
}

function AdminDenied() {
  return <div className="space-y-5" data-testid="thanos-admin-denied"><CommandHeader title="Área de controle protegida." workspaceName="Sessão atual" mode="user" onWorkspaceInfo={() => undefined} /><Card className="thanos-card"><CardContent className="flex min-h-[360px] flex-col items-center justify-center px-6 py-12 text-center"><div className="thanos-icon-box thanos-icon-box-warning size-14"><LockKeyhole className="size-6" /></div><h2 className="mt-5 text-2xl font-semibold">Acesso de Tenant Admin necessário.</h2><p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">Esta experiência de Tenant Admin só aparece quando o backend confirma a permissão administrativa da organização. A UI não cria nem eleva autoridade.</p><ThanosLockedNotice title="Fronteira server-side" description="Role, capability, platformRole e workspace não são derivados de localStorage, query params ou estado visual." /></CardContent></Card></div>;
}

export default function ThanosCommandCenter({ requestedMode = "user" }: { requestedMode?: ExperienceMode }) {
  const { user, isAuthenticated, logout } = useAuth();
  const [activeSection, setActiveSection] = useState<ExperienceSection>(requestedMode === "admin" ? "overview" : "chat");
  const access = trpc.pastoral.settingsAccess.useQuery(undefined, { enabled: requestedMode === "admin" && Boolean(user && isAuthenticated) });
  const isTenantAdmin = requestedMode === "admin" && access.data?.allowed === true;
  const mode: ExperienceMode = isTenantAdmin ? "admin" : "user";
  const dashboard = trpc.pastoral.dashboard.useQuery(undefined, { enabled: Boolean(user && isAuthenticated) });
  const adminOverview = trpc.pastoral.settingsOverview.useQuery(undefined, { enabled: isTenantAdmin });
  const adminIntegrations = trpc.pastoral.integrationStatus.useQuery(undefined, { enabled: isTenantAdmin });
  const adminCatalog = trpc.pastoral.toolCatalog.useQuery(undefined, { enabled: isTenantAdmin });
  const workspaceName = dashboard.data?.tenant?.organizationName ?? adminOverview.data?.organization?.name ?? "Workspace Pastoral";
  const onWorkspaceInfo = () => setActiveSection("workspace");

  useEffect(() => {
    if (requestedMode === "admin" && access.data && !access.data.allowed) setActiveSection("overview");
  }, [requestedMode, access.data]);

  const renderUserSection = () => {
    if (activeSection === "history") return <UserHistory workspaceName={workspaceName} />;
    if (activeSection === "workspace") return <UserWorkspace workspaceName={workspaceName} />;
    if (activeSection === "voice") return <UserVoice workspaceName={workspaceName} />;
    return <UserChat workspaceName={workspaceName} onWorkspaceInfo={onWorkspaceInfo} />;
  };
  const renderAdminSection = () => {
    if (!isTenantAdmin) return <AdminDenied />;
    if (activeSection === "jewels") return <AdminCatalog catalogData={adminCatalog.data} type="jewels" />;
    if (activeSection === "powers") return <AdminCatalog catalogData={adminCatalog.data} type="powers" />;
    if (activeSection === "providers" || activeSection === "channels" || activeSection === "audit" || activeSection === "system") return <AdminStatusPanel section={activeSection} integrationData={adminIntegrations.data} overviewData={adminOverview.data} />;
    if (activeSection === "workspaces") return <UserWorkspace workspaceName={workspaceName} />;
    return <AdminOverview workspaceName={workspaceName} accessData={access.data ?? undefined} overviewData={adminOverview.data} integrationData={adminIntegrations.data} catalogData={adminCatalog.data} />;
  };

  return <ThanosExperienceLayout mode={mode} activeSection={activeSection} onSectionChange={setActiveSection} workspaceName={workspaceName} userName={user?.name} userEmail={user?.email} onLogout={() => void logout()}>{requestedMode === "admin" ? (access.isLoading ? <div className="space-y-5"><div className="h-32 animate-pulse rounded-3xl bg-muted/40" /><div className="grid gap-4 sm:grid-cols-2"><Skeleton className="h-44 rounded-2xl" /><Skeleton className="h-44 rounded-2xl" /></div></div> : renderAdminSection()) : renderUserSection()}</ThanosExperienceLayout>;
}

export function ThanosTenantAdmin() {
  return <ThanosCommandCenter requestedMode="admin" />;
}
