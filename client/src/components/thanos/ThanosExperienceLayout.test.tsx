import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getExperienceNavigation, ThanosExperienceLayout } from "./ThanosExperienceLayout";

describe("THÁNOS experience navigation", () => {
  it("keeps the USER experience limited to conversation and workspace surfaces", () => {
    const ids = getExperienceNavigation("user").map(item => item.id);
    expect(ids).toEqual(["chat", "history", "workspace", "voice"]);
    expect(ids).not.toContain("overview");
    expect(ids).not.toContain("providers");
    expect(ids).not.toContain("audit");
  });

  it("renders sidebar, workspace context and mobile drawer semantics", () => {
    const html = renderToStaticMarkup(
      <ThanosExperienceLayout
        mode="user"
        activeSection="chat"
        onSectionChange={() => undefined}
        workspaceName="Workspace Sintético"
        userName="Usuário de teste"
        userEmail="user@example.test"
      >
        <div>Conteúdo de teste</div>
      </ThanosExperienceLayout>,
    );
    expect(html).toContain("Workspace Sintético");
    expect(html).toContain("Navegação THÁNOS");
    expect(html).toContain("Conteúdo de teste");
    expect(html).toContain('aria-label="Abrir menu"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("thanos-mobile-header");
  });

  it("exposes TENANT ADMIN sections as a presentation contract only", () => {
    const items = getExperienceNavigation("admin");
    expect(items.map(item => item.id)).toEqual([
      "overview",
      "workspaces",
      "jewels",
      "powers",
      "providers",
      "channels",
      "audit",
      "system",
    ]);
    expect(items.every(item => item.label.length > 0 && item.icon)).toBe(true);
  });

  it("labels the administrative shell as tenant-scoped rather than platform-wide", () => {
    const html = renderToStaticMarkup(
      <ThanosExperienceLayout
        mode="admin"
        activeSection="overview"
        onSectionChange={() => undefined}
        workspaceName="Workspace Sintético"
        userName="Admin de teste"
      >
        <div>Área administrativa</div>
      </ThanosExperienceLayout>,
    );
    expect(html).toContain("Tenant Admin / Control room");
    expect(html).toContain("Administração do tenant THÁNOS");
    expect(html).toContain("Tenant Admin autorizado");
    expect(html).not.toContain("Superadmin");
  });
});
