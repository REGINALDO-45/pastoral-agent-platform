import { Badge } from "@/components/ui/badge";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, CircleDashed, Clock3, Gem, LockKeyhole, ShieldCheck, Sparkles, Zap } from "lucide-react";

export type ThanosStatus = "online" | "pending" | "disabled" | "available" | "soon";

export function ThanosMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "thanos-mark thanos-mark-compact" : "thanos-mark"} aria-label="THÁNOS">
      <span className="thanos-mark-core" aria-hidden="true"><span /></span>
      {!compact ? <span className="thanos-mark-word">THÁNOS</span> : null}
    </div>
  );
}

export function StatusDot({ status = "online", label }: { status?: ThanosStatus; label: string }) {
  const tone = status === "online" || status === "available" ? "thanos-status-positive" : status === "pending" ? "thanos-status-pending" : status === "soon" ? "thanos-status-muted" : "thanos-status-disabled";
  return (
    <span className={`thanos-status ${tone}`}>
      <span className="thanos-status-dot" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function StatusBadge({ status, label }: { status: ThanosStatus; label: string }) {
  return <Badge variant="outline" className={`thanos-badge thanos-badge-${status}`}>{label}</Badge>;
}

export function ThanosEvidenceCard({
  source = "Contexto governado",
  action = "Consulta",
  status = "Concluído",
  timestamp = "Agora",
}: {
  source?: string;
  action?: string;
  status?: string;
  timestamp?: string;
}) {
  return (
    <Card className="thanos-card thanos-evidence-card">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
        <div>
          <p className="thanos-eyebrow">Evidence</p>
          <CardTitle className="mt-1 text-base">Registro sanitizado</CardTitle>
        </div>
        <div className="thanos-icon-box thanos-icon-box-success"><ShieldCheck className="size-4" aria-hidden="true" /></div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0 text-sm">
        <div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">Fonte</span><span className="text-right font-medium">{source}</span></div>
        <div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">Ação</span><span className="text-right font-medium">{action}</span></div>
        <div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">Status</span><StatusBadge status="available" label={status} /></div>
        <div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">Horário</span><span className="text-right text-xs text-muted-foreground">{timestamp}</span></div>
        <p className="border-t border-border/60 pt-3 text-xs leading-5 text-muted-foreground">Somente proveniência permitida é exibida. Payloads, grants e detalhes internos permanecem protegidos.</p>
      </CardContent>
    </Card>
  );
}

export function ThanosJewel({ name, description, status = "available", icon: Icon = Gem }: { name: string; description: string; status?: ThanosStatus; icon?: typeof Gem }) {
  return (
    <div className="thanos-list-item">
      <div className="thanos-icon-box thanos-icon-box-jewel"><Icon className="size-4" aria-hidden="true" /></div>
      <div className="min-w-0 flex-1"><p className="truncate font-medium">{name}</p><p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p></div>
      <StatusBadge status={status} label={status === "available" ? "Disponível" : status === "soon" ? "Em breve" : "Desativado"} />
    </div>
  );
}

export function ThanosPower({ name, description, used = false }: { name: string; description: string; used?: boolean }) {
  return (
    <div className="thanos-list-item">
      <div className="thanos-icon-box thanos-icon-box-power"><Zap className="size-4" aria-hidden="true" /></div>
      <div className="min-w-0 flex-1"><p className="truncate font-medium">{name}</p><p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p></div>
      <span className="text-xs text-muted-foreground">{used ? "Usado" : "Disponível"}</span>
    </div>
  );
}

export function ThanosConfirmationCard({
  title,
  summary,
  workspace,
  onCancel,
  onConfirm,
  confirming = false,
  blocked = false,
}: {
  title: string;
  summary: string;
  workspace: string;
  onCancel: () => void;
  onConfirm: () => void;
  confirming?: boolean;
  blocked?: boolean;
}) {
  return (
    <Card className={`thanos-confirmation-card ${blocked ? "thanos-confirmation-blocked" : ""}`} role="status" aria-live="polite">
      <CardContent className="p-5">
        <div className="flex items-start gap-3">
          <div className="thanos-icon-box thanos-icon-box-warning"><Clock3 className="size-4" aria-hidden="true" /></div>
          <div className="min-w-0 flex-1"><p className="thanos-eyebrow text-amber-300">Confirmação necessária</p><h3 className="mt-1 text-base font-semibold text-white">THÁNOS pretende {title}</h3><p className="mt-2 text-sm leading-6 text-white/70">{summary}</p></div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-white/60"><span className="rounded-full border border-white/10 px-2.5 py-1">Workspace: {workspace}</span><span className="rounded-full border border-amber-300/20 px-2.5 py-1 text-amber-200">Ação auditada</span></div>
        {blocked ? <p className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/10 p-3 text-sm leading-5 text-amber-100">A confirmação visual foi registrada nesta experiência, mas a execução pública WRITE permanece desativada nesta fase.</p> : <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button variant="ghost" className="text-white/75 hover:bg-white/10 hover:text-white" onClick={onCancel} disabled={confirming}>Cancelar</Button><Button className="bg-amber-300 text-slate-950 hover:bg-amber-200" onClick={onConfirm} disabled={confirming}>{confirming ? <CircleDashed className="mr-2 size-4 animate-spin" /> : <CheckCircle2 className="mr-2 size-4" />}Confirmar</Button></div>}
      </CardContent>
    </Card>
  );
}

export function ThanosLockedNotice({ title = "Área protegida", description }: { title?: string; description: string }) {
  return <div className="flex items-start gap-3 rounded-2xl border border-border/70 bg-muted/35 p-4"><div className="thanos-icon-box thanos-icon-box-muted"><LockKeyhole className="size-4" aria-hidden="true" /></div><div><p className="font-medium">{title}</p><p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p></div></div>;
}

export function ThanosEmptyIcon() {
  return <div className="thanos-empty-icon"><Sparkles className="size-5" aria-hidden="true" /></div>;
}

export function ThanosSectionHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div>{eyebrow ? <p className="thanos-eyebrow">{eyebrow}</p> : null}<h2 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{title}</h2>{description ? <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p> : null}</div>{action}</div>;
}
