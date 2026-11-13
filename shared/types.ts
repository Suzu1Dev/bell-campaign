export const AI_PROVIDERS = ["builtin", "codex", "claude", "antigravity", "api"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const PACING_LEVELS = ["relaxed", "steady", "balanced", "compact", "intense"] as const;
export type PacingLevel = (typeof PACING_LEVELS)[number];

export const CELL_STAGES = [
  "待排",
  "進度20%",
  "進度25%",
  "進度40%",
  "進度50%",
  "進度60%",
  "進度75%",
  "進度80%",
  "進度100%",
  "Debug",
  "RC",
  "活動",
  "復盤",
] as const;
export type CellStage = (typeof CELL_STAGES)[number];

export const TEAM_COLORS = ["rose", "violet", "mint", "amber", "sky", "terracotta"] as const;
export type TeamColor = (typeof TEAM_COLORS)[number];

export const FILE_CATEGORIES = ["handbook", "social", "vendor", "slides", "other"] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

export const HANDBOOK_TEMPLATES = ["staff_lazy_pack", "speaker_handbook", "speaker_reminder", "vendor_brief"] as const;
export type HandbookTemplate = (typeof HANDBOOK_TEMPLATES)[number];

export const APPLICANT_STATUSES = ["pending", "interview", "accepted", "waitlist", "declined"] as const;
export type ApplicantStatus = (typeof APPLICANT_STATUSES)[number];

export const APPLICANT_ROLES = ["core", "staff", "day_volunteer"] as const;
export type ApplicantRole = (typeof APPLICANT_ROLES)[number];

export const PARTNER_KINDS = ["speaker", "vendor", "temp_staff"] as const;
export type PartnerKind = (typeof PARTNER_KINDS)[number];

export const PARTNER_STATUSES = [
  "prospect",
  "contacting",
  "confirmed",
  "briefed",
  "completed",
  "declined",
] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export interface PacingMeta {
  id: PacingLevel;
  label: string;
  shortLabel: string;
  factor: number;
  bufferWeeks: number;
  maxTasksPerTeamWeek: number;
  summary: string;
}

export const PACING_META: readonly PacingMeta[] = [
  {
    id: "relaxed",
    label: "從容留白",
    shortLabel: "從容",
    factor: 0.7,
    bufferWeeks: 2,
    maxTasksPerTeamWeek: 2,
    summary: "拉長前置探索並保留雙週緩衝，適合課餘或兼職籌備團隊",
  },
  {
    id: "steady",
    label: "穩健緩衝",
    shortLabel: "穩健",
    factor: 0.85,
    bufferWeeks: 2,
    maxTasksPerTeamWeek: 3,
    summary: "活動前兩週即進入 Debug 與 RC 驗收，降低死線壓力",
  },
  {
    id: "balanced",
    label: "均衡適中",
    shortLabel: "適中",
    factor: 1.0,
    bufferWeeks: 1,
    maxTasksPerTeamWeek: 3,
    summary: "預設黃金節奏：不鬆不緊、自動避開撞期大活動",
  },
  {
    id: "compact",
    label: "緊湊推進",
    shortLabel: "緊湊",
    factor: 1.15,
    bufferWeeks: 1,
    maxTasksPerTeamWeek: 4,
    summary: "縮短初期發散週數，把關鍵產出集中在核心推進期",
  },
  {
    id: "intense",
    label: "密集衝刺",
    shortLabel: "衝刺",
    factor: 1.3,
    bufferWeeks: 0,
    maxTasksPerTeamWeek: 5,
    summary: "高密度並行推進，適合倒數週數短的緊急專案",
  },
];

export interface ProviderSettings {
  provider: AiProvider;
  model: string;
}

export interface MonthlyGoal {
  month: string;
  goal: string;
}

export interface WeekEventItem {
  id: string;
  title: string;
  kind: "milestone" | "conflict";
  dateLabel?: string;
}

export interface CampaignSummary {
  id: string;
  name: string;
  subtitle: string;
  eventDate: string;
  startDate: string;
  postWeeks: number;
  pacing: PacingLevel;
  updatedAt: string;
}

export interface CampaignMeta extends CampaignSummary {
  brief: string;
  mainGoal: string;
  monthlyGoals: MonthlyGoal[];
  sheetUrl: string;
  slidesUrl: string;
}

export interface CampaignWeek {
  id: string;
  campaignId: string;
  orderIndex: number;
  monthLabel: string;
  dateRange: string;
  startDate: string;
  endDate: string;
  countdownLabel: string;
  phase: "prep" | "event" | "post";
  majorEvents: WeekEventItem[];
  memo: string;
  progressOverride: number | null;
}

export interface CampaignTeam {
  id: string;
  campaignId: string;
  name: string;
  lead: string;
  color: TeamColor;
  targetHeadcount: number;
  orderIndex: number;
}

export interface ScheduleCell {
  weekId: string;
  teamId: string;
  stage: CellStage;
  weeklyFocus: string;
  crossTeam: string;
  updatedAt: string;
}

export interface CampaignTodo {
  id: string;
  campaignId: string;
  teamId: string;
  weekId: string | null;
  title: string;
  assignee: string;
  done: boolean;
  priority: "normal" | "high";
  dueDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignNote {
  id: string;
  campaignId: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  updatedAt: string;
}

export interface CampaignFile {
  id: string;
  campaignId: string;
  title: string;
  category: FileCategory;
  teamId: string | null;
  kind: "upload" | "generated";
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  contentMd: string;
  templateKind: HandbookTemplate | null;
  createdAt: string;
  updatedAt: string;
}

export type MeetingDocSource = "" | "gdoc" | "hackmd" | "markdown";

export interface CampaignMeeting {
  id: string;
  campaignId: string;
  title: string;
  meetingDate: string;
  attendees: string;
  agenda: string;
  arrangements: string;
  precautions: string;
  decisions: string;
  docUrl: string;
  docSource: MeetingDocSource;
  updatedAt: string;
}

export interface TempStaffTask {
  id: string;
  title: string;
  done: boolean;
}

export interface CampaignPartner {
  id: string;
  campaignId: string;
  kind: PartnerKind;
  name: string;
  organization: string;
  roleOrTopic: string;
  contact: string;
  teamId: string | null;
  status: PartnerStatus;
  shiftOrFee: string;
  notes: string;
  tasks: TempStaffTask[];
  updatedAt: string;
}

export interface CampaignInspiration {
  id: string;
  campaignId: string;
  title: string;
  region: "國內" | "國際";
  category: string;
  similarityScore: number;
  whySimilar: string;
  timelinePattern: string;
  specialIdeas: string[];
  pitfalls: string[];
  updatedAt: string;
}

export interface RecruitmentForm {
  id: string;
  campaignId: string;
  title: string;
  sourceUrl: string;
  sheetSyncUrl: string;
  lastSyncedAt: string;
  status: "open" | "closed";
  description: string;
  updatedAt: string;
}

export interface FormResponseItem {
  id: string;
  formId: string;
  applicantName: string;
  email: string;
  handle: string;
  preferredTeamId: string;
  secondaryTeamId: string | null;
  roleType: ApplicantRole;
  skills: string[];
  availability: string[];
  experience: string;
  dietaryOrShirt: string;
  status: ApplicantStatus;
  reviewerNote: string;
  submittedAt: string;
}

export type BotActionKind =
  | "setup_project_brief"
  | "adjust_pacing"
  | "auto_schedule"
  | "add_todo"
  | "toggle_todo"
  | "add_week_event"
  | "create_meeting"
  | "create_note"
  | "generate_handbook"
  | "update_applicant"
  | "add_partner";

export interface BotActionProposal {
  id: string;
  kind: BotActionKind;
  summary: string;
  detail: string;
  payload: Record<string, unknown>;
  applied: boolean;
}

export interface BotMessage {
  id: string;
  campaignId: string;
  role: "user" | "assistant";
  content: string;
  proposals: BotActionProposal[];
  createdAt: string;
}

export interface AutoScheduleInput {
  mainGoal: string;
  monthlyGoals: MonthlyGoal[];
  tasksText: string;
  pacing: PacingLevel;
  eventDate?: string;
  postWeeks?: number;
}

export interface ProposedCellChange {
  weekId: string;
  teamId: string;
  stage: CellStage;
  weeklyFocus: string;
  crossTeam?: string;
}

export interface ProposedNewTodo {
  teamId: string;
  weekId: string;
  title: string;
  priority: "normal" | "high";
}

export interface AutoSchedulePreview {
  pacing: PacingLevel;
  rationale: string;
  avoidedConflictWeeks: string[];
  cells: ProposedCellChange[];
  todos: ProposedNewTodo[];
  weeklyLoadScores: Array<{ weekId: string; label: string; score: number; hasConflict: boolean }>;
}

export interface CampaignSnapshot {
  campaign: CampaignMeta;
  campaigns: CampaignSummary[];
  weeks: CampaignWeek[];
  teams: CampaignTeam[];
  cells: ScheduleCell[];
  todos: CampaignTodo[];
  notes: CampaignNote[];
  files: CampaignFile[];
  meetings: CampaignMeeting[];
  partners: CampaignPartner[];
  inspirations: CampaignInspiration[];
  forms: RecruitmentForm[];
  formResponses: FormResponseItem[];
  botMessages: BotMessage[];
  settings: ProviderSettings;
}
