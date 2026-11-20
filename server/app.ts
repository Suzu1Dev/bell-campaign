import express, { type NextFunction, type Request, type Response } from "express";
import compression from "compression";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AI_PROVIDERS,
  APPLICANT_ROLES,
  APPLICANT_STATUSES,
  CELL_STAGES,
  FILE_CATEGORIES,
  HANDBOOK_TEMPLATES,
  PACING_LEVELS,
  PARTNER_KINDS,
  PARTNER_STATUSES,
  PONYTAIL_MODES,
  TEAM_COLORS,
  THINKING_EFFORTS,
  type BotActionProposal,
  type CellStage,
  type MeetingDocSource,
  type TeamColor,
} from "../shared/types.js";
import {
  SAFE_MIME_RE,
  detectDocSourceFromUrl,
  meetingToGoogleDocHtml,
  meetingToHackMd,
  parseMeetingDoc,
} from "../shared/docs.js";
import {
  SUITE_LIMITS,
  SUITE_OBJECT_ID,
  SUITE_UNSAFE_TEXT,
  type SuiteLinks,
  type SuiteManifest,
  type SuiteTodayFeed,
  type SuiteTodayItem,
} from "../shared/suite.js";
import {
  buildGoogleSheetMatrix,
  buildPacingSchedulePreview,
  buildStandaloneShareHtml,
  computeCampaignMetrics,
  matrixToCsvBom,
} from "../shared/sheets.js";
import { buildStandalonePresentationHtml } from "../shared/exporters.js";
import { buildCampaignXlsxBuffer } from "./xlsx.js";
import {
  buildBuiltinHandbook,
  cleanSplitOriginTeamName,
  curateInspirationsWithAI,
  escapeRegExp,
  generateAutoSchedulePreview,
  generateHandbookWithAI,
  replyCampaignBot,
  type JsonPromptRunner,
} from "./ai.js";
import { AppError, publicError } from "./errors.js";
import { securityMiddleware } from "./security.js";
import type { CampaignStore } from "./store.js";

export type SheetCsvFetcher = (sheetId: string, gid: string, signal: AbortSignal) => Promise<string>;

export const defaultSheetCsvFetcher: SheetCsvFetcher = async (sheetId, gid, signal) => {
  const exportUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv&gid=${encodeURIComponent(gid)}`;
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const response = await fetch(exportUrl, { signal: timeout, redirect: "follow" });
  if (!response.ok) {
    throw new AppError(502, `無法讀取此 Google 試算表（HTTP ${response.status}），請確認權限設為「知道連結的任何人可檢視」或改貼上 CSV。`);
  }
  const text = await response.text();
  if (text.length > 1_500_000) {
    throw new AppError(413, "試算表內容超過 1.5MB 上限。");
  }
  if (/<!doctype html>/i.test(text.slice(0, 200))) {
    throw new AppError(422, "此 Google 試算表需要登入權限，請開啟「知道連結的任何人可檢視」或匯出 CSV 貼上。");
  }
  return text;
};

function parseGoogleSpreadsheetUrl(rawUrl: string): { sheetId: string; gid: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new AppError(400, "請輸入有效的 Google 試算表網址。");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "docs.google.com") {
    throw new AppError(400, "僅支援 https://docs.google.com/spreadsheets/d/... 試算表網址。");
  }
  const match = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{10,120})/.exec(parsed.pathname);
  if (!match) {
    throw new AppError(400, "無法從網址識別 Google 試算表 ID。");
  }
  const queryGid = parsed.searchParams.get("gid");
  const hashGid = /gid=(\d{1,16})/.exec(parsed.hash)?.[1];
  const gid = queryGid && /^\d{1,16}$/.test(queryGid) ? queryGid : hashGid || "0";
  return { sheetId: match[1], gid };
}

export type DocFetcher = (docUrl: string, signal: AbortSignal) => Promise<{ text: string; source: MeetingDocSource }>;

function resolveSafeDocExportUrl(rawUrl: string): { fetchUrl: string; source: MeetingDocSource } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new AppError(400, "請輸入有效的 Google 文件或 HackMD 網址。");
  }
  if (parsed.protocol !== "https:") {
    throw new AppError(400, "僅支援 https:// 安全網址。");
  }
  if (parsed.hostname === "docs.google.com") {
    const m = /^\/document\/d\/([A-Za-z0-9_-]{10,120})/.exec(parsed.pathname);
    if (!m) throw new AppError(400, "無法從網址識別 Google 文件 ID。");
    return {
      fetchUrl: `https://docs.google.com/document/d/${encodeURIComponent(m[1])}/export?format=txt`,
      source: "gdoc",
    };
  }
  if (parsed.hostname === "hackmd.io") {
    const cleanPath = parsed.pathname.replace(/\/+(edit|view|both|download)?$/i, "");
    if (!cleanPath || cleanPath === "/" || !/^\/(?:@[A-Za-z0-9_.-]+\/[A-Za-z0-9_-]+|[A-Za-z0-9_-]{6,80})$/.test(cleanPath)) {
      throw new AppError(400, "無法識別 HackMD 筆記路徑，請貼上公開筆記網址。");
    }
    return {
      fetchUrl: `https://hackmd.io${cleanPath}/download`,
      source: "hackmd",
    };
  }
  throw new AppError(400, "目前僅支援 docs.google.com（Google 文件）或 hackmd.io 網址直接匯入，其他來源請貼上 Markdown／文字內容。");
}

export const defaultDocFetcher: DocFetcher = async (docUrl, signal) => {
  const { fetchUrl, source } = resolveSafeDocExportUrl(docUrl);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const response = await fetch(fetchUrl, { signal: timeout, redirect: "follow" });
  if (!response.ok) {
    throw new AppError(502, `無法讀取雲端文件（HTTP ${response.status}），請確認 Google 文件／HackMD 設為「知道連結的任何人可檢視」或直接貼上內容。`);
  }
  const text = await response.text();
  if (text.length > 1_000_000) {
    throw new AppError(413, "文件內容超過 1MB 上限。");
  }
  if (/<!doctype html>/i.test(text.slice(0, 200)) && /accounts\.google\.com|hackmd\.io\/login/i.test(text.slice(0, 4000))) {
    throw new AppError(422, "此雲端文件需要登入權限，請開啟公開檢視權限或直接複製貼上內容。");
  }
  return { text, source };
};

export interface CreateAppOptions {
  store: CampaignStore;
  allowedOrigins?: string[];
  suiteLinks?: SuiteLinks;
  aiRunner?: JsonPromptRunner;
  sheetCsvFetcher?: SheetCsvFetcher;
  docFetcher?: DocFetcher;
  distDir?: string;
}

const settingsPatchSchema = z
  .object({
    provider: z.enum(AI_PROVIDERS).optional(),
    model: z.string().max(160).optional(),
    ponytailMode: z.enum(PONYTAIL_MODES).optional(),
    thinkingEffort: z.enum(THINKING_EFFORTS).optional(),
    botAutoApply: z.boolean().optional(),
  })
  .strict();

const createCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    subtitle: z.string().trim().max(120).optional(),
    brief: z.string().trim().max(1000).optional(),
    eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    prepWeeks: z.number().int().min(1).max(52).optional(),
    postWeeks: z.number().int().min(0).max(8).optional(),
    dateTentative: z.boolean().optional(),
    tentativeNote: z.string().trim().max(80).optional(),
  })
  .strict();

const patchCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    subtitle: z.string().trim().max(140).optional(),
    brief: z.string().max(1000).optional(),
    eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dateTentative: z.boolean().optional(),
    tentativeNote: z.string().trim().max(80).optional(),
    pacing: z.enum(PACING_LEVELS).optional(),
    mainGoal: z.string().max(1000).optional(),
    monthlyGoals: z
      .array(z.object({ month: z.string().trim().min(1).max(24), goal: z.string().trim().max(200) }).strict())
      .max(12)
      .optional(),
    sheetUrl: z.string().max(500).optional(),
    slidesUrl: z.string().max(500).optional(),
    cascadeRename: z.boolean().optional(),
  })
  .strict();

const rescheduleTimelineSchema = z
  .object({
    eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    prepWeeks: z.number().int().min(1).max(52).optional(),
    postWeeks: z.number().int().min(0).max(8).optional(),
    dateTentative: z.boolean().optional(),
    tentativeNote: z.string().trim().max(80).optional(),
  })
  .strict();

const createWeekSchema = z
  .object({
    monthLabel: z.string().trim().min(1).max(20),
    dateRange: z.string().trim().min(1).max(32),
    countdownLabel: z.string().trim().min(1).max(32),
    phase: z.enum(["prep", "event", "post"]),
    stage: z.enum(CELL_STAGES).optional(),
  })
  .strict();

const patchWeekSchema = z
  .object({
    monthLabel: z.string().trim().min(1).max(20).optional(),
    dateRange: z.string().trim().min(1).max(32).optional(),
    countdownLabel: z.string().trim().min(1).max(32).optional(),
    phase: z.enum(["prep", "event", "post"]).optional(),
    stage: z.enum(CELL_STAGES).optional(),
    majorEvents: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(64),
            title: z.string().trim().min(1).max(120),
            kind: z.enum(["milestone", "conflict"]),
            dateLabel: z.string().trim().max(24).optional(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
    memo: z.string().max(300).optional(),
    progressOverride: z.number().min(0).max(100).nullable().optional(),
  })
  .strict();

const createTeamSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    lead: z.string().trim().max(40).optional(),
    color: z.enum(TEAM_COLORS).optional(),
    targetHeadcount: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const patchTeamSchema = createTeamSchema.partial();

const upsertCellSchema = z
  .object({
    weekId: z.string().trim().min(1),
    teamId: z.string().trim().min(1),
    stage: z.enum(CELL_STAGES),
    weeklyFocus: z.string().max(200),
    crossTeam: z.string().max(240),
  })
  .strict();

const createTodoSchema = z
  .object({
    teamId: z.string().trim().min(1),
    weekId: z.string().trim().nullable().optional(),
    title: z.string().trim().min(1).max(160),
    assignee: z.string().trim().max(40).optional(),
    priority: z.enum(["normal", "high"]).optional(),
    dueDate: z.string().max(24).optional(),
  })
  .strict();

const patchTodoSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    done: z.boolean().optional(),
    teamId: z.string().trim().min(1).optional(),
    weekId: z.string().trim().nullable().optional(),
    assignee: z.string().trim().max(40).optional(),
    priority: z.enum(["normal", "high"]).optional(),
    dueDate: z.string().max(24).optional(),
  })
  .strict();

const saveNoteSchema = z
  .object({
    id: z.string().trim().optional(),
    title: z.string().trim().min(1).max(120),
    body: z.string().max(20_000),
    tags: z.array(z.string().trim().max(24)).max(8).optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

const uploadFileSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    category: z.enum(FILE_CATEGORIES),
    teamId: z.string().trim().nullable().optional(),
    fileName: z.string().trim().min(1).max(140),
    mimeType: z.string().trim().min(1).max(100).regex(SAFE_MIME_RE),
    dataBase64: z.string().min(1).max(11_500_000),
  })
  .strict();

const saveDocSchema = z
  .object({
    id: z.string().trim().optional(),
    title: z.string().trim().min(1).max(120),
    category: z.enum(FILE_CATEGORIES).optional(),
    teamId: z.string().trim().nullable().optional(),
    contentMd: z.string().trim().min(1).max(80_000),
    templateKind: z.enum(HANDBOOK_TEMPLATES).nullable().optional(),
  })
  .strict();

const generateHandbookSchema = z
  .object({
    template: z.enum(HANDBOOK_TEMPLATES),
    teamId: z.string().trim().nullable().optional(),
    recipientName: z.string().max(60).optional(),
    sessionTitle: z.string().max(120).optional(),
    sessionTime: z.string().max(80).optional(),
    venue: z.string().max(120).optional(),
    extraNotes: z.string().max(1000).optional(),
    saveToArchive: z.boolean().optional(),
  })
  .strict();

const saveMeetingSchema = z
  .object({
    id: z.string().trim().optional(),
    title: z.string().trim().min(1).max(120),
    meetingDate: z.string().trim().min(1).max(40),
    attendees: z.string().max(300),
    agenda: z.string().max(6000),
    arrangements: z.string().max(6000),
    precautions: z.string().max(6000),
    decisions: z.string().max(6000),
    docUrl: z.string().max(500).optional(),
    docSource: z.enum(["", "gdoc", "hackmd", "markdown"]).optional(),
  })
  .strict();

const importMeetingDocSchema = z
  .object({
    meetingId: z.string().trim().optional(),
    docUrl: z.string().max(500).optional(),
    rawContent: z.string().max(500_000).optional(),
  })
  .strict();

const tempStaffTaskSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(160),
    done: z.boolean(),
  })
  .strict();

const savePartnerSchema = z
  .object({
    id: z.string().trim().optional(),
    kind: z.enum(PARTNER_KINDS),
    name: z.string().trim().min(1).max(80),
    organization: z.string().max(120).optional(),
    roleOrTopic: z.string().max(240).optional(),
    contact: z.string().max(160).optional(),
    teamId: z.string().trim().nullable().optional(),
    status: z.enum(PARTNER_STATUSES).optional(),
    shiftOrFee: z.string().max(160).optional(),
    notes: z.string().max(2000).optional(),
    tasks: z.array(tempStaffTaskSchema).max(30).optional(),
  })
  .strict();

const patchPartnerSchema = z
  .object({
    status: z.enum(PARTNER_STATUSES).optional(),
    teamId: z.string().trim().nullable().optional(),
    notes: z.string().max(2000).optional(),
    tasks: z.array(tempStaffTaskSchema).max(30).optional(),
  })
  .strict();

const patchFormSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    sourceUrl: z.string().max(500).optional(),
    sheetSyncUrl: z.string().max(500).optional(),
    status: z.enum(["open", "closed"]).optional(),
    description: z.string().max(500).optional(),
  })
  .strict();

const createFormResponseSchema = z
  .object({
    applicantName: z.string().trim().min(1).max(60),
    email: z.string().max(120).optional(),
    handle: z.string().max(60).optional(),
    preferredTeamId: z.string().trim().min(1),
    secondaryTeamId: z.string().trim().nullable().optional(),
    roleType: z.enum(APPLICANT_ROLES).optional(),
    skills: z.array(z.string().trim().max(32)).max(10).optional(),
    availability: z.array(z.string().trim().max(32)).max(10).optional(),
    experience: z.string().max(2000).optional(),
    dietaryOrShirt: z.string().max(80).optional(),
  })
  .strict();

const patchFormResponseSchema = z
  .object({
    status: z.enum(APPLICANT_STATUSES).optional(),
    preferredTeamId: z.string().trim().min(1).optional(),
    reviewerNote: z.string().max(500).optional(),
  })
  .strict();

const autoSchedulePreviewSchema = z
  .object({
    mainGoal: z.string().max(1000),
    monthlyGoals: z
      .array(z.object({ month: z.string().trim().min(1).max(24), goal: z.string().trim().max(200) }).strict())
      .max(12),
    tasksText: z.string().max(6000),
    pacing: z.enum(PACING_LEVELS),
  })
  .strict();

const autoScheduleApplySchema = z
  .object({
    pacing: z.enum(PACING_LEVELS),
    mainGoal: z.string().max(1000).optional(),
    monthlyGoals: z
      .array(z.object({ month: z.string().trim().min(1).max(24), goal: z.string().trim().max(200) }).strict())
      .max(12)
      .optional(),
    preview: z
      .object({
        weekStages: z
          .array(
            z
              .object({
                weekId: z.string().min(1),
                stage: z.enum(CELL_STAGES),
              })
              .strict(),
          )
          .optional(),
        cells: z.array(
          z
            .object({
              weekId: z.string().min(1),
              teamId: z.string().min(1),
              stage: z.enum(CELL_STAGES),
              weeklyFocus: z.string().max(200),
              crossTeam: z.string().max(240).optional(),
            })
            .strict(),
        ),
        todos: z.array(
          z
            .object({
              teamId: z.string().min(1),
              weekId: z.string().min(1),
              title: z.string().min(1).max(160),
              priority: z.enum(["normal", "high"]),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

const importSheetSchema = z
  .object({
    sheetUrl: z.string().max(500).optional(),
    csvText: z.string().max(1_500_000).optional(),
  })
  .strict();

const botChatSchema = z
  .object({
    message: z.string().trim().min(1).max(2000),
  })
  .strict();

const botApplySchema = z
  .object({
    messageId: z.string().trim().min(1),
    proposalId: z.string().trim().min(1),
  })
  .strict();

export function createApp(options: CreateAppOptions) {
  const {
    store,
    allowedOrigins = [],
    suiteLinks = {},
    aiRunner,
    sheetCsvFetcher = defaultSheetCsvFetcher,
    docFetcher = defaultDocFetcher,
    distDir = fileURLToPath(new URL("../dist", import.meta.url)),
  } = options;

  const app = express();
  app.disable("x-powered-by");
  app.use(compression());
  app.use(securityMiddleware(allowedOrigins));
  app.use(express.json({ limit: "12mb" }));

  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // ── BELL Suite Contract Endpoints ────────────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", appId: "campaign" });
  });

  app.get("/api/suite/manifest", (_req, res) => {
    const manifest: SuiteManifest = {
      schemaVersion: 1,
      appId: "campaign",
      displayName: "BELL Campaign",
      summary: "活動專案時程與團隊協作",
      capabilities: [
        {
          id: "campaign.draft",
          kind: "accept-handoff",
          route: "#/tasks",
          accepts: ["text"],
          maxChars: SUITE_LIMITS.handoffText,
        },
        {
          id: "campaign.today",
          kind: "today-feed",
          api: "/api/suite/today",
        },
        {
          id: "campaign.schedule",
          kind: "object-route",
          route: "#/schedule",
        },
      ],
      links: suiteLinks,
    };
    res.json(manifest);
  });

  app.get("/api/suite/today", (_req, res) => {
    const snap = store.getSnapshot();
    const metrics = computeCampaignMetrics(snap);
    const openTodos = snap.todos.filter(
      (t) => !t.done && SUITE_OBJECT_ID.test(t.id) && !SUITE_UNSAFE_TEXT.test(t.title),
    );
    const pendingForms = snap.formResponses.filter((r) => r.status === "pending").length;

    const items: SuiteTodayItem[] = openTodos.slice(0, SUITE_LIMITS.items).map((t) => {
      const teamName = snap.teams.find((tm) => tm.id === t.teamId)?.name ?? "籌備組";
      const detail = `${snap.campaign.name} · ${teamName}`
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
        .slice(0, SUITE_LIMITS.detail);
      return {
        sourceApp: "campaign",
        type: "todo",
        id: t.id,
        title: [...t.title].slice(0, SUITE_LIMITS.title).join(""),
        href: "#/tasks",
        state: t.priority === "high" ? "due" : "needs-you",
        updatedAt: t.updatedAt,
        ...(t.dueDate ? { dueAt: `${t.dueDate}T09:00:00.000Z` } : {}),
        detail,
      };
    });

    const feed: SuiteTodayFeed = {
      schemaVersion: 1,
      appId: "campaign",
      generatedAt: new Date().toISOString(),
      counts: {
        progressPercent: metrics.overallPercent,
        openTodos: openTodos.length,
        pendingApplicants: pendingForms,
        conflicts: metrics.conflictWeekCount,
      },
      items,
      truncated: openTodos.length > SUITE_LIMITS.items,
    };
    res.json(feed);
  });

  // ── Settings & Workspace Snapshot ────────────────────────────────────────
  app.patch("/api/settings", (req, res) => {
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "設定格式不正確。");
    res.json(store.saveSettings(parsed.data));
  });

  app.get("/api/snapshot", (req, res) => {
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.json(store.getSnapshot(campaignId));
  });

  app.post("/api/campaigns", (req, res) => {
    const parsed = createCampaignSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請輸入活動名稱與有效日期（YYYY-MM-DD）。");
    res.status(201).json(store.createCampaign(parsed.data));
  });

  app.patch("/api/campaigns/:id", (req, res) => {
    const parsed = patchCampaignSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "活動設定欄位格式不正確。");
    store.updateCampaignMeta(req.params.id, parsed.data);
    res.json(store.getSnapshot(req.params.id));
  });

  app.post("/api/campaigns/:id/timeline", (req, res) => {
    const parsed = rescheduleTimelineSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "時程區間設定格式不正確（支援 1–52 週會前倒數）。");
    res.json(store.rescheduleCampaignTimeline(req.params.id, parsed.data));
  });

  // ── Schedule Matrix & Google Sheet / Slides Interop ──────────────────────
  app.post("/api/campaigns/:id/weeks", (req, res) => {
    const parsed = createWeekSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請輸入有效的月份、日期區間與倒數週標記。");
    store.addWeek(req.params.id, parsed.data);
    res.status(201).json(store.getSnapshot(req.params.id));
  });

  app.patch("/api/weeks/:weekId", (req, res) => {
    const parsed = patchWeekSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "週次資料格式不正確。");
    store.updateWeek(req.params.weekId, parsed.data);
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.json(store.getSnapshot(campaignId));
  });

  app.post("/api/campaigns/:id/teams", (req, res) => {
    const parsed = createTeamSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請輸入有效的組別名稱。");
    store.addTeam(req.params.id, parsed.data);
    res.status(201).json(store.getSnapshot(req.params.id));
  });

  app.patch("/api/teams/:teamId", (req, res) => {
    const parsed = patchTeamSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "組別更新格式不正確。");
    store.updateTeam(req.params.teamId, parsed.data);
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.json(store.getSnapshot(campaignId));
  });

  app.delete("/api/teams/:teamId", (req, res) => {
    store.deleteTeam(req.params.teamId);
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.json(store.getSnapshot(campaignId));
  });

  app.put("/api/cells", (req, res) => {
    const parsed = upsertCellSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "時程儲存格格式不正確。");
    store.upsertCell(parsed.data);
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.json(store.getSnapshot(campaignId));
  });

  app.post("/api/campaigns/:id/import-sheet", async (req, res) => {
    const parsed = importSheetSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請提供 Google 試算表網址或 CSV 內容。");

    let csvText = (parsed.data.csvText ?? "").trim();
    const sheetUrl = (parsed.data.sheetUrl ?? "").trim();
    if (!csvText && !sheetUrl) {
      throw new AppError(400, "請輸入公開 Google 試算表網址或貼上 CSV。");
    }

    if (!csvText && sheetUrl) {
      const { sheetId, gid } = parseGoogleSpreadsheetUrl(sheetUrl);
      const controller = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on("close", onClose);
      try {
        csvText = await sheetCsvFetcher(sheetId, gid, controller.signal);
      } finally {
        res.off("close", onClose);
      }
    }

    try {
      const snapshot = store.importScheduleFromSheetCsv(req.params.id, csvText, sheetUrl || undefined);
      res.json(snapshot);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(422, err instanceof Error ? err.message : "無法解析試算表內容。");
    }
  });

  app.get("/api/campaigns/:id/export.xlsx", (req, res) => {
    const snap = store.getSnapshot(req.params.id);
    const xlsxBuf = buildCampaignXlsxBuffer(snap);
    const safeSlug = snap.campaign.name.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 36) || snap.campaign.id;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="bell-campaign-${snap.campaign.id}.xlsx"; filename*=UTF-8''${encodeURIComponent(`${safeSlug}-時程規劃表.xlsx`)}`,
    );
    res.send(xlsxBuf);
  });

  app.get("/api/campaigns/:id/export.csv", (req, res) => {
    const snap = store.getSnapshot(req.params.id);
    const csv = matrixToCsvBom(buildGoogleSheetMatrix(snap));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="bell-campaign-${snap.campaign.id}.csv"`);
    res.send(csv);
  });

  app.get("/api/campaigns/:id/export-deck.html", (req, res) => {
    const snap = store.getSnapshot(req.params.id);
    const theme = req.query.theme === "dark" ? "dark" : "light";
    const html = buildStandalonePresentationHtml(snap, theme);
    const safeSlug = snap.campaign.name.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 36) || snap.campaign.id;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="bell-campaign-${snap.campaign.id}-deck.html"; filename*=UTF-8''${encodeURIComponent(`${safeSlug}-專案簡報.html`)}`,
    );
    res.send(html);
  });

  app.get("/api/campaigns/:id/export.html", (req, res) => {
    const snap = store.getSnapshot(req.params.id);
    const html = buildStandaloneShareHtml(snap);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="bell-campaign-${snap.campaign.id}-share.html"`);
    res.send(html);
  });

  // ── AI Auto-Schedule & Pacing ────────────────────────────────────────────
  app.post("/api/campaigns/:id/auto-schedule/preview", async (req, res) => {
    const parsed = autoSchedulePreviewSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "自動排程輸入格式不正確。");
    const snap = store.getSnapshot(req.params.id);
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", onClose);
    try {
      const preview = await generateAutoSchedulePreview(snap, parsed.data, snap.settings, controller.signal, aiRunner);
      res.json(preview);
    } finally {
      res.off("close", onClose);
    }
  });

  app.post("/api/campaigns/:id/auto-schedule/apply", (req, res) => {
    const parsed = autoScheduleApplySchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "套用排程內容格式不正確。");
    res.json(store.applyAutoSchedule(req.params.id, parsed.data));
  });

  // ── Todos ────────────────────────────────────────────────────────────────
  app.post("/api/campaigns/:id/todos", (req, res) => {
    const parsed = createTodoSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請輸入待辦事項標題並選擇組別。");
    store.addTodo(req.params.id, parsed.data);
    res.status(201).json(store.getSnapshot(req.params.id));
  });

  app.patch("/api/todos/:todoId", (req, res) => {
    const parsed = patchTodoSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "待辦事項更新格式不正確。");
    store.updateTodo(req.params.todoId, parsed.data);
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.json(store.getSnapshot(campaignId));
  });

  app.delete("/api/todos/:todoId", (req, res) => {
    store.deleteTodo(req.params.todoId);
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.json(store.getSnapshot(campaignId));
  });

  // ── Personal Notes ───────────────────────────────────────────────────────
  app.post("/api/campaigns/:id/notes", (req, res) => {
    const parsed = saveNoteSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請輸入筆記標題與內容。");
    store.saveNote(req.params.id, parsed.data);
    res.status(201).json(store.getSnapshot(req.params.id));
  });

  app.delete("/api/notes/:noteId", (req, res) => {
    store.deleteNote(req.params.noteId);
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.json(store.getSnapshot(campaignId));
  });

  // ── Files Archive & AI Handbook Generation ───────────────────────────────
  app.post("/api/campaigns/:id/files/upload", (req, res) => {
    const parsed = uploadFileSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "檔案上傳格式不正確或超過 8MB 限制。");
    const rawBase64 = parsed.data.dataBase64.replace(/^data:[^;]+;base64,/, "");
    const bytes = Buffer.from(rawBase64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) {
      throw new AppError(413, "單一歸檔檔案大小須介於 1B 至 8MB 之間。");
    }
    store.createUploadedFile(req.params.id, {
      title: parsed.data.title,
      category: parsed.data.category,
      teamId: parsed.data.teamId,
      fileName: parsed.data.fileName,
      mimeType: parsed.data.mimeType,
      bytes,
    });
    res.status(201).json(store.getSnapshot(req.params.id));
  });

  app.post("/api/campaigns/:id/files/doc", (req, res) => {
    const parsed = saveDocSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "文件標題或內文格式不正確。");
    store.saveGeneratedDoc(req.params.id, parsed.data);
    res.status(201).json(store.getSnapshot(req.params.id));
  });

  app.post("/api/campaigns/:id/files/generate-handbook", async (req, res) => {
    const parsed = generateHandbookSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "行前手冊生成參數不正確。");
    const snap = store.getSnapshot(req.params.id);
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", onClose);
    try {
      const generated = await generateHandbookWithAI(snap, parsed.data, snap.settings, controller.signal, aiRunner);
      let createdFile = null;
      if (parsed.data.saveToArchive !== false) {
        createdFile = store.saveGeneratedDoc(req.params.id, {
          title: generated.title,
          category: "handbook",
          teamId: parsed.data.teamId ?? null,
          contentMd: generated.contentMd,
          templateKind: parsed.data.template,
        });
      }
      res.status(201).json({
        generated,
        file: createdFile,
        snapshot: store.getSnapshot(req.params.id),
      });
    } finally {
      res.off("close", onClose);
    }
  });

  app.get("/api/files/:fileId/raw", (req, res) => {
    const raw = store.getRawFileBytes(req.params.fileId);
    const isPdf = raw.mimeType === "application/pdf" || /\.pdf$/i.test(raw.fileName);
    res.setHeader("Content-Type", isPdf ? "application/pdf" : raw.mimeType);
    if (req.query.download === "1") {
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox");
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(raw.fileName)}"`);
    } else if (isPdf && req.query.inline === "1") {
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(raw.fileName)}"`);
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      res.setHeader("Content-Security-Policy", "default-src 'self'; object-src 'self'; frame-ancestors 'self'");
    } else {
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox");
    }
    res.send(raw.bytes);
  });

  app.delete("/api/files/:fileId", (req, res) => {
    store.deleteFile(req.params.fileId);
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.json(store.getSnapshot(campaignId));
  });

  // ── Meetings & Bidirectional Google Docs / HackMD Sync ───────────────────
  app.post("/api/campaigns/:id/meetings", (req, res) => {
    const parsed = saveMeetingSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請輸入會議名稱與時間。");
    store.saveMeeting(req.params.id, parsed.data);
    res.status(201).json(store.getSnapshot(req.params.id));
  });

  app.post("/api/campaigns/:id/meetings/import-doc", async (req, res) => {
    const parsed = importMeetingDocSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "匯入文件參數格式不正確。");

    const docUrl = (parsed.data.docUrl ?? "").trim();
    let rawContent = (parsed.data.rawContent ?? "").trim();
    let docSource: MeetingDocSource = detectDocSourceFromUrl(docUrl);

    if (!rawContent && !docUrl) {
      throw new AppError(400, "請貼上 Google 文件／HackMD 網址，或貼上文件內容。");
    }

    if (!rawContent && docUrl) {
      const controller = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on("close", onClose);
      try {
        const fetched = await docFetcher(docUrl, controller.signal);
        rawContent = fetched.text;
        docSource = fetched.source;
      } finally {
        res.off("close", onClose);
      }
    }

    const fields = parseMeetingDoc(rawContent);
    const saved = store.saveMeeting(req.params.id, {
      ...(parsed.data.meetingId ? { id: parsed.data.meetingId } : {}),
      ...fields,
      ...(docUrl ? { docUrl, docSource } : { docSource: docSource || "markdown" }),
    });

    res.status(201).json({
      meeting: saved,
      snapshot: store.getSnapshot(req.params.id),
    });
  });

  app.get("/api/meetings/:meetingId/export", (req, res) => {
    const format = req.query.format === "doc" ? "doc" : "md";
    const { meeting, campaignName } = store.getMeetingById(req.params.meetingId);
    const safeSlug = meeting.title.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || "meeting";
    if (format === "doc") {
      const html = meetingToGoogleDocHtml(meeting, campaignName);
      res.setHeader("Content-Type", "application/msword; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(safeSlug)}.doc"`);
      res.send(html);
      return;
    }
    const md = meetingToHackMd(meeting, campaignName);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(safeSlug)}.md"`);
    res.send(md);
  });

  app.delete("/api/meetings/:meetingId", (req, res) => {
    store.deleteMeeting(req.params.meetingId);
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.json(store.getSnapshot(campaignId));
  });

  // ── Partners (`#/partners`: 講者 · 合作廠商 · 臨時工) ─────────────────────
  app.post("/api/campaigns/:id/partners", (req, res) => {
    const parsed = savePartnerSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請輸入合作對象姓名／名稱與分類。");
    store.savePartner(req.params.id, parsed.data);
    res.status(201).json(store.getSnapshot(req.params.id));
  });

  app.patch("/api/partners/:partnerId", (req, res) => {
    const parsed = patchPartnerSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "合作對象狀態更新格式不正確。");
    store.patchPartner(req.params.partnerId, parsed.data);
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.json(store.getSnapshot(campaignId));
  });

  app.delete("/api/partners/:partnerId", (req, res) => {
    store.deletePartner(req.params.partnerId);
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.json(store.getSnapshot(campaignId));
  });

  // ── Inspirations (`#/inspirations`: 靈感借鏡) ────────────────────────────
  app.post("/api/campaigns/:id/inspirations/curate", async (req, res) => {
    const body = z
      .object({
        brief: z.string().max(1000).optional(),
        focusHint: z.string().max(300).optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!body.success) throw new AppError(400, "靈感策展條件格式不正確。");

    if (body.data.brief !== undefined) {
      store.updateCampaignMeta(req.params.id, { brief: body.data.brief });
    }
    const snap = store.getSnapshot(req.params.id);
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", onClose);
    try {
      const curated = await curateInspirationsWithAI(
        snap,
        body.data.focusHint ?? "",
        snap.settings,
        controller.signal,
        aiRunner,
      );
      store.replaceInspirations(req.params.id, curated);
      res.json(store.getSnapshot(req.params.id));
    } finally {
      res.off("close", onClose);
    }
  });

  app.delete("/api/inspirations/:inspirationId", (req, res) => {
    store.deleteInspiration(req.params.inspirationId);
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.json(store.getSnapshot(campaignId));
  });

  // ── Recruitment Forms (`#/forms`) ────────────────────────────────────────
  app.patch("/api/forms/:formId", (req, res) => {
    const parsed = patchFormSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "表單資訊格式不正確。");
    store.updateFormMeta(req.params.formId, parsed.data);
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.json(store.getSnapshot(campaignId));
  });

  app.post("/api/forms/:formId/responses", (req, res) => {
    const parsed = createFormResponseSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請輸入應徵者姓名與志願組別。");
    store.addFormResponse(req.params.formId, parsed.data);
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.status(201).json(store.getSnapshot(campaignId));
  });

  app.patch("/api/form-responses/:responseId", (req, res) => {
    const parsed = patchFormResponseSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "審核狀態更新格式不正確。");
    store.updateFormResponse(req.params.responseId, parsed.data);
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.json(store.getSnapshot(campaignId));
  });

  app.post("/api/campaigns/:id/forms/:formId/import-csv", (req, res) => {
    const body = z.object({ csvText: z.string().min(1).max(1_000_000) }).strict().safeParse(req.body);
    if (!body.success) throw new AppError(400, "請貼上有效的招工表單回覆 CSV 內容。");
    const importedCount = store.importFormResponsesCsv(req.params.id, req.params.formId, body.data.csvText);
    res.json({ importedCount, snapshot: store.getSnapshot(req.params.id) });
  });

  app.post("/api/campaigns/:id/forms/:formId/sync-sheet", async (req, res) => {
    const body = z
      .object({ sheetSyncUrl: z.string().max(500).optional() })
      .strict()
      .safeParse(req.body);
    if (!body.success) throw new AppError(400, "試算表連結格式不正確。");

    const snap = store.getSnapshot(req.params.id);
    const targetForm = snap.forms.find((f) => f.id === req.params.formId);
    if (!targetForm) throw new AppError(404, "找不到指定的招工表單。");

    const syncUrl = (body.data.sheetSyncUrl ?? targetForm.sheetSyncUrl).trim();
    if (!syncUrl) throw new AppError(400, "請先貼上招工表單連結的 Google 試算表網址。");

    const { sheetId, gid } = parseGoogleSpreadsheetUrl(syncUrl);
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", onClose);
    let csvText = "";
    try {
      csvText = await sheetCsvFetcher(sheetId, gid, controller.signal);
    } finally {
      res.off("close", onClose);
    }

    const importedCount = store.importFormResponsesCsv(req.params.id, req.params.formId, csvText);
    store.updateFormMeta(req.params.formId, {
      sheetSyncUrl: syncUrl,
      lastSyncedAt: new Date().toISOString(),
    });
    res.json({ importedCount, snapshot: store.getSnapshot(req.params.id) });
  });

  // ── Campaign Bot (`#/bot`) ───────────────────────────────────────────────
  const DESTRUCTIVE_BOT_KINDS = new Set(["delete_team", "delete_todo"]);

  function resolveBotTeam(
    snap: ReturnType<CampaignStore["getSnapshot"]>,
    teamIdRaw: unknown,
    teamNameRaw: unknown,
  ) {
    const idStr = typeof teamIdRaw === "string" ? teamIdRaw.trim() : "";
    if (idStr) {
      const byId = snap.teams.find((t) => t.id === idStr);
      if (byId) return byId;
    }
    const nameStr = typeof teamNameRaw === "string" ? teamNameRaw.trim() : "";
    if (nameStr) {
      return (
        snap.teams.find((t) => t.name === nameStr) ??
        snap.teams.find((t) => t.name.includes(nameStr) || nameStr.includes(t.name))
      );
    }
    return undefined;
  }

  function resolveBotWeek(
    snap: ReturnType<CampaignStore["getSnapshot"]>,
    weekIdRaw: unknown,
    countdownRaw?: unknown,
  ) {
    const idStr = typeof weekIdRaw === "string" ? weekIdRaw.trim() : "";
    if (idStr) {
      const byId = snap.weeks.find((w) => w.id === idStr);
      if (byId) return byId;
    }
    const cdStr = typeof countdownRaw === "string" ? countdownRaw.trim() : "";
    if (cdStr) {
      return snap.weeks.find((w) => w.countdownLabel === cdStr || w.dateRange.includes(cdStr));
    }
    return undefined;
  }

  function executeBotProposal(campaignId: string, proposal: BotActionProposal): void {
    const snap = store.getSnapshot(campaignId);
    const p = proposal.payload;

    if (proposal.kind === "setup_project_brief" || proposal.kind === "update_campaign") {
      const nextName = typeof p.name === "string" && p.name.trim() ? p.name.trim() : undefined;
      const brief = typeof p.brief === "string" && p.brief.trim() ? p.brief.trim() : undefined;
      const mainGoal =
        typeof p.mainGoal === "string" && p.mainGoal.trim()
          ? p.mainGoal.trim()
          : proposal.kind === "setup_project_brief" && brief
            ? brief
            : undefined;
      store.updateCampaignMeta(campaignId, {
        ...(nextName ? { name: nextName, cascadeRename: p.cascadeRename !== false } : {}),
        ...(typeof p.subtitle === "string" ? { subtitle: p.subtitle.trim() } : {}),
        ...(brief !== undefined ? { brief } : {}),
        ...(mainGoal !== undefined ? { mainGoal } : {}),
        ...(typeof p.eventDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.eventDate) ? { eventDate: p.eventDate } : {}),
        ...(typeof p.dateTentative === "boolean" ? { dateTentative: p.dateTentative } : {}),
        ...(typeof p.tentativeNote === "string" ? { tentativeNote: p.tentativeNote } : {}),
      });
      if (brief) {
        const updatedSnap = store.getSnapshot(campaignId);
        store.seedInspirationsForCampaign(campaignId, {
          name: updatedSnap.campaign.name,
          subtitle: updatedSnap.campaign.subtitle,
          brief: updatedSnap.campaign.brief,
          mainGoal: updatedSnap.campaign.mainGoal,
          teamNames: updatedSnap.teams.map((t) => t.name),
        });
      }
    } else if (proposal.kind === "reschedule_timeline") {
      store.rescheduleCampaignTimeline(campaignId, {
        ...(typeof p.eventDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.eventDate) ? { eventDate: p.eventDate } : {}),
        ...(typeof p.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.startDate) ? { startDate: p.startDate } : {}),
        ...(typeof p.prepWeeks === "number" ? { prepWeeks: Math.max(1, Math.min(52, Math.round(p.prepWeeks))) } : {}),
        ...(typeof p.postWeeks === "number" ? { postWeeks: Math.max(0, Math.min(8, Math.round(p.postWeeks))) } : {}),
        ...(typeof p.dateTentative === "boolean" ? { dateTentative: p.dateTentative } : {}),
        ...(typeof p.tentativeNote === "string" ? { tentativeNote: p.tentativeNote } : {}),
      });
    } else if (proposal.kind === "create_team") {
      const name = String(p.name ?? "").trim();
      if (name && !snap.teams.some((t) => t.name === name)) {
        const color = (TEAM_COLORS as readonly string[]).includes(String(p.color))
          ? (String(p.color) as TeamColor)
          : undefined;
        store.addTeam(campaignId, {
          name,
          lead: typeof p.lead === "string" ? p.lead : "",
          color,
          targetHeadcount: typeof p.targetHeadcount === "number" ? p.targetHeadcount : 4,
        });
      }
    } else if (proposal.kind === "update_team") {
      const target = resolveBotTeam(snap, p.teamId, p.teamName);
      if (target) {
        const color = (TEAM_COLORS as readonly string[]).includes(String(p.color))
          ? (String(p.color) as TeamColor)
          : undefined;
        store.updateTeam(target.id, {
          ...(typeof p.name === "string" && p.name.trim() ? { name: p.name.trim() } : {}),
          ...(typeof p.lead === "string" ? { lead: p.lead } : {}),
          ...(color ? { color } : {}),
          ...(typeof p.targetHeadcount === "number" ? { targetHeadcount: p.targetHeadcount } : {}),
        });
      }
    } else if (proposal.kind === "split_team") {
      const newTeamName = String(p.newTeamName ?? p.name ?? "").trim();
      if (!newTeamName) return;
      const stem = newTeamName.replace(/組$/, "").trim();
      const fromTeam =
        resolveBotTeam(snap, p.fromTeamId, p.fromTeamName) ??
        snap.teams.find((t) => t.name !== newTeamName && stem && t.name.includes(stem));

      const color = (TEAM_COLORS as readonly string[]).includes(String(p.newColor))
        ? (String(p.newColor) as TeamColor)
        : "sky";
      const existingNew = snap.teams.find((t) => t.name === newTeamName);
      const createdTeam =
        existingNew ??
        store.addTeam(campaignId, {
          name: newTeamName,
          lead: typeof p.newLead === "string" ? p.newLead : "",
          color,
          targetHeadcount: typeof p.newHeadcount === "number" ? p.newHeadcount : 4,
          ...(fromTeam ? { afterTeamId: fromTeam.id } : {}),
        });

      if (fromTeam && fromTeam.id !== createdTeam.id) {
        const escapedStem = escapeRegExp(stem);
        const autoRenamed =
          typeof p.renameFromTo === "string" && p.renameFromTo.trim()
            ? p.renameFromTo.trim()
            : cleanSplitOriginTeamName(fromTeam.name, stem);
        store.updateTeam(fromTeam.id, {
          name: autoRenamed,
          ...(typeof p.fromHeadcount === "number" ? { targetHeadcount: p.fromHeadcount } : {}),
        });

        const explicitIds = new Set(Array.isArray(p.moveTodoIds) ? p.moveTodoIds.map(String) : []);
        const rawKw =
          typeof p.moveKeyword === "string" && p.moveKeyword.trim()
            ? p.moveKeyword.trim()
            : stem === "轉播"
              ? "轉播|直播|導播|OBS|賽評|16強|8強"
              : escapedStem;
        let kwRegex: RegExp | null = null;
        if (rawKw) {
          try {
            kwRegex = new RegExp(rawKw, "i");
          } catch {
            kwRegex = new RegExp(escapeRegExp(rawKw), "i");
          }
        }
        const movedTodos = snap.todos.filter(
          (td) =>
            explicitIds.has(td.id) ||
            (td.teamId === fromTeam.id && kwRegex !== null && kwRegex.test(td.title)),
        );
        const touchedWeeks = new Set<string>();
        for (const td of movedTodos) {
          store.updateTodo(td.id, { teamId: createdTeam.id });
          if (td.weekId) touchedWeeks.add(td.weekId);
        }
        for (const wkId of touchedWeeks) {
          const wk = snap.weeks.find((w) => w.id === wkId);
          const wkTodos = movedTodos.filter((t) => t.weekId === wkId);
          const srcCell = snap.cells.find((c) => c.weekId === wkId && c.teamId === fromTeam.id);
          store.upsertCell({
            weekId: wkId,
            teamId: createdTeam.id,
            stage: srcCell?.stage ?? wk?.stage ?? "進度50%",
            weeklyFocus: wkTodos[0]?.title.slice(0, 24) ?? srcCell?.weeklyFocus ?? `${newTeamName}推進`,
            crossTeam: srcCell?.crossTeam ?? "",
          });
        }
        if (kwRegex) {
          for (const pt of snap.partners) {
            if (pt.teamId === fromTeam.id && kwRegex.test(`${pt.roleOrTopic} ${pt.notes}`)) {
              store.patchPartner(pt.id, { teamId: createdTeam.id });
            }
          }
        }
      }
    } else if (proposal.kind === "delete_team") {
      const target = resolveBotTeam(snap, p.teamId, p.teamName);
      if (target && snap.teams.length > 1) {
        store.deleteTeam(target.id);
      }
    } else if (proposal.kind === "add_partner") {
      const kind = (PARTNER_KINDS as readonly string[]).includes(String(p.kind))
        ? (String(p.kind) as typeof PARTNER_KINDS[number])
        : "speaker";
      const targetTeam = resolveBotTeam(snap, p.teamId, p.teamName) ?? snap.teams[0];
      const status = (PARTNER_STATUSES as readonly string[]).includes(String(p.status))
        ? (String(p.status) as typeof PARTNER_STATUSES[number])
        : "contacting";
      store.savePartner(campaignId, {
        kind,
        name: String(p.name || "合作夥伴").trim(),
        organization: String(p.organization ?? ""),
        roleOrTopic: String(p.roleOrTopic ?? ""),
        contact: String(p.contact ?? ""),
        shiftOrFee: String(p.shiftOrFee ?? ""),
        notes: String(p.notes ?? ""),
        teamId: targetTeam?.id ?? null,
        status,
      });
    } else if (proposal.kind === "update_partner") {
      const idStr = typeof p.partnerId === "string" ? p.partnerId.trim() : "";
      const nameStr = typeof p.matchName === "string" ? p.matchName.trim() : typeof p.name === "string" ? p.name.trim() : "";
      const target =
        snap.partners.find((pt) => pt.id === idStr) ??
        (nameStr ? snap.partners.find((pt) => pt.name.includes(nameStr) || nameStr.includes(pt.name)) : undefined);
      if (target) {
        const status = (PARTNER_STATUSES as readonly string[]).includes(String(p.status))
          ? (String(p.status) as typeof PARTNER_STATUSES[number])
          : target.status;
        const targetTeam = resolveBotTeam(snap, p.teamId, p.teamName);
        store.savePartner(campaignId, {
          id: target.id,
          kind: target.kind,
          name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : target.name,
          organization: typeof p.organization === "string" ? p.organization : target.organization,
          roleOrTopic: typeof p.roleOrTopic === "string" ? p.roleOrTopic : target.roleOrTopic,
          contact: typeof p.contact === "string" ? p.contact : target.contact,
          teamId: targetTeam ? targetTeam.id : target.teamId,
          status,
          shiftOrFee: typeof p.shiftOrFee === "string" ? p.shiftOrFee : target.shiftOrFee,
          notes: typeof p.notes === "string" ? p.notes : target.notes,
          tasks: target.tasks,
        });
      }
    } else if (proposal.kind === "adjust_pacing" || proposal.kind === "auto_schedule") {
      const pacing = (PACING_LEVELS as readonly string[]).includes(String(p.pacing))
        ? (String(p.pacing) as typeof PACING_LEVELS[number])
        : "balanced";
      const preview = buildPacingSchedulePreview(snap, {
        mainGoal: snap.campaign.mainGoal,
        monthlyGoals: snap.campaign.monthlyGoals,
        tasksText: String(p.tasksText ?? ""),
        pacing,
      });
      store.applyAutoSchedule(campaignId, { pacing, preview });
    } else if (proposal.kind === "add_todo") {
      const team = resolveBotTeam(snap, p.teamId, p.teamName) ?? snap.teams[0];
      const week = resolveBotWeek(snap, p.weekId, p.countdownLabel);
      if (team && String(p.title ?? "").trim()) {
        store.addTodo(campaignId, {
          teamId: team.id,
          weekId: week?.id ?? null,
          title: String(p.title).trim(),
          assignee: typeof p.assignee === "string" ? p.assignee : "",
          priority: p.priority === "high" ? "high" : "normal",
          dueDate: typeof p.dueDate === "string" ? p.dueDate : "",
        });
      }
    } else if (proposal.kind === "update_todo") {
      const idStr = typeof p.todoId === "string" ? p.todoId.trim() : "";
      const matchStr = typeof p.matchTitle === "string" ? p.matchTitle.trim() : "";
      const targetTodo =
        snap.todos.find((t) => t.id === idStr) ??
        (matchStr ? snap.todos.find((t) => t.title.includes(matchStr)) : undefined);
      if (targetTodo) {
        const nextTeam = resolveBotTeam(snap, p.teamId, p.teamName);
        const nextWeek = resolveBotWeek(snap, p.weekId, p.countdownLabel);
        store.updateTodo(targetTodo.id, {
          ...(typeof p.title === "string" && p.title.trim() ? { title: p.title.trim() } : {}),
          ...(typeof p.done === "boolean" ? { done: p.done } : {}),
          ...(nextTeam ? { teamId: nextTeam.id } : {}),
          ...(nextWeek ? { weekId: nextWeek.id } : {}),
          ...(typeof p.assignee === "string" ? { assignee: p.assignee } : {}),
          ...(p.priority === "high" || p.priority === "normal" ? { priority: p.priority } : {}),
          ...(typeof p.dueDate === "string" ? { dueDate: p.dueDate } : {}),
        });
      }
    } else if (proposal.kind === "toggle_todo") {
      if (typeof p.todoId === "string" && snap.todos.some((t) => t.id === p.todoId)) {
        store.updateTodo(p.todoId, { done: p.done !== false });
      }
    } else if (proposal.kind === "delete_todo") {
      if (typeof p.todoId === "string") {
        store.deleteTodo(p.todoId);
      }
    } else if (proposal.kind === "upsert_cell") {
      const team = resolveBotTeam(snap, p.teamId, p.teamName) ?? snap.teams[0];
      const week = resolveBotWeek(snap, p.weekId, p.countdownLabel) ?? snap.weeks[0];
      if (team && week) {
        const existing = snap.cells.find((c) => c.weekId === week.id && c.teamId === team.id);
        const stage = (CELL_STAGES as readonly string[]).includes(String(p.stage))
          ? (String(p.stage) as CellStage)
          : existing?.stage ?? week.stage;
        store.upsertCell({
          weekId: week.id,
          teamId: team.id,
          stage,
          weeklyFocus: typeof p.weeklyFocus === "string" ? p.weeklyFocus : existing?.weeklyFocus ?? "",
          crossTeam: typeof p.crossTeam === "string" ? p.crossTeam : existing?.crossTeam ?? "",
        });
      }
    } else if (proposal.kind === "update_week") {
      const targetWeek = resolveBotWeek(snap, p.weekId, p.countdownLabel);
      if (targetWeek) {
        const stage = (CELL_STAGES as readonly string[]).includes(String(p.stage))
          ? (String(p.stage) as CellStage)
          : undefined;
        store.updateWeek(targetWeek.id, {
          ...(stage ? { stage } : {}),
          ...(typeof p.memo === "string" ? { memo: p.memo } : {}),
          ...(typeof p.dateRange === "string" && p.dateRange.trim() ? { dateRange: p.dateRange.trim() } : {}),
          ...(typeof p.progressOverride === "number" || p.progressOverride === null
            ? { progressOverride: p.progressOverride }
            : {}),
        });
      }
    } else if (proposal.kind === "add_week_event") {
      const targetWeek = resolveBotWeek(snap, p.weekId, p.countdownLabel) ?? snap.weeks[0];
      if (targetWeek && String(p.title ?? "").trim()) {
        store.updateWeek(targetWeek.id, {
          majorEvents: [
            ...targetWeek.majorEvents,
            {
              id: `ev-${randomUUID().slice(0, 6)}`,
              title: String(p.title).trim(),
              kind: p.kind === "conflict" ? "conflict" : "milestone",
            },
          ],
        });
      }
    } else if (proposal.kind === "create_meeting" || proposal.kind === "update_meeting") {
      const existingId = typeof p.meetingId === "string" ? p.meetingId.trim() : "";
      const existingMtg = existingId ? snap.meetings.find((m) => m.id === existingId) : undefined;
      store.saveMeeting(campaignId, {
        ...(existingMtg ? { id: existingMtg.id } : {}),
        title: String(p.title || existingMtg?.title || "籌備對齊會議"),
        meetingDate: String(p.meetingDate || existingMtg?.meetingDate || new Date().toISOString().slice(0, 10)),
        attendees: String(p.attendees ?? existingMtg?.attendees ?? "全體組長"),
        agenda: String(p.agenda ?? existingMtg?.agenda ?? ""),
        arrangements: String(p.arrangements ?? existingMtg?.arrangements ?? ""),
        precautions: String(p.precautions ?? existingMtg?.precautions ?? ""),
        decisions: String(p.decisions ?? existingMtg?.decisions ?? ""),
      });
    } else if (proposal.kind === "create_note") {
      store.saveNote(campaignId, {
        title: String(p.title || "快速想法筆記"),
        body: String(p.body || ""),
        tags: Array.isArray(p.tags) ? p.tags.map(String) : ["Bot 紀錄"],
      });
    } else if (proposal.kind === "generate_handbook") {
      const tpl = (HANDBOOK_TEMPLATES as readonly string[]).includes(String(p.template))
        ? (String(p.template) as typeof HANDBOOK_TEMPLATES[number])
        : "staff_lazy_pack";
      const doc = buildBuiltinHandbook(snap, {
        template: tpl,
        recipientName: typeof p.recipientName === "string" ? p.recipientName : undefined,
        venue: typeof p.venue === "string" ? p.venue : undefined,
        extraNotes: typeof p.extraNotes === "string" ? p.extraNotes : undefined,
      });
      store.saveGeneratedDoc(campaignId, {
        title: doc.title,
        category: "handbook",
        contentMd: doc.contentMd,
        templateKind: tpl,
      });
    } else if (proposal.kind === "update_applicant") {
      const respId =
        typeof p.responseId === "string" && snap.formResponses.some((r) => r.id === p.responseId)
          ? p.responseId
          : typeof p.applicantName === "string"
            ? snap.formResponses.find((r) => r.applicantName.includes(String(p.applicantName)))?.id
            : undefined;
      if (respId) {
        const status = (APPLICANT_STATUSES as readonly string[]).includes(String(p.status))
          ? (String(p.status) as typeof APPLICANT_STATUSES[number])
          : "accepted";
        const targetTeam = resolveBotTeam(snap, p.preferredTeamId, p.teamName);
        store.updateFormResponse(respId, {
          status,
          ...(targetTeam ? { preferredTeamId: targetTeam.id } : {}),
          ...(typeof p.reviewerNote === "string" ? { reviewerNote: p.reviewerNote } : {}),
        });
      }
    }
  }

  app.post("/api/campaigns/:id/bot/chat", async (req, res) => {
    const parsed = botChatSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請輸入想請 Campaign Bot 協助的內容。");
    const campaignId = req.params.id;
    const snap = store.getSnapshot(campaignId);
    store.appendBotMessage(campaignId, "user", parsed.data.message);

    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", onClose);
    try {
      const reply = await replyCampaignBot(snap, parsed.data.message, snap.settings, controller.signal, aiRunner);
      const autoExecute = snap.settings.botAutoApply !== false;
      const executedProposals = reply.proposals.map((prop) => {
        if (autoExecute && !DESTRUCTIVE_BOT_KINDS.has(prop.kind)) {
          try {
            executeBotProposal(campaignId, prop);
            return { ...prop, applied: true };
          } catch {
            return prop;
          }
        }
        return prop;
      });
      store.appendBotMessage(campaignId, "assistant", reply.content, executedProposals);
      res.json(store.getSnapshot(campaignId));
    } finally {
      res.off("close", onClose);
    }
  });

  app.post("/api/campaigns/:id/bot/apply", (req, res) => {
    const parsed = botApplySchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "操作建議識別碼格式不正確。");
    const campaignId = req.params.id;
    const { proposal, alreadyApplied } = store.markProposalApplied(parsed.data.messageId, parsed.data.proposalId);
    if (!alreadyApplied) {
      executeBotProposal(campaignId, proposal);
    }
    res.json(store.getSnapshot(campaignId));
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "找不到此 API 路徑。" });
  });

  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get("/{*path}", (_req, res) => {
      res.sendFile(resolve(distDir, "index.html"));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: "JSON 格式不正確。" });
      return;
    }
    const { status, message } = publicError(err);
    res.status(status).json({ error: message });
  });

  return app;
}
