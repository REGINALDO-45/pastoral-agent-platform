import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  StatusBadge,
  StatusDot,
  ThanosConfirmationCard,
  ThanosEvidenceCard,
  ThanosJewel,
  ThanosLockedNotice,
  ThanosMark,
  ThanosPower,
} from "./ThanosPrimitives";

const noop = vi.fn();

function markup(node: React.ReactElement) {
  return renderToStaticMarkup(node);
}

describe("THÁNOS presentation primitives", () => {
  it("renders the own mark and accessible label without protected assets", () => {
    const html = markup(<ThanosMark />);
    expect(html).toContain("THÁNOS");
    expect(html).toContain('aria-label="THÁNOS"');
    expect(html).not.toContain("Marvel");
    expect(html).not.toContain("Infinity");
  });

  it("renders status with text and not color alone", () => {
    const html = markup(<StatusDot status="pending" label="Confirmação pendente" />);
    expect(html).toContain("Confirmação pendente");
    expect(html).toContain("thanos-status-pending");
  });

  it("renders sanitized evidence and excludes payload, grant and raw error", () => {
    const html = markup(<ThanosEvidenceCard source="Workspace Sintético" action="Consulta assistida" status="Disponível" timestamp="Agora" />);
    expect(html).toContain("Registro sanitizado");
    expect(html).toContain("Workspace Sintético");
    expect(html).toContain("Somente proveniência permitida é exibida");
    expect(html).not.toContain("confirmationGrant");
    expect(html).not.toContain("rawConnectorError");
    expect(html).not.toContain("payload");
  });

  it("renders a pending confirmation with accessible confirm and cancel controls", () => {
    const html = markup(<ThanosConfirmationCard title="registrar uma atualização" summary="A ação será revisada antes de qualquer execução." workspace="Workspace Sintético" onCancel={noop} onConfirm={noop} />);
    expect(html).toContain("Confirmação necessária");
    expect(html).toContain("Confirmar");
    expect(html).toContain("Cancelar");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("grant");
  });

  it("renders blocked confirmation without exposing a public WRITE control", () => {
    const html = markup(<ThanosConfirmationCard blocked title="executar uma ação" summary="A execução pública está desativada." workspace="Workspace Sintético" onCancel={noop} onConfirm={noop} />);
    expect(html).toContain("execução pública WRITE permanece desativada");
    expect(html).not.toContain(">Confirmar<");
  });

  it("keeps the workspace visible while describing server-side authority", () => {
    const html = markup(<ThanosLockedNotice title="Workspace protegido" description="Tenant e capabilities são confirmados pelo backend." />);
    expect(html).toContain("Workspace protegido");
    expect(html).toContain("confirmados pelo backend");
    expect(html).not.toContain("localStorage");
  });

  it("labels available jewels without advertising unavailable functionality", () => {
    const available = markup(<ThanosJewel name="Consulta contextual" description="Acesso permitido no workspace atual." />);
    const soon = markup(<ThanosJewel name="Relatórios externos" description="Integração ainda não ativada." status="soon" />);
    const disabled = markup(<ThanosJewel name="WhatsApp" description="Canal desativado nesta fase." status="disabled" />);
    expect(available).toContain("Disponível");
    expect(soon).toContain("Em breve");
    expect(disabled).toContain("Desativado");
    expect(disabled).not.toContain("Ativo");
  });

  it("distinguishes used powers from merely available capabilities", () => {
    const used = markup(<ThanosPower name="Evidence sanitizada" description="Proveniência permitida." used />);
    const available = markup(<ThanosPower name="Auditoria" description="Disponível para a sessão." />);
    expect(used).toContain("Usado");
    expect(available).toContain("Disponível");
  });

  it("renders disabled status as explicit text instead of silently hiding it", () => {
    const html = markup(<StatusBadge status="disabled" label="Desativado" />);
    expect(html).toContain("Desativado");
    expect(html).toContain("thanos-badge-disabled");
  });
});
