export type TenantRole = "admin" | "pastor" | "supervisor" | "leader";
export type ConversationMessageType = "text" | "voice";

export type TenantContext = {
  organizationId: number;
  organizationName: string;
  userId: number;
  userName: string;
  role: TenantRole;
};

export const readPastoralToolNames = [
  "consultar_celulas",
  "consultar_relatorios",
  "consultar_presenca",
  "consultar_visitantes",
  "consultar_lideres",
] as const;

export type ReadPastoralToolName = (typeof readPastoralToolNames)[number];

export const pastoralToolNames = [
  ...readPastoralToolNames,
  "registrar_acompanhamento_visitante",
] as const;

export type PastoralToolName = (typeof pastoralToolNames)[number];

export type ToolCategory = "READ" | "WRITE" | "SENSITIVE";

export type ToolCatalogEntry = {
  name: PastoralToolName;
  category: ToolCategory;
  authorizedRoles: readonly TenantRole[];
  requiresConfirmation: boolean;
  enabled: boolean;
  description: string;
};

export type ConfirmationStatus = "not_required" | "pending" | "confirmed" | "duplicate" | "denied" | "failed";

export type ToolResult = {
  tool: ReadPastoralToolName;
  summary: string;
  data: Record<string, unknown>;
};

export type VisitorCandidate = {
  id: number;
  name: string;
  followedUp: boolean;
};

export interface PastoralRepository {
  queryCells(context: TenantContext): Promise<ToolResult>;
  queryReports(context: TenantContext): Promise<ToolResult>;
  queryAttendance(context: TenantContext): Promise<ToolResult>;
  queryVisitors(context: TenantContext): Promise<ToolResult>;
  queryLeaders(context: TenantContext): Promise<ToolResult>;
  findVisitor(context: TenantContext, name: string): Promise<VisitorCandidate | null>;
  appendMessage(input: {
    conversationId: number;
    context: TenantContext;
    role: "user" | "assistant";
    content: string;
    messageType?: ConversationMessageType;
    model?: string;
    tool?: string;
  }): Promise<void>;
  writeFollowup(input: {
    context: TenantContext;
    visitorId: number;
    note: string;
    idempotencyKey: string;
  }): Promise<{ created: boolean; visitorName: string }>;
  audit(input: {
    context: TenantContext;
    action: string;
    agent: string;
    model?: string;
    provider?: string;
    tool?: string;
    requestId?: string;
    result?: string;
    confirmationStatus?: ConfirmationStatus;
    status: "success" | "failure" | "denied";
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export type AgentResponse = {
  content: string;
  model: string;
  provider: string;
  tool?: string;
  requestId?: string;
  confirmationStatus?: ConfirmationStatus;
  gateway?: {
    version: "v1";
    provider: "legacy" | "hermes";
    fallback: boolean;
    fallbackReason?: "gateway_disabled" | "hermes_unavailable" | "hermes_circuit_open" | "hermes_invalid_request" | "hermes_pilot_local" | "local_confirmation";
  };
  thanos?: {
    version: string;
    mode: "single_read" | "multi_read";
    tools: readonly string[];
    fallback: boolean;
    fallbackReason?: "thanos_error";
  };
  confirmation?: {
    visitorId: number;
    visitorName: string;
    note: string;
    idempotencyKey: string;
  };
};

export type DashboardTrend = {
  status: "available" | "insufficient_data";
  direction?: "up" | "down" | "stable";
  currentValue: number;
  previousValue: number;
  percentageChange?: number;
  reason?: string;
};

export type DashboardInsight = {
  id: "pending_reports" | "visitor_followup" | "missed_meetings" | "leader_attention" | "all_clear";
  title: string;
  priority: "high" | "medium" | "info";
  summary: string;
  periodLabel: string;
  metrics: Record<string, number>;
};

export type DashboardPendingScope = {
  kind: "reporting_cycle" | "open_records" | "current_leadership_notes";
  label: string;
  explanation: string;
};

export type DashboardOverview = {
  period: {
    label: string;
    startAt: Date;
    endAt: Date;
    days: number;
  };
  metrics: {
    activeCells: number;
    completedCells: number;
    pendingCells: number;
    totalAttendance: number;
    averageAttendancePerCell: number | null;
    visitors: number;
    registeredPeople: number;
    leaders: number;
  };
  pending: {
    pendingReports: number;
    missedMeetings: number;
    visitorsWithoutFollowup: number;
    leadersRequiringAttention: number;
  };
  pendingScopes: {
    reports: DashboardPendingScope;
    missedMeetings: DashboardPendingScope;
    visitorsWithoutFollowup: DashboardPendingScope;
    leadersRequiringAttention: DashboardPendingScope;
  };
  trends: {
    attendance: DashboardTrend;
    completedCells: DashboardTrend;
  };
  intelligence: {
    mode: "rules";
    generativeStatus: "unavailable";
    unavailableReason: string;
    insights: DashboardInsight[];
  };
};
