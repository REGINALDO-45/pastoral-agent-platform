import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { ChevronDown, Menu, MessageSquareText, PanelLeftClose, PanelLeftOpen, ShieldCheck, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { ThanosMark, StatusDot } from "./ThanosPrimitives";

export type ExperienceMode = "user" | "superadmin";
export type ExperienceSection = "chat" | "history" | "workspace" | "voice" | "overview" | "workspaces" | "jewels" | "powers" | "providers" | "channels" | "audit" | "system";

type NavItem = { id: ExperienceSection; label: string; icon: typeof MessageSquareText; badge?: string };

const userNav: NavItem[] = [
  { id: "chat", label: "Novo chat", icon: MessageSquareText },
  { id: "history", label: "Conversas", icon: Sparkles },
  { id: "workspace", label: "Workspace", icon: ShieldCheck },
  { id: "voice", label: "Voz", icon: MessageSquareText },
];

const adminNav: NavItem[] = [
  { id: "overview", label: "Overview", icon: Sparkles },
  { id: "workspaces", label: "Workspaces", icon: ShieldCheck },
  { id: "jewels", label: "Joias", icon: Sparkles },
  { id: "powers", label: "Poderes", icon: ShieldCheck },
  { id: "providers", label: "Providers", icon: MessageSquareText },
  { id: "channels", label: "Canais", icon: MessageSquareText },
  { id: "audit", label: "Auditoria", icon: ShieldCheck },
  { id: "system", label: "Sistema", icon: Sparkles },
];

export function getExperienceNavigation(mode: ExperienceMode) {
  return mode === "superadmin" ? adminNav : userNav;
}

export function ThanosExperienceLayout({
  mode,
  activeSection,
  onSectionChange,
  workspaceName,
  userName,
  userEmail,
  children,
  onLogout,
}: {
  mode: ExperienceMode;
  activeSection: ExperienceSection;
  onSectionChange: (section: ExperienceSection) => void;
  workspaceName: string;
  userName?: string | null;
  userEmail?: string | null;
  children: React.ReactNode;
  onLogout?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const navItems = getExperienceNavigation(mode);
  const activeItem = navItems.find(item => item.id === activeSection) ?? navItems[0];

  const selectSection = (section: ExperienceSection) => {
    onSectionChange(section);
    setMobileOpen(false);
  };

  const navigation = (mobile = false) => (
    <nav aria-label={mode === "superadmin" ? "Administração THÁNOS" : "Navegação THÁNOS"} className="flex flex-col gap-1">
      {navItems.map(item => {
        const active = item.id === activeSection;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={active ? "page" : undefined}
            aria-label={item.label}
            onClick={() => selectSection(item.id)}
            className={cn("thanos-nav-item", active && "thanos-nav-item-active", mobile && "thanos-nav-item-mobile")}
          >
            <item.icon className="size-4 shrink-0" aria-hidden="true" />
            <span className={cn("truncate", collapsed && !mobile && "lg:hidden")}>{item.label}</span>
            {item.badge ? <span className="ml-auto rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">{item.badge}</span> : null}
          </button>
        );
      })}
    </nav>
  );

  return (
    <div className="thanos-app-shell min-h-[100dvh] bg-background text-foreground">
      <aside className={cn("thanos-desktop-sidebar fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-border/70 bg-card/75 backdrop-blur-xl lg:flex", collapsed ? "w-[84px]" : "w-[252px]")}>
        <div className="flex h-20 items-center justify-between border-b border-border/60 px-5">
          <button type="button" onClick={() => setCollapsed(value => !value)} className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={collapsed ? "Expandir menu" : "Recolher menu"}>
            <ThanosMark compact={collapsed} />
          </button>
          {!collapsed ? <Button variant="ghost" size="icon" onClick={() => setCollapsed(true)} className="size-8 rounded-lg text-muted-foreground hover:text-foreground" aria-label="Recolher menu"><PanelLeftClose className="size-4" /></Button> : null}
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-5">
          {!collapsed ? <div className="mb-5 px-3"><p className="thanos-eyebrow">{mode === "superadmin" ? "Control room" : "Command center"}</p><div className="mt-2 flex items-center gap-2"><StatusDot label="Online" /><span className="text-[11px] text-muted-foreground">Protegido</span></div></div> : <div className="mb-5 flex justify-center"><StatusDot label="" /></div>}
          {navigation()}
          <div className={cn("my-6 h-px bg-border/60", collapsed && "mx-2")} />
          {!collapsed ? <div className="px-3"><p className="thanos-eyebrow">Workspace ativo</p><div className="mt-3 flex items-center gap-3 rounded-2xl border border-border/70 bg-muted/30 p-3"><span className="flex size-8 items-center justify-center rounded-xl bg-primary/12 text-primary"><ShieldCheck className="size-4" /></span><div className="min-w-0"><p className="truncate text-sm font-medium">{workspaceName}</p><p className="mt-0.5 text-[11px] text-muted-foreground">Contexto protegido</p></div></div></div> : null}
        </div>
        <div className="border-t border-border/60 p-3">
          <div className={cn("flex items-center gap-3 rounded-2xl p-2", collapsed && "justify-center")}>
            <Avatar className="size-9 border border-border"><AvatarFallback className="bg-primary/12 text-xs text-primary">{userName?.charAt(0).toUpperCase() ?? "T"}</AvatarFallback></Avatar>
            {!collapsed ? <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{userName ?? "Sessão protegida"}</p><p className="truncate text-[11px] text-muted-foreground">{mode === "superadmin" ? "Superadmin autorizado" : userEmail ?? "Acesso autenticado"}</p></div> : null}
            {!collapsed && onLogout ? <button type="button" onClick={onLogout} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Sair"><X className="size-4" /></button> : null}
          </div>
        </div>
      </aside>

      <div className={cn("min-h-[100dvh] transition-[padding] duration-200", collapsed ? "lg:pl-[84px]" : "lg:pl-[252px]")}>
        <header className="thanos-mobile-header sticky top-0 z-20 flex h-[72px] items-center justify-between border-b border-border/70 bg-background/80 px-4 backdrop-blur-xl lg:hidden">
          <div className="flex items-center gap-3"><Button variant="ghost" size="icon" className="size-9 rounded-xl" onClick={() => setMobileOpen(true)} aria-label="Abrir menu"><Menu className="size-5" /></Button><ThanosMark /></div>
          <div className="flex items-center gap-2"><StatusDot label="Online" /><span className="text-xs text-muted-foreground">{activeItem?.label}</span></div>
        </header>
        <main className="relative min-h-[calc(100dvh-72px)] overflow-hidden px-4 py-5 sm:px-6 lg:min-h-[100dvh] lg:px-10 lg:py-8">
          <div className="thanos-orbit thanos-orbit-one" aria-hidden="true" /><div className="thanos-orbit thanos-orbit-two" aria-hidden="true" />
          <div className="relative mx-auto max-w-[1440px]">{children}</div>
        </main>
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[min(86vw,340px)] border-r border-border/70 bg-card p-0">
          <SheetHeader className="border-b border-border/60 px-5 py-5 text-left"><SheetTitle><ThanosMark /></SheetTitle></SheetHeader>
          <div className="space-y-6 p-4"><div><p className="thanos-eyebrow px-3">{mode === "superadmin" ? "Control room" : "Command center"}</p><div className="mt-2 flex items-center gap-2 px-3"><StatusDot label="Online" /><span className="text-xs text-muted-foreground">Workspace protegido</span></div></div>{navigation(true)}<div className="rounded-2xl border border-border/70 bg-muted/25 p-4"><p className="thanos-eyebrow">Workspace ativo</p><p className="mt-2 font-medium">{workspaceName}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">O backend continua authoritative sobre tenant e contexto.</p></div></div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
