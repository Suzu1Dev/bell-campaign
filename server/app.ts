import express, { type NextFunction, type Request, type Response } from "express";
import compression from "compression";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  AI_PROVIDERS,
  APPLICANT_ROLES,
  APPLICANT_STATUSES,
  CELL_STAGES,
  FILE_CATEGORIES,
  HANDBOOK_TEMPLATES,
  PACING_LEVELS,
  TEAM_COLORS,
} from "../shared/types.js";
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
import {
  buildBuiltinHandbook,
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

export interface CreateAppOptions {
  store: CampaignStore;
  allowedOrigins?: string[];
  suiteLinks?: SuiteLinks;
  aiRunner?: JsonPromptRunner;
  sheetCsvFetcher?: SheetCsvFetcher;
  distDir?: string;
}

const settingsPatchSchema = z
  .object({
    provider: z.enum(AI_PROVIDERS).optional(),
    model: z.string().max(160).optional(),
  })
  .strict();

const createCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    subtitle: z.string().trim().max(120).optional(),
    eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    postWeeks: z.number().int().min(0).max(4).optional(),
  })
  .strict();

const patchCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    subtitle: z.string().trim().max(140).optional(),
    eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    pacing: z.enum(PACING_LEVELS).optional(),
    mainGoal: z.string().max(1000).optional(),
    monthlyGoals: z
      .array(z.object({ month: z.string().trim().min(1).max(24), goal: z.string().trim().max(200) }).strict())
      .max(12)
      .optional(),
    sheetUrl: z.string().max(500).optional(),
    slidesUrl: z.string().max(500).optional(),
  })
  .strict();

const createWeekSchema = z
  .object({
    monthLabel: z.string().trim().min(1).max(20),
    dateRange: z.string().trim().min(1).max(32),
    countdownLabel: z.string().trim().min(1).max(32),
    phase: z.enum(["prep", "event", "post"]),
  })
  .strict();

const patchWeekSchema = z
  .object({
    monthLabel: z.string().trim().min(1).max(20).optional(),
    dateRange: z.string().trim().min(1).max(32).optional(),
    countdownLabel: z.string().trim().min(1).max(32).optional(),
    phase: z.enum(["prep", "event", "post"]).optional(),
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
    mimeType: z.string().trim().min(1).max(100),
    dataBase64: z.string().min(1).max(11_500_000),
  })
  .strict();

const saveDocSchema = z
  .object({
    id: z.string().trim().optional(),
    title: z.string().trim().min(1).max(120),
    category: z.enum(FILE_CATEGORIES).optional(),
    teamId: z.string().trim().nullable().optional(),
    contentMd: z.string().min(1).max(80_000),
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
  })
  .strict();

const patchFormSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    sourceUrl: z.string().max(500).optional(),
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
    distDir = resolve(process.cwd(), "dist"),
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
          route: "#/handoff",
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

  app.get("/api/campaigns/:id/export.csv", (req, res) => {
    const snap = store.getSnapshot(req.params.id);
    const csv = matrixToCsvBom(buildGoogleSheetMatrix(snap));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="bell-campaign-${snap.campaign.id}.csv"`);
    res.send(csv);
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
    res.setHeader("Content-Type", raw.mimeType);
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox");
    if (req.query.download === "1") {
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(raw.fileName)}"`);
    }
    res.send(raw.bytes);
  });

  app.delete("/api/files/:fileId", (req, res) => {
    store.deleteFile(req.params.fileId);
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    res.json(store.getSnapshot(campaignId));
  });

  // ── Meetings ─────────────────────────────────────────────────────────────
  app.post("/api/campaigns/:id/meetings", (req, res) => {
    const parsed = saveMeetingSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請輸入會議名稱與時間。");
    store.saveMeeting(req.params.id, parsed.data);
    res.status(201).json(store.getSnapshot(req.params.id));
  });

  app.delete("/api/meetings/:meetingId", (req, res) => {
    store.deleteMeeting(req.params.meetingId);
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

  // ── Campaign Bot (`#/bot`) ───────────────────────────────────────────────
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
      store.appendBotMessage(campaignId, "assistant", reply.content, reply.proposals);
      res.json(store.getSnapshot(campaignId));
    } finally {
      res.off("close", onClose);
    }
  });

  app.post("/api/campaigns/:id/bot/apply", (req, res) => {
    const parsed = botApplySchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "操作建議識別碼格式不正確。");
    const campaignId = req.params.id;
    const snap = store.getSnapshot(campaignId);
    const proposal = store.markProposalApplied(parsed.data.messageId, parsed.data.proposalId);
    const p = proposal.payload;

    if (proposal.kind === "adjust_pacing" || proposal.kind === "auto_schedule") {
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
      const teamId = snap.teams.some((t) => t.id === String(p.teamId)) ? String(p.teamId) : snap.teams[0]?.id;
      const weekId = snap.weeks.some((w) => w.id === String(p.weekId)) ? String(p.weekId) : null;
      if (teamId && String(p.title ?? "").trim()) {
        store.addTodo(campaignId, {
          teamId,
          weekId,
          title: String(p.title).trim(),
          priority: p.priority === "high" ? "high" : "normal",
        });
      }
    } else if (proposal.kind === "toggle_todo") {
      if (typeof p.todoId === "string") {
        store.updateTodo(p.todoId, { done: p.done !== false });
      }
    } else if (proposal.kind === "add_week_event") {
      const targetWeek = snap.weeks.find((w) => w.id === String(p.weekId)) ?? snap.weeks[0];
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
    } else if (proposal.kind === "create_meeting") {
      store.saveMeeting(campaignId, {
        title: String(p.title || "籌備對齊會議"),
        meetingDate: String(p.meetingDate || new Date().toISOString().slice(0, 10)),
        attendees: String(p.attendees || "全體組長"),
        agenda: String(p.agenda || ""),
        arrangements: String(p.arrangements || ""),
        precautions: String(p.precautions || ""),
        decisions: "",
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
      });
      store.saveGeneratedDoc(campaignId, {
        title: doc.title,
        category: "handbook",
        contentMd: doc.contentMd,
        templateKind: tpl,
      });
    } else if (proposal.kind === "update_applicant") {
      if (typeof p.responseId === "string") {
        const status = (APPLICANT_STATUSES as readonly string[]).includes(String(p.status))
          ? (String(p.status) as typeof APPLICANT_STATUSES[number])
          : "accepted";
        store.updateFormResponse(p.responseId, {
          status,
          ...(typeof p.reviewerNote === "string" ? { reviewerNote: p.reviewerNote } : {}),
        });
      }
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
