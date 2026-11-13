import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import {
  AI_PROVIDERS,
  APPLICANT_ROLES,
  APPLICANT_STATUSES,
  CELL_STAGES,
  FILE_CATEGORIES,
  PACING_LEVELS,
  PARTNER_KINDS,
  PARTNER_STATUSES,
  TEAM_COLORS,
  type AiProvider,
  type ApplicantRole,
  type ApplicantStatus,
  type AutoSchedulePreview,
  type BotActionProposal,
  type BotMessage,
  type CampaignFile,
  type CampaignInspiration,
  type CampaignMeeting,
  type CampaignMeta,
  type CampaignNote,
  type CampaignPartner,
  type CampaignSnapshot,
  type CampaignSummary,
  type CampaignTeam,
  type CampaignTodo,
  type CampaignWeek,
  type CellStage,
  type FileCategory,
  type FormResponseItem,
  type HandbookTemplate,
  type MeetingDocSource,
  type MonthlyGoal,
  type PacingLevel,
  type PartnerKind,
  type PartnerStatus,
  type ProviderSettings,
  type ScheduleCell,
  type TeamColor,
  type TempStaffTask,
  type WeekEventItem,
} from "../shared/types.js";
import { curateComparableEvents } from "../shared/docs.js";
import {
  buildWeeklyTimelineDefs,
  defaultWeekStage,
  formatCampaignDateLabel,
  parseCsvGrid,
  parseGoogleSheetCsv,
} from "../shared/sheets.js";
import { AppError } from "./errors.js";

const DEFAULT_SETTINGS: ProviderSettings = {
  provider: "builtin",
  model: "",
};

const SAMPLE_SOCIAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450" width="800" height="450">
  <rect width="800" height="450" fill="#101114"/>
  <rect x="28" y="28" width="744" height="394" rx="12" fill="#17191E" stroke="#2D313B" stroke-width="1.5"/>
  <circle cx="680" cy="110" r="140" fill="#9E2B5C" opacity="0.18"/>
  <rect x="64" y="68" width="142" height="28" rx="14" fill="#9E2B5C"/>
  <text x="135" y="87" text-anchor="middle" fill="#FFFFFF" font-family="system-ui, sans-serif" font-size="13" font-weight="600">COUNTDOWN · W-3</text>
  <text x="64" y="156" fill="#F5F6F8" font-family="system-ui, sans-serif" font-size="36" font-weight="700">2026 夏季跨域社群年會</text>
  <text x="64" y="202" fill="#B6BAC3" font-family="system-ui, sans-serif" font-size="20">世界咖啡館 × Panel 深度與談 · 講者陣容公開</text>
  <line x1="64" y1="246" x2="736" y2="246" stroke="#272B34" stroke-width="1"/>
  <text x="64" y="294" fill="#F28BB4" font-family="monospace, sans-serif" font-size="16" font-weight="600">DATE   2026.08.05 (WED) 09:30–17:30</text>
  <text x="64" y="328" fill="#888D97" font-family="monospace, sans-serif" font-size="15">VENUE  台北數位創新基地 A 棟展演廳（避開週末 COSCUP 撞期）</text>
  <rect x="64" y="356" width="210" height="34" rx="6" fill="#22262F"/>
  <text x="169" y="378" text-anchor="middle" fill="#F5F6F8" font-family="system-ui, sans-serif" font-size="13">社群貼文定稿 · 16:9 橫幅</text>
</svg>`;

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class CampaignStore {
  private readonly db: DatabaseSync;
  readonly uploadDir: string | null;

  constructor(dbPath: string, uploadDir?: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
      this.uploadDir = uploadDir ?? join(dirname(dbPath), "uploads");
      mkdirSync(this.uploadDir, { recursive: true });
    } else {
      this.uploadDir = uploadDir ?? null;
      if (this.uploadDir) mkdirSync(this.uploadDir, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        subtitle TEXT NOT NULL DEFAULT '',
        event_date TEXT NOT NULL,
        start_date TEXT NOT NULL,
        post_weeks INTEGER NOT NULL DEFAULT 2,
        pacing TEXT NOT NULL DEFAULT 'balanced',
        main_goal TEXT NOT NULL DEFAULT '',
        monthly_goals_json TEXT NOT NULL DEFAULT '[]',
        sheet_url TEXT NOT NULL DEFAULT '',
        slides_url TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS weeks (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        order_index INTEGER NOT NULL,
        month_label TEXT NOT NULL,
        date_range TEXT NOT NULL,
        start_date TEXT NOT NULL DEFAULT '',
        end_date TEXT NOT NULL DEFAULT '',
        countdown_label TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'prep',
        stage TEXT NOT NULL DEFAULT '待排',
        major_events_json TEXT NOT NULL DEFAULT '[]',
        memo TEXT NOT NULL DEFAULT '',
        progress_override REAL
      );

      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        lead TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT 'rose',
        target_headcount INTEGER NOT NULL DEFAULT 6,
        order_index INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cells (
        week_id TEXT NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        stage TEXT NOT NULL DEFAULT '待排',
        weekly_focus TEXT NOT NULL DEFAULT '',
        cross_team TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (week_id, team_id)
      );

      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        week_id TEXT REFERENCES weeks(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        assignee TEXT NOT NULL DEFAULT '',
        done INTEGER NOT NULL DEFAULT 0,
        priority TEXT NOT NULL DEFAULT 'normal',
        due_date TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        pinned INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
        kind TEXT NOT NULL DEFAULT 'generated',
        mime_type TEXT NOT NULL DEFAULT 'text/markdown',
        file_name TEXT NOT NULL,
        disk_path TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        content_md TEXT NOT NULL DEFAULT '',
        template_kind TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        meeting_date TEXT NOT NULL,
        attendees TEXT NOT NULL DEFAULT '',
        agenda TEXT NOT NULL DEFAULT '',
        arrangements TEXT NOT NULL DEFAULT '',
        precautions TEXT NOT NULL DEFAULT '',
        decisions TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS forms (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        source_url TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        description TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS form_responses (
        id TEXT PRIMARY KEY,
        form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
        applicant_name TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        handle TEXT NOT NULL DEFAULT '',
        preferred_team_id TEXT NOT NULL,
        secondary_team_id TEXT,
        role_type TEXT NOT NULL DEFAULT 'staff',
        skills_json TEXT NOT NULL DEFAULT '[]',
        availability_json TEXT NOT NULL DEFAULT '[]',
        experience TEXT NOT NULL DEFAULT '',
        dietary_or_shirt TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        reviewer_note TEXT NOT NULL DEFAULT '',
        submitted_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS partners (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'speaker',
        name TEXT NOT NULL,
        organization TEXT NOT NULL DEFAULT '',
        role_or_topic TEXT NOT NULL DEFAULT '',
        contact TEXT NOT NULL DEFAULT '',
        team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'prospect',
        shift_or_fee TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        tasks_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inspirations (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        region TEXT NOT NULL DEFAULT '國內',
        category TEXT NOT NULL DEFAULT '',
        similarity_score INTEGER NOT NULL DEFAULT 80,
        why_similar TEXT NOT NULL DEFAULT '',
        timeline_pattern TEXT NOT NULL DEFAULT '',
        special_ideas_json TEXT NOT NULL DEFAULT '[]',
        pitfalls_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bot_messages (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        proposals_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
    `);

    this.ensureColumn("campaigns", "brief", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("campaigns", "date_tentative", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("campaigns", "tentative_note", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("weeks", "stage", "TEXT NOT NULL DEFAULT '待排'");
    this.ensureColumn("meetings", "doc_url", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("meetings", "doc_source", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("forms", "sheet_sync_url", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("forms", "last_synced_at", "TEXT NOT NULL DEFAULT ''");

    const countRow = this.db.prepare("SELECT COUNT(*) AS cnt FROM campaigns").get() as { cnt: number };
    if (countRow.cnt === 0) {
      this.seedInitialCampaign();
    } else {
      this.backfillNewModulesIfEmpty();
    }
    this.backfillWeekStagesIfNeeded();
  }

  private backfillWeekStagesIfNeeded(): void {
    const cids = this.db.prepare("SELECT id FROM campaigns").all() as Array<{ id: string }>;
    const updateStmt = this.db.prepare("UPDATE weeks SET stage = ? WHERE id = ?");
    for (const { id: cid } of cids) {
      const rows = this.db
        .prepare("SELECT id, phase, stage FROM weeks WHERE campaign_id = ? ORDER BY order_index ASC")
        .all(cid) as Array<{ id: string; phase: string; stage: string }>;
      if (rows.length === 0 || rows.some((r) => r.stage && r.stage !== "待排")) continue;
      const prepCount = rows.filter((r) => r.phase === "prep").length;
      let prepIdx = 0;
      for (const r of rows) {
        const phase = (["prep", "event", "post"].includes(r.phase) ? r.phase : "prep") as "prep" | "event" | "post";
        const stage = defaultWeekStage(phase, prepIdx, prepCount);
        if (phase === "prep") prepIdx += 1;
        updateStmt.run(stage, r.id);
      }
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private backfillNewModulesIfEmpty(): void {
    const summit = this.db
      .prepare("SELECT id, name, subtitle, brief, main_goal FROM campaigns WHERE id = 'camp-2026-summit'")
      .get() as { id: string; name: string; subtitle: string; brief: string; main_goal: string } | undefined;
    if (!summit) return;

    const pCnt = (
      this.db.prepare("SELECT COUNT(*) AS cnt FROM partners WHERE campaign_id = ?").get(summit.id) as { cnt: number }
    ).cnt;
    if (pCnt === 0) {
      this.seedPartnersForSummit(summit.id, new Date().toISOString());
    }

    const iCnt = (
      this.db.prepare("SELECT COUNT(*) AS cnt FROM inspirations WHERE campaign_id = ?").get(summit.id) as { cnt: number }
    ).cnt;
    if (iCnt === 0) {
      if (!summit.brief) {
        this.db
          .prepare("UPDATE campaigns SET brief = ? WHERE id = ?")
          .run("結合世界咖啡館圓桌對話與 Panel 跨界與談的 180 人單日技術設計社群年會。", summit.id);
      }
      this.seedInspirationsForCampaign(summit.id, {
        name: summit.name,
        subtitle: summit.subtitle,
        brief: summit.brief || "結合世界咖啡館圓桌對話與 Panel 跨界與談的 180 人單日技術設計社群年會。",
        mainGoal: summit.main_goal,
        teamNames: ["世界咖啡館", "Panel 與談", "行銷與設計組", "場務與志工組"],
      });
      // Showcase multi-week continuous stage spans on initial visible columns
      this.db.prepare("UPDATE cells SET stage = '進度50%' WHERE week_id IN ('wk-2', 'wk-3') AND team_id = 'tm-cafe'").run();
      this.db.prepare("UPDATE cells SET stage = '進度20%' WHERE week_id IN ('wk-1', 'wk-2') AND team_id = 'tm-mkt'").run();
      this.db.prepare("UPDATE cells SET stage = '進度50%' WHERE week_id IN ('wk-2', 'wk-3') AND team_id = 'tm-ops'").run();
    }
  }

  private seedInitialCampaign(): void {
    const now = new Date().toISOString();
    const campaignId = "camp-2026-summit";
    const monthlyGoals: MonthlyGoal[] = [
      { month: "六月", goal: "完成講者與桌長潛在名單研究、邀請信模板定稿" },
      { month: "七月", goal: "完成兩波講者邀約、圓桌題綱對齊、全場流 Debug 與 RC 驗收" },
      { month: "八月", goal: "避開 COSCUP 撞期順利舉辦正式活動，並於會後兩週完成核銷與復盤" },
    ];

    this.db
      .prepare(
        `INSERT INTO campaigns (id, name, subtitle, brief, event_date, start_date, post_weeks, pacing, main_goal, monthly_goals_json, sheet_url, slides_url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        campaignId,
        "2026 夏季跨域社群年會",
        "世界咖啡館 × Panel 深度論壇籌備總表",
        "結合世界咖啡館圓桌對話與 Panel 跨界與談的 180 人單日技術設計社群年會。",
        "2026-08-05",
        "2026-06-22",
        2,
        "balanced",
        "凝聚 180 位開發者與設計師深度交流，在避開八月初大型撞期活動的前提下準時完成講者邀約、宣傳與志工培訓。",
        JSON.stringify(monthlyGoals),
        "https://docs.google.com/spreadsheets/d/1dvyOuE0JzIRaylJAFH_9GMulxKG6rOSUNrIZt92hxO8/edit?gid=0#gid=0",
        "",
        now,
      );

    const weeksSeed: Array<{
      id: string;
      month: string;
      range: string;
      start: string;
      end: string;
      countdown: string;
      phase: "prep" | "event" | "post";
      events: WeekEventItem[];
      memo: string;
    }> = [
      {
        id: "wk-1",
        month: "六月",
        range: "6/22~6/28",
        start: "2026-06-22",
        end: "2026-06-28",
        countdown: "倒數 6 周",
        phase: "prep",
        events: [{ id: "ev-kickoff", title: "籌備啟動對齊會", kind: "milestone", dateLabel: "6/24" }],
        memo: "組長確認名單方向",
      },
      {
        id: "wk-2",
        month: "七月",
        range: "6/29~7/05",
        start: "2026-06-29",
        end: "2026-07-05",
        countdown: "倒數 5 周",
        phase: "prep",
        events: [],
        memo: "7/5 第一波邀請信送出",
      },
      {
        id: "wk-3",
        month: "七月",
        range: "7/06~7/12",
        start: "2026-07-06",
        end: "2026-07-12",
        countdown: "倒數 4 周",
        phase: "prep",
        events: [{ id: "ev-roster", title: "7/11 講者與與談名單確認", kind: "milestone", dateLabel: "7/11" }],
        memo: "7/9 第二波信件送出",
      },
      {
        id: "wk-4",
        month: "七月",
        range: "7/13~7/19",
        start: "2026-07-13",
        end: "2026-07-19",
        countdown: "倒數 3 周",
        phase: "prep",
        events: [{ id: "ev-brief", title: "講者與志工行前通知定稿", kind: "milestone", dateLabel: "7/17" }],
        memo: "跨部對齊題綱與視覺",
      },
      {
        id: "wk-5",
        month: "七月",
        range: "7/20~7/26",
        start: "2026-07-20",
        end: "2026-07-26",
        countdown: "倒數 2 周",
        phase: "prep",
        events: [{ id: "ev-debug", title: "全流程沙盤推演 Debug", kind: "milestone", dateLabel: "7/24" }],
        memo: "收齊講者簡報初稿",
      },
      {
        id: "wk-6",
        month: "七月",
        range: "7/27~8/02",
        start: "2026-07-27",
        end: "2026-08-02",
        countdown: "倒數 1 周",
        phase: "prep",
        events: [{ id: "ev-kazma", title: "7/27 Kazma 入伍（職務交接避開單點卡關）", kind: "conflict", dateLabel: "7/27" }],
        memo: "總彩排 RC 凍結變更",
      },
      {
        id: "wk-7",
        month: "八月",
        range: "8/03~8/09",
        start: "2026-08-03",
        end: "2026-08-09",
        countdown: "活動當周",
        phase: "event",
        events: [
          { id: "ev-main", title: "8/05 週三年會正式登場", kind: "milestone", dateLabel: "8/05" },
          { id: "ev-coscup", title: "8/8~8/9 COSCUP 撞期（避開週末辦在週三）", kind: "conflict", dateLabel: "8/8~8/9" },
        ],
        memo: "避開週末開源年會撞期",
      },
      {
        id: "wk-8",
        month: "八月",
        range: "8/10~8/16",
        start: "2026-08-10",
        end: "2026-08-16",
        countdown: "活動後 1 周",
        phase: "post",
        events: [{ id: "ev-thank", title: "講者感謝函與問卷回收統計", kind: "milestone", dateLabel: "8/12" }],
        memo: "單據收集與廠商尾款核銷",
      },
      {
        id: "wk-9",
        month: "八月",
        range: "8/17~8/23",
        start: "2026-08-17",
        end: "2026-08-23",
        countdown: "活動後 2 周",
        phase: "post",
        events: [{ id: "ev-retro", title: "全體幹部復盤檢討與文件封存", kind: "milestone", dateLabel: "8/20" }],
        memo: "產出傳承手冊",
      },
    ];

    const insertWeek = this.db.prepare(
      `INSERT INTO weeks (id, campaign_id, order_index, month_label, date_range, start_date, end_date, countdown_label, phase, stage, major_events_json, memo, progress_override)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    const prepSeedCount = weeksSeed.filter((w) => w.phase === "prep").length;
    let prepSeedIdx = 0;
    weeksSeed.forEach((w, i) => {
      const stage = defaultWeekStage(w.phase, prepSeedIdx, prepSeedCount);
      if (w.phase === "prep") prepSeedIdx += 1;
      insertWeek.run(
        w.id,
        campaignId,
        i,
        w.month,
        w.range,
        w.start,
        w.end,
        w.countdown,
        w.phase,
        stage,
        JSON.stringify(w.events),
        w.memo,
      );
    });

    const teamsSeed: Array<{ id: string; name: string; lead: string; color: TeamColor; headcount: number }> = [
      { id: "tm-cafe", name: "世界咖啡館", lead: "林子晴", color: "violet", headcount: 6 },
      { id: "tm-panel", name: "Panel 與談", lead: "陳柏翰", color: "sky", headcount: 5 },
      { id: "tm-mkt", name: "行銷與設計組", lead: "周品妍", color: "rose", headcount: 5 },
      { id: "tm-ops", name: "場務與志工組", lead: "張哲維", color: "mint", headcount: 8 },
    ];

    const insertTeam = this.db.prepare(
      `INSERT INTO teams (id, campaign_id, name, lead, color, target_headcount, order_index)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    teamsSeed.forEach((t, i) => {
      insertTeam.run(t.id, campaignId, t.name, t.lead, t.color, t.headcount, i);
    });

    const cellsSeed: Array<{ w: string; t: string; stage: CellStage; focus: string; cross?: string }> = [
      // 世界咖啡館 (Directly aligned with reference Google Sheet + multi-week 50% invitation span)
      { w: "wk-1", t: "tm-cafe", stage: "進度25%", focus: "名單研究 & 確認" },
      { w: "wk-2", t: "tm-cafe", stage: "進度50%", focus: "第一波寄信邀約" },
      { w: "wk-3", t: "tm-cafe", stage: "進度50%", focus: "第二波寄信與追蹤" },
      { w: "wk-4", t: "tm-cafe", stage: "進度100%", focus: "企劃定案 & 行前通知", cross: "圓桌題綱討論 · 主持人講稿準備" },
      { w: "wk-5", t: "tm-cafe", stage: "Debug", focus: "桌長簡報與換桌動線檢核" },
      { w: "wk-6", t: "tm-cafe", stage: "RC", focus: "主持彩排與計時牌確認" },
      { w: "wk-7", t: "tm-cafe", stage: "活動", focus: "活動當日主持與圓桌引導" },
      { w: "wk-8", t: "tm-cafe", stage: "復盤", focus: "整理圓桌便利貼洞察摘要" },
      { w: "wk-9", t: "tm-cafe", stage: "復盤", focus: "桌長回饋訪談歸檔" },

      // Panel 與談 (Directly aligned with reference Google Sheet)
      { w: "wk-1", t: "tm-panel", stage: "進度25%", focus: "名單研究 & 確認" },
      { w: "wk-2", t: "tm-panel", stage: "進度50%", focus: "第一波寄信邀約" },
      { w: "wk-3", t: "tm-panel", stage: "進度75%", focus: "第二波寄信與檔期敲定" },
      { w: "wk-4", t: "tm-panel", stage: "進度100%", focus: "企劃 & 講者行前通知", cross: "主持人題綱討論" },
      { w: "wk-5", t: "tm-panel", stage: "Debug", focus: "傳正式題綱給與談者並線上對稿" },
      { w: "wk-6", t: "tm-panel", stage: "RC", focus: "舞台麥克風與投影片切換測試" },
      { w: "wk-7", t: "tm-panel", stage: "活動", focus: "活動當日與談控場與機動接待" },
      { w: "wk-8", t: "tm-panel", stage: "復盤", focus: "寄送與談精華紀錄與感謝信" },
      { w: "wk-9", t: "tm-panel", stage: "復盤", focus: "議程滿意度檢討" },

      // 行銷與設計組 (20%-step continuous span example)
      { w: "wk-1", t: "tm-mkt", stage: "進度20%", focus: "主視覺色彩規範與社群版型" },
      { w: "wk-2", t: "tm-mkt", stage: "進度20%", focus: "早鳥報名頁與首波預告圖卡" },
      { w: "wk-3", t: "tm-mkt", stage: "進度60%", focus: "講者陣容介紹圖卡製作", cross: "向咖啡館／Panel 收齊講者頭像簡介" },
      { w: "wk-4", t: "tm-mkt", stage: "進度100%", focus: "行前懶人包排版與場地指引圖", cross: "對齊場務組報到動線圖" },
      { w: "wk-5", t: "tm-mkt", stage: "Debug", focus: "名牌、手舉牌與背板送印校色" },
      { w: "wk-6", t: "tm-mkt", stage: "RC", focus: "倒數 7 天貼文排程（錯開撞期熱點）" },
      { w: "wk-7", t: "tm-mkt", stage: "活動", focus: "現場即時限動與活動側拍紀錄" },
      { w: "wk-8", t: "tm-mkt", stage: "復盤", focus: "精選活動花絮相簿發佈" },
      { w: "wk-9", t: "tm-mkt", stage: "復盤", focus: "設計原始檔與素材庫歸檔" },

      // 場務與志工組
      { w: "wk-1", t: "tm-ops", stage: "進度25%", focus: "展演廳場勘與外燴廠商詢價" },
      { w: "wk-2", t: "tm-ops", stage: "進度50%", focus: "釋出招工表單與器材清單盤點" },
      { w: "wk-3", t: "tm-ops", stage: "進度50%", focus: "第一批志工審核與茶點下訂" },
      { w: "wk-4", t: "tm-ops", stage: "進度100%", focus: "發送志工行前通知與班表分發", cross: "確認世界咖啡館圓桌桌椅配置" },
      { w: "wk-5", t: "tm-ops", stage: "Debug", focus: "線上志工行前說明會與報到演練" },
      { w: "wk-6", t: "tm-ops", stage: "RC", focus: "Kazma 場控職務交接演練與物資裝箱" },
      { w: "wk-7", t: "tm-ops", stage: "活動", focus: "報到引導、茶點補給與場地復原" },
      { w: "wk-8", t: "tm-ops", stage: "復盤", focus: "廠商發票核銷與志工時數證明寄發" },
      { w: "wk-9", t: "tm-ops", stage: "復盤", focus: "器材損耗盤點與場地檢討" },
    ];

    const insertCell = this.db.prepare(
      `INSERT INTO cells (week_id, team_id, stage, weekly_focus, cross_team, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const c of cellsSeed) {
      insertCell.run(c.w, c.t, c.stage, c.focus, c.cross ?? "", now);
    }

    const todosSeed: Array<{
      teamId: string;
      weekId: string;
      title: string;
      assignee: string;
      done: boolean;
      priority?: "normal" | "high";
      due: string;
    }> = [
      { teamId: "tm-cafe", weekId: "wk-1", title: "潛在桌長名單蒐集（12 位候選）", assignee: "林子晴", done: true, due: "2026-06-26" },
      { teamId: "tm-cafe", weekId: "wk-1", title: "世界咖啡館邀請信件模板定稿", assignee: "林子晴", done: true, due: "2026-06-28" },
      { teamId: "tm-cafe", weekId: "wk-2", title: "寄出第一波桌長邀請信並建立追蹤表", assignee: "吳宥廷", done: true, due: "2026-07-05" },
      { teamId: "tm-cafe", weekId: "wk-3", title: "第二波遞補寄信與 7/11 最終名單確認", assignee: "林子晴", done: true, priority: "high", due: "2026-07-11" },
      { teamId: "tm-cafe", weekId: "wk-4", title: "寄發講者行前通知與收集個人簡介", assignee: "吳宥廷", done: false, priority: "high", due: "2026-07-17" },
      { teamId: "tm-cafe", weekId: "wk-5", title: "簡報最後確認與圓桌引導手卡印製", assignee: "林子晴", done: false, due: "2026-07-25" },

      { teamId: "tm-panel", weekId: "wk-1", title: "Panel 與談人潛在名單蒐集與議題設定", assignee: "陳柏翰", done: true, due: "2026-06-27" },
      { teamId: "tm-panel", weekId: "wk-2", title: "第一波與談邀請信撰寫與寄送", assignee: "陳柏翰", done: true, due: "2026-07-05" },
      { teamId: "tm-panel", weekId: "wk-4", title: "與主持人對齊三大交鋒題綱", assignee: "許庭瑜", done: true, due: "2026-07-16" },
      { teamId: "tm-panel", weekId: "wk-5", title: "傳送正式題綱與彩排時段給 4 位與談者", assignee: "陳柏翰", done: false, priority: "high", due: "2026-07-23" },

      { teamId: "tm-mkt", weekId: "wk-2", title: "主視覺與報名頁面正式上線", assignee: "周品妍", done: true, due: "2026-07-04" },
      { teamId: "tm-mkt", weekId: "wk-3", title: "完成 8 張講者單人社群宣傳圖卡", assignee: "鄭宇軒", done: true, due: "2026-07-12" },
      { teamId: "tm-mkt", weekId: "wk-4", title: "輸出會場動線圖與桌牌印刷檔", assignee: "周品妍", done: false, priority: "high", due: "2026-07-19" },
      { teamId: "tm-mkt", weekId: "wk-6", title: "排定會前一週倒數貼文（錯開 COSCUP 宣傳高峰）", assignee: "鄭宇軒", done: false, due: "2026-07-30" },

      { teamId: "tm-ops", weekId: "wk-2", title: "招工表單上線與社群轉發招募", assignee: "張哲維", done: true, due: "2026-07-03" },
      { teamId: "tm-ops", weekId: "wk-3", title: "確認下午茶外燴廠商報價與素食比例", assignee: "何宜蓁", done: true, due: "2026-07-11" },
      { teamId: "tm-ops", weekId: "wk-4", title: "完成招工表單最後一批志工錄取分發", assignee: "張哲維", done: false, priority: "high", due: "2026-07-18" },
      { teamId: "tm-ops", weekId: "wk-6", title: "完成 Kazma 入伍前音響控台交接演練", assignee: "張哲維", done: false, priority: "high", due: "2026-07-26" },
      { teamId: "tm-ops", weekId: "wk-8", title: "彙整全組發票單據辦理活動後核銷", assignee: "何宜蓁", done: false, due: "2026-08-14" },
    ];

    const insertTodo = this.db.prepare(
      `INSERT INTO todos (id, campaign_id, team_id, week_id, title, assignee, done, priority, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    todosSeed.forEach((td, i) => {
      insertTodo.run(
        `todo-${i + 1}`,
        campaignId,
        td.teamId,
        td.weekId,
        td.title,
        td.assignee,
        td.done ? 1 : 0,
        td.priority ?? "normal",
        td.due,
        now,
        now,
      );
    });

    // Seed Personal Notes
    const insertNote = this.db.prepare(
      `INSERT INTO notes (id, campaign_id, title, body, tags_json, pinned, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertNote.run(
      "note-1",
      campaignId,
      "為什麼把正式活動定在 8/05（週三）而非週末",
      "8/8~8/9 剛好撞期 COSCUP 開源人年會，許多講者與技術志工兩邊都會參加。\n把活動定在 8/05 週三白天並提前兩週在 7/24 完成 Debug 彩排，不僅講者出席率提高到 92%，也能避免 7/27 Kazma 入伍後的場控人力斷層。",
      JSON.stringify(["撞期決策", "總召筆記"]),
      1,
      now,
    );
    insertNote.run(
      "note-2",
      campaignId,
      "世界咖啡館換桌節奏小巧思",
      "每輪 25 分鐘討論 + 5 分鐘換桌，桌長留在原桌摘要上一輪的 3 個核心觀點，讓新加入的與會者 90 秒內就能接上脈絡。記得請設計組幫每桌印一張 A2 塗鴉桌紙！",
      JSON.stringify(["世界咖啡館", "體驗設計"]),
      0,
      now,
    );

    // Seed Meetings
    const insertMeeting = this.db.prepare(
      `INSERT INTO meetings (id, campaign_id, title, meeting_date, attendees, agenda, arrangements, precautions, decisions, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertMeeting.run(
      "mtg-1",
      campaignId,
      "倒數 3 週 · 跨組總對齊週會",
      "2026-07-15 20:30",
      "總召、林子晴（咖啡館）、陳柏翰（Panel）、周品妍（行銷）、張哲維（場務）",
      "1. 檢視 7/11 名單確認後的講者回信率\n2. 對齊講者行前手冊與志工懶人包發送時程\n3. 盤點招工表單各組剩餘人力缺口",
      "20:30–20:45 各組進度快報（每組 3 分鐘）\n20:45–21:10 圓桌與 Panel 題綱交叉檢視\n21:10–21:30 場務動線圖與 Kazma 交接排程確認",
      "• 請行銷組會前先上傳講者圖卡初稿至文件歸檔區\n• 7/27 後 Kazma 入伍，所有音響與投影轉接頭清單須在本週五前點交給哲維\n• 8/8~8/9 撞期 COSCUP，社群重點貼文務必排在 7/28–8/04 之間發佈",
      "決議於 7/17 統一寄出講者行前手冊；場務組優先錄取具報到與場控經驗的 3 位待審核志工。",
      now,
    );
    insertMeeting.run(
      "mtg-2",
      campaignId,
      "全流程沙盤推演（Debug 彩排會前準備）",
      "2026-07-24 19:30",
      "全體幹部與主持群",
      "1. 從 08:30 志工報到至 17:30 撤場逐時段走位\n2. 講者臨時遲到或簡報字體跑版備案\n3. 現場緊急聯絡樹確認",
      "前 30 分鐘走主舞台 Panel 流程，後 30 分鐘模擬世界咖啡館 8 桌同步換桌動線。",
      "• 所有與談人簡報統一轉存一份 PDF 備份於本機\n• 確認外燴廠商 13:45 準時抵達 B1 卸貨區",
      "待開會記錄。",
      now,
    );

    // Seed Files (Generated Handbooks + Real Uploaded SVG Asset + Vendor Doc)
    const insertFile = this.db.prepare(
      `INSERT INTO files (id, campaign_id, title, category, team_id, kind, mime_type, file_name, disk_path, size_bytes, content_md, template_kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let socialDiskPath: string | null = null;
    const svgBytes = Buffer.from(SAMPLE_SOCIAL_SVG, "utf8");
    if (this.uploadDir) {
      socialDiskPath = join(this.uploadDir, "file-social-1.svg");
      writeFileSync(socialDiskPath, svgBytes);
    }

    insertFile.run(
      "file-handbook-staff",
      campaignId,
      "2026 夏季年會 · 籌備人員與志工懶人包行前手冊",
      "handbook",
      "tm-ops",
      "generated",
      "text/markdown",
      "staff-lazy-pack-2026.md",
      null,
      0,
      `# 2026 夏季跨域社群年會 · 籌備人員懶人包行前手冊

## 一、核心時程與集合資訊
- **活動日期**：2026 年 8 月 5 日（週三）09:30–17:30
- **幹部與志工集合**：08:15 於台北數位創新基地 A 棟 1F 服務台完成簽到與領取對講機
- **服裝與識別**：深色上衣搭配大會工作證（場務組於報到時發放）

## 二、當日整點時間軸
| 時段 | 場次／行動 | 負責組別與重點 |
| --- | --- | --- |
| 08:15–09:00 | 場佈、音響測試、報到台就緒 | 場務組確認雙投影與手麥；行銷組擺放桌牌 |
| 09:00–09:30 | 與會者與講者分流報到 | 講者由專人引導至貴賓休息室測試簡報 |
| 09:40–12:00 | Panel 深度與談 | Panel 組控時（剩 10／5／1 分鐘舉牌） |
| 13:30–16:15 | 世界咖啡館（三輪換桌） | 咖啡館組引導換桌；外燴 14:00 靜音補茶水 |
| 16:30–17:30 | 全場收斂分享與撤場復原 | 18:00 前完成場地點交 |

## 三、跨組緊急聯絡窗口
- **總召／現場總決策**：緊急狀況統一回報主控台（Ch.1）
- **世界咖啡館**：林子晴 ｜ **Panel 與談**：陳柏翰
- **行銷與設計**：周品妍 ｜ **場務與志工**：張哲維`,
      "staff_lazy_pack",
      now,
      now,
    );

    insertFile.run(
      "file-handbook-speaker",
      campaignId,
      "Panel 與世界咖啡館 · 講者行前手冊與提醒",
      "handbook",
      "tm-panel",
      "generated",
      "text/markdown",
      "speaker-handbook-2026.md",
      null,
      0,
      `# 2026 夏季跨域社群年會 · 講者與與談人行前手冊

親愛的講者／與談夥伴您好，感謝您撥冗參與本次夏季年會！以下為當日流程與行前準備提醒：

## 1. 報到時間與地點
- **時間**：2026 年 8 月 5 日（週三），建議於您的場次前 **40 分鐘**抵達
- **地點**：台北數位創新基地 A 棟展演廳（捷運忠孝新生站 4 號出口步行 5 分鐘）
- **專屬接待**：抵達 1F 後請向「講者接待處」報上大名，將由專責夥伴引導至休息室並協助投影測試。

## 2. 簡報規格與設備說明
- 現場螢幕比例為 **16:9（1920×1080）**，提供 HDMI 與 USB-C 轉接及簡報筆。
- 請於 **7 月 25 日（週六）前**回傳簡報定稿（建議同時附上 PDF 備份檔），避免現場字型差異。

## 3. 當日聯絡窗口
- Panel 與談組負責人：陳柏翰
- 世界咖啡館負責人：林子晴`,
      "speaker_handbook",
      now,
      now,
    );

    insertFile.run(
      "file-social-1",
      campaignId,
      "倒數 3 週講者公開 · 社群橫幅主視覺圖卡",
      "social",
      "tm-mkt",
      "upload",
      "image/svg+xml",
      "countdown-w3-social-banner.svg",
      socialDiskPath,
      svgBytes.byteLength,
      "",
      null,
      now,
      now,
    );

    insertFile.run(
      "file-vendor-1",
      campaignId,
      "外燴茶點與舞台燈光音響廠商規格確認書",
      "vendor",
      "tm-ops",
      "generated",
      "text/markdown",
      "vendor-catering-av-spec.md",
      null,
      0,
      `# 協力廠商進撤場與規格確認書

- **外燴茶點廠商**：森日手作餐飲（180 人份午茶點心，含全素 25 份、無麩質標示）
  - 進場時段：8/05 13:15–13:45 由 B1 貨梯進場，16:45 收拾器具
- **音響燈光協力**：聲脈工程（無線手麥 6 支、領夾麥 4 組、圓桌收音備援）
  - 進場測試：8/05 08:00 進場調音，指派 1 名駐場音控師全程支援`,
      "vendor_brief",
      now,
      now,
    );

    // Seed Recruitment Form & Responses
    const formId = "form-volunteer-2026";
    this.db
      .prepare(
        `INSERT INTO forms (id, campaign_id, title, source_url, status, description, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        formId,
        campaignId,
        "2026 夏季年會 · 籌備團隊與當日志工招工表單",
        "https://docs.google.com/forms/d/e/1FAIpQLSeBellCampaignDemo/viewform",
        "open",
        "招募世界咖啡館桌長助理、Panel 接待機動、社群攝影側拍與場務報到志工夥伴。",
        now,
      );

    const applicants: Array<{
      id: string;
      name: string;
      email: string;
      handle: string;
      pref: string;
      sec: string | null;
      role: ApplicantRole;
      skills: string[];
      avail: string[];
      exp: string;
      shirt: string;
      status: ApplicantStatus;
      note: string;
      at: string;
    }> = [
      {
        id: "resp-1",
        name: "宋佳穎",
        email: "chiaying.sung@example.com",
        handle: "@cy_sung",
        pref: "tm-cafe",
        sec: "tm-panel",
        role: "core",
        skills: ["引導主持", "便利貼視覺紀錄", "雙語接待"],
        avail: ["會前每週籌備", "8/04 場佈", "8/05 全日", "撤場"],
        exp: "曾任兩屆校園黑客松議程組與 SITCON 世界咖啡館桌長助理，熟悉換桌計時與議題收斂。",
        shirt: "M · 蛋奶素",
        status: "accepted",
        note: "引導經驗豐富，直接排入第 1–2 桌桌長協作。",
        at: "2026-07-04T09:20:00.000Z",
      },
      {
        id: "resp-2",
        name: "劉冠廷",
        email: "kuanting.liu@example.com",
        handle: "@ktliu_av",
        pref: "tm-ops",
        sec: "tm-panel",
        role: "staff",
        skills: ["舞台音控", "OBS 轉播", "HDMI/投影排障"],
        avail: ["會前每週籌備", "8/04 場佈", "8/05 全日", "撤場"],
        exp: "系學會活動部長，負責過 300 人演講廳燈光音控與無線麥克風頻段管理。",
        shirt: "L · 葷食",
        status: "accepted",
        note: "可完美銜接 7/27 Kazma 入伍後的舞台音控職缺！",
        at: "2026-07-05T14:12:00.000Z",
      },
      {
        id: "resp-3",
        name: "江品潔",
        email: "pinchieh.chiang@example.com",
        handle: "@pj_photo",
        pref: "tm-mkt",
        sec: "tm-cafe",
        role: "day_volunteer",
        skills: ["活動側拍", "Lightroom 快修", "限動短影音"],
        avail: ["8/05 全日", "撤場"],
        exp: "自由接案活動攝影，自備雙機身與大三元鏡頭，可於中場休息即時出 10 張精選限動圖。",
        shirt: "S · 葷食",
        status: "accepted",
        note: "已確認攜帶全片幅雙機支援主舞台與圓桌側拍。",
        at: "2026-07-06T18:45:00.000Z",
      },
      {
        id: "resp-4",
        name: "黃紹恩",
        email: "shaoen.h@example.com",
        handle: "@se_huang",
        pref: "tm-ops",
        sec: null,
        role: "day_volunteer",
        skills: ["QR 報到分流", "外燴動線", "急救證照"],
        avail: ["8/04 場佈", "8/05 全日", "撤場"],
        exp: "擔任過三次研討會報到組長，熟悉尖峰半小時 150 人快速驗票動線。",
        shirt: "XL · 葷食",
        status: "pending",
        note: "場務組目前還缺報到前台人力，優先審核。",
        at: "2026-07-10T11:05:00.000Z",
      },
      {
        id: "resp-5",
        name: "蔡明珊",
        email: "mingshan.tsai@example.com",
        handle: "@ms_tsai",
        pref: "tm-panel",
        sec: "tm-cafe",
        role: "staff",
        skills: ["講者接待", "時間控場", "逐字筆記"],
        avail: ["會前每週籌備", "8/05 全日"],
        exp: "曾協助企業技術論壇 VIP 講者動線引導與會後精華共筆撰寫。",
        shirt: "M · 全素",
        status: "interview",
        note: "約本週四晚間 15 分鐘線上聊聊講者接待分工。",
        at: "2026-07-11T08:30:00.000Z",
      },
      {
        id: "resp-6",
        name: "郭庭瑋",
        email: "tingwei.kuo@example.com",
        handle: "@twkuo_design",
        pref: "tm-mkt",
        sec: "tm-ops",
        role: "staff",
        skills: ["Figma 版型", "印刷完稿", "社群文案"],
        avail: ["會前每週籌備", "8/05 全日"],
        exp: "設計系大四，擅長資訊圖表與活動懶人包排版，可支援行前手冊視覺美化。",
        shirt: "L · 葷食",
        status: "pending",
        note: "",
        at: "2026-07-12T16:18:00.000Z",
      },
      {
        id: "resp-7",
        name: "謝承諺",
        email: "chengyen.h@example.com",
        handle: "@cy_hsieh",
        pref: "tm-cafe",
        sec: "tm-ops",
        role: "day_volunteer",
        skills: ["桌次引導", "麥克風遞送"],
        avail: ["8/05 全日"],
        exp: "第一次參與大型社群籌備，希望能從現場機動與圓桌協助開始學習。",
        shirt: "M · 葷食",
        status: "waitlist",
        note: "態度積極，列為第一順位機動備取。",
        at: "2026-07-12T21:40:00.000Z",
      },
    ];

    const insertResp = this.db.prepare(
      `INSERT INTO form_responses (id, form_id, applicant_name, email, handle, preferred_team_id, secondary_team_id, role_type, skills_json, availability_json, experience, dietary_or_shirt, status, reviewer_note, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of applicants) {
      insertResp.run(
        r.id,
        formId,
        r.name,
        r.email,
        r.handle,
        r.pref,
        r.sec,
        r.role,
        JSON.stringify(r.skills),
        JSON.stringify(r.avail),
        r.exp,
        r.shirt,
        r.status,
        r.note,
        r.at,
      );
    }

    this.seedPartnersForSummit(campaignId, now);
    this.seedInspirationsForCampaign(campaignId, {
      name: "2026 夏季跨域社群年會",
      subtitle: "世界咖啡館 × Panel 深度論壇籌備總表",
      brief: "結合世界咖啡館圓桌對話與 Panel 跨界與談的 180 人單日技術設計社群年會。",
      mainGoal: "凝聚 180 位開發者與設計師深度交流，在避開八月初大型撞期活動的前提下準時完成講者邀約、宣傳與志工培訓。",
      teamNames: ["世界咖啡館", "Panel 與談", "行銷與設計組", "場務與志工組"],
    });

    // Seed initial Campaign Bot message
    this.db
      .prepare(
        `INSERT INTO bot_messages (id, campaign_id, role, content, proposals_json, created_at)
         VALUES (?, ?, 'assistant', ?, '[]', ?)`,
      )
      .run(
        "bot-welcome",
        campaignId,
        "你好！我是 **Campaign Bot**。我可以協助你規劃新專案定位、調整時程緊湊度、管理講者／廠商／臨時工合作名單、雙向同步會議記錄、生成行前手冊，或盤點招工表單缺口。直接告訴我想處理哪一部分即可。",
        now,
      );
  }

  private seedPartnersForSummit(campaignId: string, now: string): void {
    const insertPartner = this.db.prepare(
      `INSERT INTO partners (id, campaign_id, kind, name, organization, role_or_topic, contact, team_id, status, shift_or_fee, notes, tasks_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const seedList: Array<{
      id: string;
      kind: PartnerKind;
      name: string;
      org: string;
      topic: string;
      contact: string;
      teamId: string | null;
      status: PartnerStatus;
      shiftOrFee: string;
      notes: string;
      tasks?: TempStaffTask[];
    }> = [
      // Speakers
      {
        id: "pt-spk-1",
        kind: "speaker",
        name: "林致遠 博士",
        org: "OpenUX 實驗室共同創辦人",
        topic: "Panel 主題與談：AI 輔助產品設計與開源協作新常態",
        contact: "cy.lin@openux.example",
        teamId: "tm-panel",
        status: "briefed",
        shiftOrFee: "出席車馬費 NT$4,000 · 13:30 報到",
        notes: "已確認不與 COSCUP 演講撞期，簡報 PDF 備份預計 7/24 收齊。",
      },
      {
        id: "pt-spk-2",
        kind: "speaker",
        name: "許安榆",
        org: "FlowCraft 資深設計系統架構師",
        topic: "世界咖啡館第 1 桌主桌長：跨職能設計系統落地實務",
        contact: "anyu.hsu@flowcraft.example",
        teamId: "tm-cafe",
        status: "confirmed",
        shiftOrFee: "講師禮遇票 + 車馬費 NT$3,000",
        notes: "希望能準備雙色便利貼與 A2 桌紙供與會者繪製元件樹。",
      },
      {
        id: "pt-spk-3",
        kind: "speaker",
        name: "高翊群",
        org: "獨立開發者／技術作家",
        topic: "Panel 與談嘉賓：一人產品團隊的自動化工作流",
        contact: "yichun.kao@indie.example",
        teamId: "tm-panel",
        status: "contacting",
        shiftOrFee: "出席車馬費 NT$4,000 · 待覆彩排時段",
        notes: "第二波邀約信已寄出，本週五追蹤線上對稿時間。",
      },

      // Vendors
      {
        id: "pt-vnd-1",
        kind: "vendor",
        name: "森日手作餐飲",
        org: "外燴茶點與飲品協力",
        topic: "180 人份午茶點心盒與莊園咖啡桶（含全素 25 份）",
        contact: "窗口 林經理 · 02-2700-8812",
        teamId: "tm-ops",
        status: "confirmed",
        shiftOrFee: "合約總額 NT$39,600（已付訂金 30%）",
        notes: "8/05 13:15 由 B1 貨梯進場擺設，16:45 收拾保溫桶。",
      },
      {
        id: "pt-vnd-2",
        kind: "vendor",
        name: "聲脈工程有限公司",
        org: "舞台燈光音響與圓桌收音",
        topic: "無線手麥 6 支、領夾麥 4 組、主舞台雙投影切換器與駐場音控",
        contact: "窗口 趙工程師 · @soundpulse_tw",
        teamId: "tm-ops",
        status: "briefed",
        shiftOrFee: "報價 NT$28,000（活動後月結開發票）",
        notes: "已配對場務組劉冠廷共同對接，8/05 08:00 進場調音。",
      },
      {
        id: "pt-vnd-3",
        kind: "vendor",
        name: "印格美學印刷",
        org: "大圖背板與識別證印製",
        topic: "主舞台橫幅、雙面議程識別證 220 份、世界咖啡館桌牌與 A2 桌紙",
        contact: "service@inkgrid.example",
        teamId: "tm-mkt",
        status: "contacting",
        shiftOrFee: "估價 NT$14,500 · 7/23 截稿送印",
        notes: "等待行銷設計組確認最終贊助與合作夥伴 Logo 排列。",
      },

      // Temp Staff (臨時工，含組別、負責工作項目與完成狀況)
      {
        id: "pt-tmp-1",
        kind: "temp_staff",
        name: "陳品叡",
        org: "場務機動臨時工",
        topic: "重物搬運、圓桌桌椅復原與 B1 貨梯進撤場引導",
        contact: "0912-345-678 · Line: @pinrui_c",
        teamId: "tm-ops",
        status: "confirmed",
        shiftOrFee: "8/05 07:30–18:30（時薪 NT$220 · 含午餐便當）",
        notes: "具備大型展場進撤場經驗，已填寫勞報單資料。",
        tasks: [
          { id: "tsk-1", title: "07:45 協助聲脈工程自 B1 貨梯搬運音箱入廳", done: true },
          { id: "tsk-2", title: "08:30 排列世界咖啡館 8 組圓桌與 64 張座椅", done: true },
          { id: "tsk-3", title: "17:30 活動結束後復原展演廳標準座位並清點垃圾袋", done: false },
        ],
      },
      {
        id: "pt-tmp-2",
        kind: "temp_staff",
        name: "方語晴",
        org: "前台驗票與貴賓接待臨時工",
        topic: "1F 報到處高速 QR 驗票、識別證發放與講者休息室茶水補給",
        contact: "0928-661-204 · Line: @yuching_f",
        teamId: "tm-panel",
        status: "confirmed",
        shiftOrFee: "8/05 08:30–14:30（半日班 NT$1,320）",
        notes: "熟悉 Accupass / KKTIX 驗票 App，中英文應對流利。",
        tasks: [
          { id: "tsk-4", title: "08:40 完成報到平板登入與備用簽到名冊核對", done: true },
          { id: "tsk-5", title: "09:00–10:15 執行奇數號入場通道驗票與發放名牌", done: false },
          { id: "tsk-6", title: "13:15 引導下午場 Panel 與談嘉賓至講者休息室", done: false },
        ],
      },
      {
        id: "pt-tmp-3",
        kind: "temp_staff",
        name: "羅子軒",
        org: "現場動態側拍與快剪臨時工",
        topic: "世界咖啡館換桌花絮拍攝與中場 30 秒精華限動快剪",
        contact: "0955-109-882 · IG: @zx_reel",
        teamId: "tm-mkt",
        status: "confirmed",
        shiftOrFee: "8/05 09:30–17:30（專案日薪 NT$3,200）",
        notes: "自備穩定器與筆電，需預留媒體席插座。",
        tasks: [
          { id: "tsk-7", title: "確認行銷設計組限動字卡套版與雲端上傳資料夾權限", done: true },
          { id: "tsk-8", title: "12:30 前交付上午場 8 張精修橫幅照片供社群即時發文", done: false },
          { id: "tsk-9", title: "18:00 前備份全天 RAW 檔與直式短影音素材至歸檔區", done: false },
        ],
      },
    ];

    for (const p of seedList) {
      insertPartner.run(
        p.id,
        campaignId,
        p.kind,
        p.name,
        p.org,
        p.topic,
        p.contact,
        p.teamId,
        p.status,
        p.shiftOrFee,
        p.notes,
        JSON.stringify(p.tasks ?? []),
        now,
      );
    }
  }

  seedInspirationsForCampaign(
    campaignId: string,
    input: { name: string; subtitle: string; brief: string; mainGoal: string; teamNames: string[]; focusHint?: string },
  ): void {
    const now = new Date().toISOString();
    const curated = curateComparableEvents({
      campaignId,
      ...input,
    });
    this.db.prepare("DELETE FROM inspirations WHERE campaign_id = ?").run(campaignId);
    const insertInsp = this.db.prepare(
      `INSERT INTO inspirations (id, campaign_id, title, region, category, similarity_score, why_similar, timeline_pattern, special_ideas_json, pitfalls_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of curated) {
      insertInsp.run(
        `insp-${randomUUID().slice(0, 8)}`,
        campaignId,
        item.title,
        item.region,
        item.category,
        item.similarityScore,
        item.whySimilar,
        item.timelinePattern,
        JSON.stringify(item.specialIdeas),
        JSON.stringify(item.pitfalls),
        now,
      );
    }
  }

  // ── Settings ─────────────────────────────────────────────────────────────
  getSettings(): ProviderSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'provider'").get() as { value: string } | undefined;
    const parsed = safeJsonParse<Partial<ProviderSettings>>(row?.value, {});
    const provider: AiProvider =
      parsed.provider && (AI_PROVIDERS as readonly string[]).includes(parsed.provider)
        ? parsed.provider
        : DEFAULT_SETTINGS.provider;
    return {
      provider,
      model: typeof parsed.model === "string" ? parsed.model : "",
    };
  }

  saveSettings(patch: Partial<ProviderSettings>): ProviderSettings {
    const next: ProviderSettings = {
      ...this.getSettings(),
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.model !== undefined ? { model: patch.model.trim() } : {}),
    };
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('provider', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
    return next;
  }

  // ── Campaigns & Full Snapshot ────────────────────────────────────────────
  listCampaigns(): CampaignSummary[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, subtitle, event_date, start_date, post_weeks, date_tentative, tentative_note, pacing, updated_at FROM campaigns ORDER BY updated_at DESC",
      )
      .all() as Array<{
      id: string;
      name: string;
      subtitle: string;
      event_date: string;
      start_date: string;
      post_weeks: number;
      date_tentative?: number;
      tentative_note?: string;
      pacing: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      subtitle: r.subtitle,
      eventDate: r.event_date,
      startDate: r.start_date,
      postWeeks: r.post_weeks,
      dateTentative: Boolean(r.date_tentative),
      tentativeNote: String(r.tentative_note ?? ""),
      pacing: (PACING_LEVELS as readonly string[]).includes(r.pacing) ? (r.pacing as PacingLevel) : "balanced",
      updatedAt: r.updated_at,
    }));
  }

  getDefaultCampaignId(): string {
    const first = this.listCampaigns()[0];
    if (!first) throw new AppError(404, "尚未建立任何活動專案。");
    return first.id;
  }

  getSnapshot(campaignId?: string): CampaignSnapshot {
    const targetId = campaignId || this.getDefaultCampaignId();
    const row = this.db
      .prepare("SELECT * FROM campaigns WHERE id = ?")
      .get(targetId) as
      | {
          id: string;
          name: string;
          subtitle: string;
          brief?: string;
          event_date: string;
          start_date: string;
          post_weeks: number;
          date_tentative?: number;
          tentative_note?: string;
          pacing: string;
          main_goal: string;
          monthly_goals_json: string;
          sheet_url: string;
          slides_url: string;
          updated_at: string;
        }
      | undefined;

    if (!row) throw new AppError(404, "找不到指定的活動專案。");

    const campaign: CampaignMeta = {
      id: row.id,
      name: row.name,
      subtitle: row.subtitle,
      brief: String(row.brief ?? ""),
      eventDate: row.event_date,
      startDate: row.start_date,
      postWeeks: row.post_weeks,
      dateTentative: Boolean(row.date_tentative),
      tentativeNote: String(row.tentative_note ?? ""),
      pacing: (PACING_LEVELS as readonly string[]).includes(row.pacing) ? (row.pacing as PacingLevel) : "balanced",
      mainGoal: row.main_goal,
      monthlyGoals: safeJsonParse<MonthlyGoal[]>(row.monthly_goals_json, []),
      sheetUrl: row.sheet_url,
      slidesUrl: row.slides_url,
      updatedAt: row.updated_at,
    };

    const weeks = (
      this.db
        .prepare("SELECT * FROM weeks WHERE campaign_id = ? ORDER BY order_index ASC")
        .all(targetId) as Array<Record<string, unknown>>
    ).map((w) => ({
      id: String(w.id),
      campaignId: String(w.campaign_id),
      orderIndex: Number(w.order_index),
      monthLabel: String(w.month_label),
      dateRange: String(w.date_range),
      startDate: String(w.start_date ?? ""),
      endDate: String(w.end_date ?? ""),
      countdownLabel: String(w.countdown_label),
      phase: (["prep", "event", "post"].includes(String(w.phase)) ? w.phase : "prep") as "prep" | "event" | "post",
      stage: ((CELL_STAGES as readonly string[]).includes(String(w.stage)) ? w.stage : "待排") as CellStage,
      majorEvents: safeJsonParse<WeekEventItem[]>(String(w.major_events_json ?? "[]"), []),
      memo: String(w.memo ?? ""),
      progressOverride: w.progress_override === null || w.progress_override === undefined ? null : Number(w.progress_override),
    }));

    const teams = (
      this.db
        .prepare("SELECT * FROM teams WHERE campaign_id = ? ORDER BY order_index ASC")
        .all(targetId) as Array<Record<string, unknown>>
    ).map((t) => ({
      id: String(t.id),
      campaignId: String(t.campaign_id),
      name: String(t.name),
      lead: String(t.lead ?? ""),
      color: ((TEAM_COLORS as readonly string[]).includes(String(t.color)) ? t.color : "rose") as TeamColor,
      targetHeadcount: Number(t.target_headcount ?? 6),
      orderIndex: Number(t.order_index),
    }));

    const cells = (
      this.db
        .prepare(
          `SELECT c.* FROM cells c
           JOIN weeks w ON w.id = c.week_id
           WHERE w.campaign_id = ?`,
        )
        .all(targetId) as Array<Record<string, unknown>>
    ).map((c) => ({
      weekId: String(c.week_id),
      teamId: String(c.team_id),
      stage: ((CELL_STAGES as readonly string[]).includes(String(c.stage)) ? c.stage : "待排") as CellStage,
      weeklyFocus: String(c.weekly_focus ?? ""),
      crossTeam: String(c.cross_team ?? ""),
      updatedAt: String(c.updated_at),
    }));

    const todos = (
      this.db
        .prepare("SELECT * FROM todos WHERE campaign_id = ? ORDER BY done ASC, due_date ASC, created_at ASC")
        .all(targetId) as Array<Record<string, unknown>>
    ).map((t) => ({
      id: String(t.id),
      campaignId: String(t.campaign_id),
      teamId: String(t.team_id),
      weekId: t.week_id ? String(t.week_id) : null,
      title: String(t.title),
      assignee: String(t.assignee ?? ""),
      done: Boolean(t.done),
      priority: (t.priority === "high" ? "high" : "normal") as "normal" | "high",
      dueDate: String(t.due_date ?? ""),
      createdAt: String(t.created_at),
      updatedAt: String(t.updated_at),
    }));

    const notes = (
      this.db
        .prepare("SELECT * FROM notes WHERE campaign_id = ? ORDER BY pinned DESC, updated_at DESC")
        .all(targetId) as Array<Record<string, unknown>>
    ).map((n) => ({
      id: String(n.id),
      campaignId: String(n.campaign_id),
      title: String(n.title),
      body: String(n.body ?? ""),
      tags: safeJsonParse<string[]>(String(n.tags_json ?? "[]"), []),
      pinned: Boolean(n.pinned),
      updatedAt: String(n.updated_at),
    }));

    const files = (
      this.db
        .prepare("SELECT * FROM files WHERE campaign_id = ? ORDER BY updated_at DESC")
        .all(targetId) as Array<Record<string, unknown>>
    ).map((f) => ({
      id: String(f.id),
      campaignId: String(f.campaign_id),
      title: String(f.title),
      category: ((FILE_CATEGORIES as readonly string[]).includes(String(f.category)) ? f.category : "other") as FileCategory,
      teamId: f.team_id ? String(f.team_id) : null,
      kind: (f.kind === "upload" ? "upload" : "generated") as "upload" | "generated",
      mimeType: String(f.mime_type),
      fileName: String(f.file_name),
      sizeBytes: Number(f.size_bytes ?? 0),
      contentMd: String(f.content_md ?? ""),
      templateKind: (f.template_kind ? String(f.template_kind) : null) as HandbookTemplate | null,
      createdAt: String(f.created_at),
      updatedAt: String(f.updated_at),
    }));

    const meetings = (
      this.db
        .prepare("SELECT * FROM meetings WHERE campaign_id = ? ORDER BY meeting_date DESC, updated_at DESC")
        .all(targetId) as Array<Record<string, unknown>>
    ).map((m) => ({
      id: String(m.id),
      campaignId: String(m.campaign_id),
      title: String(m.title),
      meetingDate: String(m.meeting_date),
      attendees: String(m.attendees ?? ""),
      agenda: String(m.agenda ?? ""),
      arrangements: String(m.arrangements ?? ""),
      precautions: String(m.precautions ?? ""),
      decisions: String(m.decisions ?? ""),
      docUrl: String(m.doc_url ?? ""),
      docSource: (["gdoc", "hackmd", "markdown"].includes(String(m.doc_source)) ? m.doc_source : "") as MeetingDocSource,
      updatedAt: String(m.updated_at),
    }));

    const partners: CampaignPartner[] = (
      this.db
        .prepare("SELECT * FROM partners WHERE campaign_id = ? ORDER BY kind ASC, updated_at DESC")
        .all(targetId) as Array<Record<string, unknown>>
    ).map((p) => ({
      id: String(p.id),
      campaignId: String(p.campaign_id),
      kind: ((PARTNER_KINDS as readonly string[]).includes(String(p.kind)) ? p.kind : "speaker") as PartnerKind,
      name: String(p.name),
      organization: String(p.organization ?? ""),
      roleOrTopic: String(p.role_or_topic ?? ""),
      contact: String(p.contact ?? ""),
      teamId: p.team_id ? String(p.team_id) : null,
      status: ((PARTNER_STATUSES as readonly string[]).includes(String(p.status)) ? p.status : "prospect") as PartnerStatus,
      shiftOrFee: String(p.shift_or_fee ?? ""),
      notes: String(p.notes ?? ""),
      tasks: safeJsonParse<TempStaffTask[]>(String(p.tasks_json ?? "[]"), []),
      updatedAt: String(p.updated_at),
    }));

    const inspirations: CampaignInspiration[] = (
      this.db
        .prepare("SELECT * FROM inspirations WHERE campaign_id = ? ORDER BY similarity_score DESC, updated_at DESC")
        .all(targetId) as Array<Record<string, unknown>>
    ).map((ins) => ({
      id: String(ins.id),
      campaignId: String(ins.campaign_id),
      title: String(ins.title),
      region: (ins.region === "國際" ? "國際" : "國內") as "國內" | "國際",
      category: String(ins.category ?? ""),
      similarityScore: Number(ins.similarity_score ?? 80),
      whySimilar: String(ins.why_similar ?? ""),
      timelinePattern: String(ins.timeline_pattern ?? ""),
      specialIdeas: safeJsonParse<string[]>(String(ins.special_ideas_json ?? "[]"), []),
      pitfalls: safeJsonParse<string[]>(String(ins.pitfalls_json ?? "[]"), []),
      updatedAt: String(ins.updated_at),
    }));

    const forms = (
      this.db
        .prepare("SELECT * FROM forms WHERE campaign_id = ? ORDER BY updated_at DESC")
        .all(targetId) as Array<Record<string, unknown>>
    ).map((f) => ({
      id: String(f.id),
      campaignId: String(f.campaign_id),
      title: String(f.title),
      sourceUrl: String(f.source_url ?? ""),
      sheetSyncUrl: String(f.sheet_sync_url ?? ""),
      lastSyncedAt: String(f.last_synced_at ?? ""),
      status: (f.status === "closed" ? "closed" : "open") as "open" | "closed",
      description: String(f.description ?? ""),
      updatedAt: String(f.updated_at),
    }));

    const formIds = forms.map((f) => f.id);
    const formResponses: FormResponseItem[] =
      formIds.length === 0
        ? []
        : (
            this.db
              .prepare(
                `SELECT r.* FROM form_responses r
                 JOIN forms f ON f.id = r.form_id
                 WHERE f.campaign_id = ?
                 ORDER BY r.submitted_at DESC`,
              )
              .all(targetId) as Array<Record<string, unknown>>
          ).map((r) => ({
            id: String(r.id),
            formId: String(r.form_id),
            applicantName: String(r.applicant_name),
            email: String(r.email ?? ""),
            handle: String(r.handle ?? ""),
            preferredTeamId: String(r.preferred_team_id),
            secondaryTeamId: r.secondary_team_id ? String(r.secondary_team_id) : null,
            roleType: ((APPLICANT_ROLES as readonly string[]).includes(String(r.role_type)) ? r.role_type : "staff") as ApplicantRole,
            skills: safeJsonParse<string[]>(String(r.skills_json ?? "[]"), []),
            availability: safeJsonParse<string[]>(String(r.availability_json ?? "[]"), []),
            experience: String(r.experience ?? ""),
            dietaryOrShirt: String(r.dietary_or_shirt ?? ""),
            status: ((APPLICANT_STATUSES as readonly string[]).includes(String(r.status)) ? r.status : "pending") as ApplicantStatus,
            reviewerNote: String(r.reviewer_note ?? ""),
            submittedAt: String(r.submitted_at),
          }));

    const botMessages = (
      this.db
        .prepare("SELECT * FROM bot_messages WHERE campaign_id = ? ORDER BY created_at ASC")
        .all(targetId) as Array<Record<string, unknown>>
    ).map((b) => ({
      id: String(b.id),
      campaignId: String(b.campaign_id),
      role: (b.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: String(b.content),
      proposals: safeJsonParse<BotActionProposal[]>(String(b.proposals_json ?? "[]"), []),
      createdAt: String(b.created_at),
    }));

    return {
      campaign,
      campaigns: this.listCampaigns(),
      weeks,
      teams,
      cells,
      todos,
      notes,
      files,
      meetings,
      partners,
      inspirations,
      forms,
      formResponses,
      botMessages,
      settings: this.getSettings(),
    };
  }

  createCampaign(input: {
    name: string;
    subtitle?: string;
    brief?: string;
    eventDate: string;
    startDate?: string;
    prepWeeks?: number;
    postWeeks?: number;
    dateTentative?: boolean;
    tentativeNote?: string;
  }): CampaignSnapshot {
    const now = new Date().toISOString();
    const id = `camp-${randomUUID().slice(0, 8)}`;
    const dateTentative = Boolean(input.dateTentative);
    const tentativeNote = (input.tentativeNote ?? "").trim();
    const timeline = buildWeeklyTimelineDefs({
      eventDate: input.eventDate,
      startDate: input.startDate,
      prepWeeks: input.prepWeeks,
      postWeeks: input.postWeeks,
      dateTentative,
    });
    const brief = (input.brief ?? "").trim();

    this.db
      .prepare(
        `INSERT INTO campaigns (id, name, subtitle, brief, event_date, start_date, post_weeks, date_tentative, tentative_note, pacing, main_goal, monthly_goals_json, sheet_url, slides_url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'balanced', ?, '[]', '', '', ?)`,
      )
      .run(
        id,
        input.name.trim(),
        (input.subtitle ?? "").trim(),
        brief,
        input.eventDate,
        timeline.startIso,
        timeline.postWeeks,
        dateTentative ? 1 : 0,
        tentativeNote,
        brief,
        now,
      );

    const insertWeek = this.db.prepare(
      `INSERT INTO weeks (id, campaign_id, order_index, month_label, date_range, start_date, end_date, countdown_label, phase, stage, major_events_json, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '')`,
    );

    for (const wk of timeline.weeks) {
      insertWeek.run(
        `wk-${randomUUID().slice(0, 8)}`,
        id,
        wk.orderIndex,
        wk.monthLabel,
        wk.dateRange,
        wk.startDate,
        wk.endDate,
        wk.countdownLabel,
        wk.phase,
        wk.stage,
      );
    }

    const isCtfOrSecurity = /ctf|資安|出題|靶機|攻防/i.test(`${input.name} ${input.subtitle ?? ""} ${brief}`);
    const defaultTeams: Array<{ name: string; color: TeamColor }> = isCtfOrSecurity
      ? [
          { name: "出題組", color: "violet" },
          { name: "Infra 組", color: "sky" },
          { name: "行政與廠商公關組", color: "rose" },
          { name: "各校社團與資格審核組", color: "mint" },
        ]
      : [
          { name: "議程企劃組", color: "violet" },
          { name: "行銷設計組", color: "rose" },
          { name: "場務志工組", color: "mint" },
        ];
    const insertTeam = this.db.prepare(
      `INSERT INTO teams (id, campaign_id, name, lead, color, target_headcount, order_index)
       VALUES (?, ?, ?, '', ?, 5, ?)`,
    );
    defaultTeams.forEach((t, idx) => insertTeam.run(`tm-${randomUUID().slice(0, 8)}`, id, t.name, t.color, idx));

    this.db
      .prepare(
        `INSERT INTO forms (id, campaign_id, title, source_url, status, description, updated_at)
         VALUES (?, ?, ?, '', 'open', '收集籌備夥伴與當日志工報名回覆。', ?)`,
      )
      .run(`form-${randomUUID().slice(0, 8)}`, id, `${input.name.trim()} · 招工表單`, now);

    this.seedInspirationsForCampaign(id, {
      name: input.name.trim(),
      subtitle: (input.subtitle ?? "").trim(),
      brief,
      mainGoal: brief,
      teamNames: defaultTeams.map((t) => t.name),
    });

    const dateDesc = formatCampaignDateLabel({
      eventDate: input.eventDate,
      dateTentative,
      tentativeNote,
    });
    const onboardingWelcome = brief
      ? `歡迎開啟新專案「**${input.name.trim()}**」（${dateDesc} · 已展開 **倒數 ${timeline.prepCount} 週** 長程時程）！我已讀到你的初步構想：「${brief}」，並先幫你策展了匹配的**靈感借鏡**活動案例。\n\n接下來想請你跟我聊聊：\n1. **預計參與人數與核心受眾**是誰？\n2. 活動形式或每月里程碑有沒有特別規劃？\n3. 有沒有已知的**死線或撞期時段**？\n\n直接回覆我，我就會為你量身設定專案性質、組別分工與靈感借鏡方向！`
      : `歡迎開啟新專案「**${input.name.trim()}**」（${dateDesc} · 已展開 **倒數 ${timeline.prepCount} 週** 時程）！\n\n在開始細排之前，先跟我聊聊這場活動主要想做什麼吧：\n- **活動形式與規模**（例如：跨校資安競賽、百人技術論壇、校園黑客松、品牌體驗展…）\n- **最想達成的核心體驗或各月目標**\n\n告訴我之後，我會直接幫你規劃專案定位、配置適合的組別與節奏，並在「**靈感借鏡**」頁面整理國內外相似活動的亮點與避坑提醒！`;

    this.db
      .prepare(
        `INSERT INTO bot_messages (id, campaign_id, role, content, proposals_json, created_at)
         VALUES (?, ?, 'assistant', ?, '[]', ?)`,
      )
      .run(`bot-${randomUUID().slice(0, 8)}`, id, onboardingWelcome, now);

    return this.getSnapshot(id);
  }

  /**
   * Expands, shifts, or re-anchors an existing campaign's weekly timeline (up to 52 prep weeks + post weeks)
   * without losing any existing todos, cells, milestones, clashing event flags, or memos.
   */
  rescheduleCampaignTimeline(
    campaignId: string,
    input: {
      eventDate?: string;
      startDate?: string;
      prepWeeks?: number;
      postWeeks?: number;
      dateTentative?: boolean;
      tentativeNote?: string;
    },
  ): CampaignSnapshot {
    const snap = this.getSnapshot(campaignId);
    const cur = snap.campaign;
    const now = new Date().toISOString();
    const nextEventDate = input.eventDate?.trim() || cur.eventDate;
    const nextTentative = input.dateTentative !== undefined ? input.dateTentative : cur.dateTentative;
    const nextTentativeNote = input.tentativeNote !== undefined ? input.tentativeNote.trim() : cur.tentativeNote;
    const nextPostWeeks = input.postWeeks !== undefined ? input.postWeeks : cur.postWeeks;

    const timeline = buildWeeklyTimelineDefs({
      eventDate: nextEventDate,
      startDate: input.startDate,
      prepWeeks: input.prepWeeks,
      postWeeks: nextPostWeeks,
      dateTentative: nextTentative,
    });

    const oldWeeks = [...snap.weeks].sort((a, b) => a.orderIndex - b.orderIndex);
    const claimedOldIds = new Set<string>();
    const matchedOldByNewIdx = new Map<number, CampaignWeek>();

    // Pass 1: Match by calendar week proximity (within ±4 days) so dated tasks/conflicts stay on their real calendar week
    timeline.weeks.forEach((def, newIdx) => {
      const targetMs = Date.parse(`${def.startDate}T00:00:00Z`);
      let bestOld: CampaignWeek | null = null;
      let bestDiff = Infinity;
      for (const ow of oldWeeks) {
        if (claimedOldIds.has(ow.id) || !ow.startDate) continue;
        const diff = Math.abs(Date.parse(`${ow.startDate}T00:00:00Z`) - targetMs);
        if (diff <= 4 * 86400_000 && diff < bestDiff) {
          bestDiff = diff;
          bestOld = ow;
        }
      }
      if (bestOld) {
        claimedOldIds.add(bestOld.id);
        matchedOldByNewIdx.set(newIdx, bestOld);
      }
    });

    // Pass 2: Match event / post weeks if the event date shifted beyond ±4 days
    const newEventIdx = timeline.weeks.findIndex((w) => w.phase === "event");
    const oldEventWeek = oldWeeks.find((w) => w.phase === "event" && !claimedOldIds.has(w.id));
    if (newEventIdx >= 0 && oldEventWeek && !matchedOldByNewIdx.has(newEventIdx)) {
      claimedOldIds.add(oldEventWeek.id);
      matchedOldByNewIdx.set(newEventIdx, oldEventWeek);
    }

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE campaigns
           SET event_date = ?, start_date = ?, post_weeks = ?, date_tentative = ?, tentative_note = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          nextEventDate,
          timeline.startIso,
          timeline.postWeeks,
          nextTentative ? 1 : 0,
          nextTentativeNote,
          now,
          campaignId,
        );

      const updateWeekStmt = this.db.prepare(
        `UPDATE weeks
         SET order_index = ?, month_label = ?, date_range = ?, start_date = ?, end_date = ?, countdown_label = ?, phase = ?, stage = ?
         WHERE id = ?`,
      );
      const insertWeekStmt = this.db.prepare(
        `INSERT INTO weeks (id, campaign_id, order_index, month_label, date_range, start_date, end_date, countdown_label, phase, stage, major_events_json, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '')`,
      );

      const newWeekIds: string[] = [];
      timeline.weeks.forEach((def, idx) => {
        const matched = matchedOldByNewIdx.get(idx);
        if (matched) {
          updateWeekStmt.run(
            def.orderIndex,
            def.monthLabel,
            def.dateRange,
            def.startDate,
            def.endDate,
            def.countdownLabel,
            def.phase,
            def.stage,
            matched.id,
          );
          newWeekIds.push(matched.id);
        } else {
          const freshId = `wk-${randomUUID().slice(0, 8)}`;
          insertWeekStmt.run(
            freshId,
            campaignId,
            def.orderIndex,
            def.monthLabel,
            def.dateRange,
            def.startDate,
            def.endDate,
            def.countdownLabel,
            def.phase,
            def.stage,
          );
          newWeekIds.push(freshId);
        }
      });

      // Preserve any todos, cells, events, and memos from retired weeks before deleting them
      for (const ow of oldWeeks) {
        if (claimedOldIds.has(ow.id)) continue;
        const owMs = ow.startDate ? Date.parse(`${ow.startDate}T00:00:00Z`) : 0;
        const firstMs = Date.parse(`${timeline.weeks[0].startDate}T00:00:00Z`);
        const fallbackWeekId = owMs && owMs < firstMs ? newWeekIds[0] : newWeekIds[newWeekIds.length - 1];

        this.db.prepare("UPDATE todos SET week_id = ? WHERE week_id = ?").run(fallbackWeekId, ow.id);

        const orphanCells = snap.cells.filter((c) => c.weekId === ow.id && (c.weeklyFocus.trim() || c.crossTeam.trim()));
        for (const oc of orphanCells) {
          const destExists = this.db
            .prepare("SELECT weekly_focus FROM cells WHERE week_id = ? AND team_id = ?")
            .get(fallbackWeekId, oc.teamId) as { weekly_focus?: string } | undefined;
          if (!destExists || !destExists.weekly_focus?.trim()) {
            this.upsertCell({
              weekId: fallbackWeekId,
              teamId: oc.teamId,
              stage: oc.stage,
              weeklyFocus: oc.weeklyFocus,
              crossTeam: oc.crossTeam,
            });
          }
        }

        if (ow.majorEvents.length > 0 || ow.memo.trim()) {
          const destRow = this.db
            .prepare("SELECT major_events_json, memo FROM weeks WHERE id = ?")
            .get(fallbackWeekId) as { major_events_json?: string; memo?: string } | undefined;
          const destEvents = safeJsonParse<WeekEventItem[]>(destRow?.major_events_json, []);
          const mergedEvents = [...destEvents, ...ow.majorEvents].slice(0, 12);
          const mergedMemo = [destRow?.memo?.trim(), ow.memo.trim()].filter(Boolean).join("；").slice(0, 300);
          this.db
            .prepare("UPDATE weeks SET major_events_json = ?, memo = ? WHERE id = ?")
            .run(JSON.stringify(mergedEvents), mergedMemo, fallbackWeekId);
        }

        this.db.prepare("DELETE FROM weeks WHERE id = ?").run(ow.id);
      }

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return this.getSnapshot(campaignId);
  }

  updateCampaignMeta(
    campaignId: string,
    patch: Partial<
      Pick<
        CampaignMeta,
        | "name"
        | "subtitle"
        | "brief"
        | "eventDate"
        | "dateTentative"
        | "tentativeNote"
        | "pacing"
        | "mainGoal"
        | "monthlyGoals"
        | "sheetUrl"
        | "slidesUrl"
      >
    >,
  ): CampaignMeta {
    const snap = this.getSnapshot(campaignId);
    const cur = snap.campaign;
    const now = new Date().toISOString();
    const next: CampaignMeta = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name.trim() || cur.name } : {}),
      ...(patch.subtitle !== undefined ? { subtitle: patch.subtitle.trim() } : {}),
      ...(patch.brief !== undefined ? { brief: patch.brief.trim() } : {}),
      ...(patch.eventDate !== undefined ? { eventDate: patch.eventDate.trim() || cur.eventDate } : {}),
      ...(patch.dateTentative !== undefined ? { dateTentative: patch.dateTentative } : {}),
      ...(patch.tentativeNote !== undefined ? { tentativeNote: patch.tentativeNote.trim() } : {}),
      ...(patch.pacing !== undefined ? { pacing: patch.pacing } : {}),
      ...(patch.mainGoal !== undefined ? { mainGoal: patch.mainGoal } : {}),
      ...(patch.monthlyGoals !== undefined ? { monthlyGoals: patch.monthlyGoals } : {}),
      ...(patch.sheetUrl !== undefined ? { sheetUrl: patch.sheetUrl.trim() } : {}),
      ...(patch.slidesUrl !== undefined ? { slidesUrl: patch.slidesUrl.trim() } : {}),
      updatedAt: now,
    };

    this.db
      .prepare(
        `UPDATE campaigns
         SET name = ?, subtitle = ?, brief = ?, event_date = ?, date_tentative = ?, tentative_note = ?, pacing = ?, main_goal = ?, monthly_goals_json = ?, sheet_url = ?, slides_url = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.subtitle,
        next.brief,
        next.eventDate,
        next.dateTentative ? 1 : 0,
        next.tentativeNote,
        next.pacing,
        next.mainGoal,
        JSON.stringify(next.monthlyGoals),
        next.sheetUrl,
        next.slidesUrl,
        now,
        campaignId,
      );
    return next;
  }

  // ── Weeks, Teams & Matrix Cells ──────────────────────────────────────────
  addWeek(
    campaignId: string,
    input: { monthLabel: string; dateRange: string; countdownLabel: string; phase: "prep" | "event" | "post"; stage?: CellStage },
  ): CampaignWeek {
    const maxRow = this.db
      .prepare("SELECT COALESCE(MAX(order_index), -1) AS max_idx FROM weeks WHERE campaign_id = ?")
      .get(campaignId) as { max_idx: number };
    const id = `wk-${randomUUID().slice(0, 8)}`;
    const orderIndex = maxRow.max_idx + 1;
    const stage: CellStage =
      input.stage ?? (input.phase === "event" ? "活動" : input.phase === "post" ? "復盤" : "待排");
    this.db
      .prepare(
        `INSERT INTO weeks (id, campaign_id, order_index, month_label, date_range, countdown_label, phase, stage, major_events_json, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '')`,
      )
      .run(id, campaignId, orderIndex, input.monthLabel.trim(), input.dateRange.trim(), input.countdownLabel.trim(), input.phase, stage);
    return {
      id,
      campaignId,
      orderIndex,
      monthLabel: input.monthLabel.trim(),
      dateRange: input.dateRange.trim(),
      startDate: "",
      endDate: "",
      countdownLabel: input.countdownLabel.trim(),
      phase: input.phase,
      stage,
      majorEvents: [],
      memo: "",
      progressOverride: null,
    };
  }

  updateWeek(
    weekId: string,
    patch: {
      monthLabel?: string;
      dateRange?: string;
      countdownLabel?: string;
      phase?: "prep" | "event" | "post";
      stage?: CellStage;
      majorEvents?: WeekEventItem[];
      memo?: string;
      progressOverride?: number | null;
    },
  ): void {
    const existing = this.db.prepare("SELECT * FROM weeks WHERE id = ?").get(weekId) as Record<string, unknown> | undefined;
    if (!existing) throw new AppError(404, "找不到指定的週次欄位。");

    const monthLabel = patch.monthLabel !== undefined ? patch.monthLabel.trim() : String(existing.month_label);
    const dateRange = patch.dateRange !== undefined ? patch.dateRange.trim() : String(existing.date_range);
    const countdownLabel = patch.countdownLabel !== undefined ? patch.countdownLabel.trim() : String(existing.countdown_label);
    const phase = patch.phase !== undefined ? patch.phase : String(existing.phase);
    const stage =
      patch.stage !== undefined
        ? patch.stage
        : (CELL_STAGES as readonly string[]).includes(String(existing.stage))
          ? String(existing.stage)
          : "待排";
    const majorEvents =
      patch.majorEvents !== undefined
        ? JSON.stringify(patch.majorEvents)
        : String(existing.major_events_json ?? "[]");
    const memo = patch.memo !== undefined ? patch.memo : String(existing.memo ?? "");
    const progressOverride =
      patch.progressOverride !== undefined
        ? patch.progressOverride
        : existing.progress_override === null
          ? null
          : Number(existing.progress_override);

    this.db
      .prepare(
        `UPDATE weeks
         SET month_label = ?, date_range = ?, countdown_label = ?, phase = ?, stage = ?, major_events_json = ?, memo = ?, progress_override = ?
         WHERE id = ?`,
      )
      .run(monthLabel, dateRange, countdownLabel, phase, stage, majorEvents, memo, progressOverride, weekId);
  }

  addTeam(
    campaignId: string,
    input: { name: string; lead?: string; color?: TeamColor; targetHeadcount?: number },
  ): CampaignTeam {
    const maxRow = this.db
      .prepare("SELECT COALESCE(MAX(order_index), -1) AS max_idx FROM teams WHERE campaign_id = ?")
      .get(campaignId) as { max_idx: number };
    const id = `tm-${randomUUID().slice(0, 8)}`;
    const orderIndex = maxRow.max_idx + 1;
    const color = input.color ?? TEAM_COLORS[orderIndex % TEAM_COLORS.length];
    const targetHeadcount = Math.max(1, Math.min(100, input.targetHeadcount ?? 5));
    this.db
      .prepare(
        `INSERT INTO teams (id, campaign_id, name, lead, color, target_headcount, order_index)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, campaignId, input.name.trim(), (input.lead ?? "").trim(), color, targetHeadcount, orderIndex);
    return {
      id,
      campaignId,
      name: input.name.trim(),
      lead: (input.lead ?? "").trim(),
      color,
      targetHeadcount,
      orderIndex,
    };
  }

  updateTeam(
    teamId: string,
    patch: { name?: string; lead?: string; color?: TeamColor; targetHeadcount?: number },
  ): void {
    const existing = this.db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId) as Record<string, unknown> | undefined;
    if (!existing) throw new AppError(404, "找不到指定的組別。");
    this.db
      .prepare("UPDATE teams SET name = ?, lead = ?, color = ?, target_headcount = ? WHERE id = ?")
      .run(
        patch.name !== undefined ? patch.name.trim() || String(existing.name) : String(existing.name),
        patch.lead !== undefined ? patch.lead.trim() : String(existing.lead ?? ""),
        patch.color ?? String(existing.color),
        patch.targetHeadcount !== undefined ? Math.max(1, patch.targetHeadcount) : Number(existing.target_headcount ?? 5),
        teamId,
      );
  }

  deleteTeam(teamId: string): void {
    this.db.prepare("DELETE FROM teams WHERE id = ?").run(teamId);
  }

  upsertCell(input: { weekId: string; teamId: string; stage: CellStage; weeklyFocus: string; crossTeam: string }): ScheduleCell {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO cells (week_id, team_id, stage, weekly_focus, cross_team, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(week_id, team_id) DO UPDATE SET
           stage = excluded.stage,
           weekly_focus = excluded.weekly_focus,
           cross_team = excluded.cross_team,
           updated_at = excluded.updated_at`,
      )
      .run(input.weekId, input.teamId, input.stage, input.weeklyFocus.trim(), input.crossTeam.trim(), now);
    return {
      weekId: input.weekId,
      teamId: input.teamId,
      stage: input.stage,
      weeklyFocus: input.weeklyFocus.trim(),
      crossTeam: input.crossTeam.trim(),
      updatedAt: now,
    };
  }

  // ── Todos ────────────────────────────────────────────────────────────────
  addTodo(
    campaignId: string,
    input: {
      teamId: string;
      weekId?: string | null;
      title: string;
      assignee?: string;
      priority?: "normal" | "high";
      dueDate?: string;
    },
  ): CampaignTodo {
    const now = new Date().toISOString();
    const id = `todo-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO todos (id, campaign_id, team_id, week_id, title, assignee, done, priority, due_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        campaignId,
        input.teamId,
        input.weekId ?? null,
        input.title.trim(),
        (input.assignee ?? "").trim(),
        input.priority ?? "normal",
        (input.dueDate ?? "").trim(),
        now,
        now,
      );
    return {
      id,
      campaignId,
      teamId: input.teamId,
      weekId: input.weekId ?? null,
      title: input.title.trim(),
      assignee: (input.assignee ?? "").trim(),
      done: false,
      priority: input.priority ?? "normal",
      dueDate: (input.dueDate ?? "").trim(),
      createdAt: now,
      updatedAt: now,
    };
  }

  updateTodo(
    todoId: string,
    patch: {
      title?: string;
      done?: boolean;
      teamId?: string;
      weekId?: string | null;
      assignee?: string;
      priority?: "normal" | "high";
      dueDate?: string;
    },
  ): void {
    const existing = this.db.prepare("SELECT * FROM todos WHERE id = ?").get(todoId) as Record<string, unknown> | undefined;
    if (!existing) throw new AppError(404, "找不到指定的待辦事項。");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE todos
         SET title = ?, done = ?, team_id = ?, week_id = ?, assignee = ?, priority = ?, due_date = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.title !== undefined ? patch.title.trim() || String(existing.title) : String(existing.title),
        patch.done !== undefined ? (patch.done ? 1 : 0) : Number(existing.done),
        patch.teamId ?? String(existing.team_id),
        patch.weekId !== undefined ? patch.weekId : existing.week_id ? String(existing.week_id) : null,
        patch.assignee !== undefined ? patch.assignee.trim() : String(existing.assignee ?? ""),
        patch.priority ?? String(existing.priority ?? "normal"),
        patch.dueDate !== undefined ? patch.dueDate.trim() : String(existing.due_date ?? ""),
        now,
        todoId,
      );
  }

  deleteTodo(todoId: string): void {
    this.db.prepare("DELETE FROM todos WHERE id = ?").run(todoId);
  }

  // ── Personal Notes ───────────────────────────────────────────────────────
  saveNote(
    campaignId: string,
    input: { id?: string; title: string; body: string; tags?: string[]; pinned?: boolean },
  ): CampaignNote {
    const now = new Date().toISOString();
    const id = input.id || `note-${randomUUID().slice(0, 8)}`;
    const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 8);
    const pinned = Boolean(input.pinned);

    const exists = this.db.prepare("SELECT id FROM notes WHERE id = ?").get(id);
    if (exists) {
      this.db
        .prepare("UPDATE notes SET title = ?, body = ?, tags_json = ?, pinned = ?, updated_at = ? WHERE id = ?")
        .run(input.title.trim(), input.body, JSON.stringify(tags), pinned ? 1 : 0, now, id);
    } else {
      this.db
        .prepare("INSERT INTO notes (id, campaign_id, title, body, tags_json, pinned, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, campaignId, input.title.trim(), input.body, JSON.stringify(tags), pinned ? 1 : 0, now);
    }
    return { id, campaignId, title: input.title.trim(), body: input.body, tags, pinned, updatedAt: now };
  }

  deleteNote(noteId: string): void {
    this.db.prepare("DELETE FROM notes WHERE id = ?").run(noteId);
  }

  // ── Files & Generated Handbooks ──────────────────────────────────────────
  createUploadedFile(
    campaignId: string,
    input: {
      title: string;
      category: FileCategory;
      teamId?: string | null;
      fileName: string;
      mimeType: string;
      bytes: Buffer;
    },
  ): CampaignFile {
    const now = new Date().toISOString();
    const id = `file-${randomUUID().slice(0, 8)}`;
    const safeExt = (extname(input.fileName) || ".bin").replace(/[^.a-zA-Z0-9]/g, "").slice(0, 10) || ".bin";
    let diskPath: string | null = null;
    if (this.uploadDir) {
      diskPath = join(this.uploadDir, `${id}${safeExt}`);
      writeFileSync(diskPath, input.bytes);
    }
    const inlineText =
      input.mimeType.startsWith("text/") || input.mimeType === "application/json"
        ? input.bytes.toString("utf8").slice(0, 80_000)
        : "";

    this.db
      .prepare(
        `INSERT INTO files (id, campaign_id, title, category, team_id, kind, mime_type, file_name, disk_path, size_bytes, content_md, template_kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'upload', ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        campaignId,
        input.title.trim(),
        input.category,
        input.teamId ?? null,
        input.mimeType,
        input.fileName,
        diskPath,
        input.bytes.byteLength,
        inlineText,
        now,
        now,
      );

    return {
      id,
      campaignId,
      title: input.title.trim(),
      category: input.category,
      teamId: input.teamId ?? null,
      kind: "upload",
      mimeType: input.mimeType,
      fileName: input.fileName,
      sizeBytes: input.bytes.byteLength,
      contentMd: inlineText,
      templateKind: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  saveGeneratedDoc(
    campaignId: string,
    input: {
      id?: string;
      title: string;
      category?: FileCategory;
      teamId?: string | null;
      contentMd: string;
      templateKind?: HandbookTemplate | null;
    },
  ): CampaignFile {
    const now = new Date().toISOString();
    const id = input.id || `file-${randomUUID().slice(0, 8)}`;
    const category = input.category ?? "handbook";
    const fileName = `${input.title.trim().replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || "document"}.md`;
    const sizeBytes = Buffer.byteLength(input.contentMd, "utf8");

    const exists = this.db.prepare("SELECT id FROM files WHERE id = ?").get(id);
    if (exists) {
      this.db
        .prepare("UPDATE files SET title = ?, category = ?, team_id = ?, content_md = ?, size_bytes = ?, updated_at = ? WHERE id = ?")
        .run(input.title.trim(), category, input.teamId ?? null, input.contentMd, sizeBytes, now, id);
    } else {
      this.db
        .prepare(
          `INSERT INTO files (id, campaign_id, title, category, team_id, kind, mime_type, file_name, disk_path, size_bytes, content_md, template_kind, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'generated', 'text/markdown', ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          campaignId,
          input.title.trim(),
          category,
          input.teamId ?? null,
          fileName,
          sizeBytes,
          input.contentMd,
          input.templateKind ?? null,
          now,
          now,
        );
    }

    return {
      id,
      campaignId,
      title: input.title.trim(),
      category,
      teamId: input.teamId ?? null,
      kind: "generated",
      mimeType: "text/markdown",
      fileName,
      sizeBytes,
      contentMd: input.contentMd,
      templateKind: input.templateKind ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  getRawFileBytes(fileId: string): { mimeType: string; fileName: string; bytes: Buffer } {
    const row = this.db.prepare("SELECT * FROM files WHERE id = ?").get(fileId) as Record<string, unknown> | undefined;
    if (!row) throw new AppError(404, "找不到指定的檔案。");
    const mimeType = String(row.mime_type);
    const fileName = String(row.file_name);
    const diskPath = row.disk_path ? String(row.disk_path) : null;
    if (diskPath && existsSync(diskPath)) {
      return { mimeType, fileName, bytes: readFileSync(diskPath) };
    }
    return {
      mimeType: mimeType || "text/markdown; charset=utf-8",
      fileName,
      bytes: Buffer.from(String(row.content_md ?? ""), "utf8"),
    };
  }

  deleteFile(fileId: string): void {
    const row = this.db.prepare("SELECT disk_path FROM files WHERE id = ?").get(fileId) as { disk_path?: string | null } | undefined;
    if (row?.disk_path && existsSync(row.disk_path)) {
      rmSync(row.disk_path, { force: true });
    }
    this.db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
  }

  // ── Meetings ─────────────────────────────────────────────────────────────
  getMeetingById(meetingId: string): { meeting: CampaignMeeting; campaignName: string } {
    const row = this.db
      .prepare(
        `SELECT m.*, c.name AS campaign_name
         FROM meetings m
         JOIN campaigns c ON c.id = m.campaign_id
         WHERE m.id = ?`,
      )
      .get(meetingId) as Record<string, unknown> | undefined;
    if (!row) throw new AppError(404, "找不到指定的會議記錄。");
    return {
      campaignName: String(row.campaign_name ?? "BELL Campaign"),
      meeting: {
        id: String(row.id),
        campaignId: String(row.campaign_id),
        title: String(row.title),
        meetingDate: String(row.meeting_date),
        attendees: String(row.attendees ?? ""),
        agenda: String(row.agenda ?? ""),
        arrangements: String(row.arrangements ?? ""),
        precautions: String(row.precautions ?? ""),
        decisions: String(row.decisions ?? ""),
        docUrl: String(row.doc_url ?? ""),
        docSource: (["gdoc", "hackmd", "markdown"].includes(String(row.doc_source)) ? row.doc_source : "") as MeetingDocSource,
        updatedAt: String(row.updated_at),
      },
    };
  }

  saveMeeting(
    campaignId: string,
    input: {
      id?: string;
      title: string;
      meetingDate: string;
      attendees: string;
      agenda: string;
      arrangements: string;
      precautions: string;
      decisions: string;
      docUrl?: string;
      docSource?: MeetingDocSource;
    },
  ): CampaignMeeting {
    const now = new Date().toISOString();
    const id = input.id || `mtg-${randomUUID().slice(0, 8)}`;
    const existing = this.db.prepare("SELECT doc_url, doc_source FROM meetings WHERE id = ?").get(id) as
      | { doc_url?: string; doc_source?: string }
      | undefined;
    const docUrl = input.docUrl !== undefined ? input.docUrl.trim() : String(existing?.doc_url ?? "");
    const docSource: MeetingDocSource =
      input.docSource !== undefined
        ? input.docSource
        : (["gdoc", "hackmd", "markdown"].includes(String(existing?.doc_source ?? ""))
            ? (existing?.doc_source as MeetingDocSource)
            : "");

    if (existing) {
      this.db
        .prepare(
          `UPDATE meetings
           SET title = ?, meeting_date = ?, attendees = ?, agenda = ?, arrangements = ?, precautions = ?, decisions = ?, doc_url = ?, doc_source = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.title.trim(),
          input.meetingDate.trim(),
          input.attendees.trim(),
          input.agenda,
          input.arrangements,
          input.precautions,
          input.decisions,
          docUrl,
          docSource,
          now,
          id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO meetings (id, campaign_id, title, meeting_date, attendees, agenda, arrangements, precautions, decisions, doc_url, doc_source, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          campaignId,
          input.title.trim(),
          input.meetingDate.trim(),
          input.attendees.trim(),
          input.agenda,
          input.arrangements,
          input.precautions,
          input.decisions,
          docUrl,
          docSource,
          now,
        );
    }
    return {
      id,
      campaignId,
      title: input.title.trim(),
      meetingDate: input.meetingDate.trim(),
      attendees: input.attendees.trim(),
      agenda: input.agenda,
      arrangements: input.arrangements,
      precautions: input.precautions,
      decisions: input.decisions,
      docUrl,
      docSource,
      updatedAt: now,
    };
  }

  deleteMeeting(meetingId: string): void {
    this.db.prepare("DELETE FROM meetings WHERE id = ?").run(meetingId);
  }

  // ── Partners (`#/partners`: 講者 · 合作廠商 · 臨時工) ─────────────────────
  savePartner(
    campaignId: string,
    input: {
      id?: string;
      kind: PartnerKind;
      name: string;
      organization?: string;
      roleOrTopic?: string;
      contact?: string;
      teamId?: string | null;
      status?: PartnerStatus;
      shiftOrFee?: string;
      notes?: string;
      tasks?: TempStaffTask[];
    },
  ): CampaignPartner {
    const now = new Date().toISOString();
    const id = input.id || `pt-${randomUUID().slice(0, 8)}`;
    const existing = this.db.prepare("SELECT * FROM partners WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    const status = input.status ?? ((existing?.status as PartnerStatus | undefined) || "prospect");
    const tasks =
      input.tasks ??
      (existing ? safeJsonParse<TempStaffTask[]>(String(existing.tasks_json ?? "[]"), []) : []);

    if (existing) {
      this.db
        .prepare(
          `UPDATE partners
           SET kind = ?, name = ?, organization = ?, role_or_topic = ?, contact = ?, team_id = ?, status = ?, shift_or_fee = ?, notes = ?, tasks_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.kind,
          input.name.trim(),
          (input.organization ?? "").trim(),
          (input.roleOrTopic ?? "").trim(),
          (input.contact ?? "").trim(),
          input.teamId ?? null,
          status,
          (input.shiftOrFee ?? "").trim(),
          input.notes ?? "",
          JSON.stringify(tasks),
          now,
          id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO partners (id, campaign_id, kind, name, organization, role_or_topic, contact, team_id, status, shift_or_fee, notes, tasks_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          campaignId,
          input.kind,
          input.name.trim(),
          (input.organization ?? "").trim(),
          (input.roleOrTopic ?? "").trim(),
          (input.contact ?? "").trim(),
          input.teamId ?? null,
          status,
          (input.shiftOrFee ?? "").trim(),
          input.notes ?? "",
          JSON.stringify(tasks),
          now,
        );
    }

    return {
      id,
      campaignId,
      kind: input.kind,
      name: input.name.trim(),
      organization: (input.organization ?? "").trim(),
      roleOrTopic: (input.roleOrTopic ?? "").trim(),
      contact: (input.contact ?? "").trim(),
      teamId: input.teamId ?? null,
      status,
      shiftOrFee: (input.shiftOrFee ?? "").trim(),
      notes: input.notes ?? "",
      tasks,
      updatedAt: now,
    };
  }

  patchPartner(
    partnerId: string,
    patch: {
      status?: PartnerStatus;
      teamId?: string | null;
      notes?: string;
      tasks?: TempStaffTask[];
    },
  ): void {
    const existing = this.db.prepare("SELECT * FROM partners WHERE id = ?").get(partnerId) as Record<string, unknown> | undefined;
    if (!existing) throw new AppError(404, "找不到指定的合作名單項目。");
    const now = new Date().toISOString();
    const nextTasks =
      patch.tasks !== undefined
        ? patch.tasks
        : safeJsonParse<TempStaffTask[]>(String(existing.tasks_json ?? "[]"), []);
    this.db
      .prepare(
        `UPDATE partners
         SET status = ?, team_id = ?, notes = ?, tasks_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.status ?? String(existing.status ?? "prospect"),
        patch.teamId !== undefined ? patch.teamId : (existing.team_id ? String(existing.team_id) : null),
        patch.notes !== undefined ? patch.notes : String(existing.notes ?? ""),
        JSON.stringify(nextTasks),
        now,
        partnerId,
      );
  }

  deletePartner(partnerId: string): void {
    this.db.prepare("DELETE FROM partners WHERE id = ?").run(partnerId);
  }

  // ── Inspirations (`#/inspirations`: 靈感借鏡) ────────────────────────────
  replaceInspirations(
    campaignId: string,
    items: Array<Omit<CampaignInspiration, "id" | "campaignId" | "updatedAt">>,
  ): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM inspirations WHERE campaign_id = ?").run(campaignId);
      const ins = this.db.prepare(
        `INSERT INTO inspirations (id, campaign_id, title, region, category, similarity_score, why_similar, timeline_pattern, special_ideas_json, pitfalls_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of items) {
        ins.run(
          `insp-${randomUUID().slice(0, 8)}`,
          campaignId,
          item.title.trim(),
          item.region,
          item.category.trim(),
          Math.max(1, Math.min(99, Math.round(item.similarityScore))),
          item.whySimilar.trim(),
          item.timelinePattern.trim(),
          JSON.stringify(item.specialIdeas),
          JSON.stringify(item.pitfalls),
          now,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  deleteInspiration(inspirationId: string): void {
    this.db.prepare("DELETE FROM inspirations WHERE id = ?").run(inspirationId);
  }

  // ── Recruitment Forms & Responses ────────────────────────────────────────
  updateFormMeta(
    formId: string,
    patch: {
      title?: string;
      sourceUrl?: string;
      sheetSyncUrl?: string;
      lastSyncedAt?: string;
      status?: "open" | "closed";
      description?: string;
    },
  ): void {
    const row = this.db.prepare("SELECT * FROM forms WHERE id = ?").get(formId) as Record<string, unknown> | undefined;
    if (!row) throw new AppError(404, "找不到指定的招工表單。");
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE forms SET title = ?, source_url = ?, sheet_sync_url = ?, last_synced_at = ?, status = ?, description = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.title !== undefined ? patch.title.trim() || String(row.title) : String(row.title),
        patch.sourceUrl !== undefined ? patch.sourceUrl.trim() : String(row.source_url ?? ""),
        patch.sheetSyncUrl !== undefined ? patch.sheetSyncUrl.trim() : String(row.sheet_sync_url ?? ""),
        patch.lastSyncedAt !== undefined ? patch.lastSyncedAt : String(row.last_synced_at ?? ""),
        patch.status ?? String(row.status ?? "open"),
        patch.description !== undefined ? patch.description : String(row.description ?? ""),
        now,
        formId,
      );
  }

  addFormResponse(
    formId: string,
    input: {
      applicantName: string;
      email?: string;
      handle?: string;
      preferredTeamId: string;
      secondaryTeamId?: string | null;
      roleType?: ApplicantRole;
      skills?: string[];
      availability?: string[];
      experience?: string;
      dietaryOrShirt?: string;
    },
  ): FormResponseItem {
    const now = new Date().toISOString();
    const id = `resp-${randomUUID().slice(0, 8)}`;
    const skills = (input.skills ?? []).map((s) => s.trim()).filter(Boolean);
    const availability = (input.availability ?? []).map((s) => s.trim()).filter(Boolean);
    const roleType = input.roleType ?? "staff";

    this.db
      .prepare(
        `INSERT INTO form_responses (id, form_id, applicant_name, email, handle, preferred_team_id, secondary_team_id, role_type, skills_json, availability_json, experience, dietary_or_shirt, status, reviewer_note, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?)`,
      )
      .run(
        id,
        formId,
        input.applicantName.trim(),
        (input.email ?? "").trim(),
        (input.handle ?? "").trim(),
        input.preferredTeamId,
        input.secondaryTeamId ?? null,
        roleType,
        JSON.stringify(skills),
        JSON.stringify(availability),
        (input.experience ?? "").trim(),
        (input.dietaryOrShirt ?? "").trim(),
        now,
      );

    return {
      id,
      formId,
      applicantName: input.applicantName.trim(),
      email: (input.email ?? "").trim(),
      handle: (input.handle ?? "").trim(),
      preferredTeamId: input.preferredTeamId,
      secondaryTeamId: input.secondaryTeamId ?? null,
      roleType,
      skills,
      availability,
      experience: (input.experience ?? "").trim(),
      dietaryOrShirt: (input.dietaryOrShirt ?? "").trim(),
      status: "pending",
      reviewerNote: "",
      submittedAt: now,
    };
  }

  updateFormResponse(
    responseId: string,
    patch: { status?: ApplicantStatus; preferredTeamId?: string; reviewerNote?: string },
  ): void {
    const existing = this.db.prepare("SELECT * FROM form_responses WHERE id = ?").get(responseId) as Record<string, unknown> | undefined;
    if (!existing) throw new AppError(404, "找不到指定的招工回覆。");
    this.db
      .prepare("UPDATE form_responses SET status = ?, preferred_team_id = ?, reviewer_note = ? WHERE id = ?")
      .run(
        patch.status ?? String(existing.status),
        patch.preferredTeamId ?? String(existing.preferred_team_id),
        patch.reviewerNote !== undefined ? patch.reviewerNote : String(existing.reviewer_note ?? ""),
        responseId,
      );
  }

  importFormResponsesCsv(campaignId: string, formId: string, csvText: string): number {
    const snap = this.getSnapshot(campaignId);
    const grid = parseCsvGrid(csvText);
    if (grid.length < 2) throw new AppError(400, "CSV 至少需要標題列與一筆回覆資料。");
    const headers = grid[0].map((h) => h.toLowerCase());
    const findCol = (patterns: RegExp[]) => headers.findIndex((h) => patterns.some((p) => p.test(h)));

    const nameIdx = Math.max(0, findCol([/姓名|名字|稱呼|name/]));
    const emailIdx = findCol([/email|信箱|郵件/]);
    const handleIdx = findCol([/discord|telegram|line|id|社群|帳號/]);
    const teamIdx = findCol([/組別|志願|部門|team/]);
    const skillIdx = findCol([/專長|技能|skill/]);
    const availIdx = findCol([/時段|時間|出席|avail/]);
    const expIdx = findCol([/經驗|動機|介紹|備註|experience/]);

    const fallbackTeamId = snap.teams[0]?.id;
    if (!fallbackTeamId) throw new AppError(400, "請先建立至少一個組別再匯入招工回覆。");

    const existingEmails = new Set(
      snap.formResponses
        .filter((r) => r.formId === formId && r.email.trim())
        .map((r) => r.email.trim().toLowerCase()),
    );
    const existingNames = new Set(
      snap.formResponses
        .filter((r) => r.formId === formId)
        .map((r) => r.applicantName.trim().toLowerCase()),
    );

    let imported = 0;
    for (let r = 1; r < grid.length; r++) {
      const row = grid[r];
      const name = (row[nameIdx] ?? "").trim();
      if (!name) continue;
      const email = emailIdx >= 0 ? (row[emailIdx] ?? "").trim() : "";
      if ((email && existingEmails.has(email.toLowerCase())) || existingNames.has(name.toLowerCase())) {
        continue;
      }
      if (email) existingEmails.add(email.toLowerCase());
      existingNames.add(name.toLowerCase());

      const rawTeam = teamIdx >= 0 ? (row[teamIdx] ?? "").trim() : "";
      const matchedTeam =
        snap.teams.find((t) => rawTeam && (rawTeam.includes(t.name) || t.name.includes(rawTeam))) ?? snap.teams[0];
      this.addFormResponse(formId, {
        applicantName: name,
        email,
        handle: handleIdx >= 0 ? row[handleIdx] : "",
        preferredTeamId: matchedTeam.id,
        skills: skillIdx >= 0 && row[skillIdx] ? row[skillIdx].split(/[,、/，;]+/) : ["熱忱支援"],
        availability: availIdx >= 0 && row[availIdx] ? row[availIdx].split(/[,、/，;]+/) : ["活動當日"],
        experience: expIdx >= 0 ? row[expIdx] : "",
      });
      imported++;
    }
    return imported;
  }

  // ── Google Sheet Schedule Import & Auto-Schedule Apply ───────────────────
  importScheduleFromSheetCsv(campaignId: string, csvText: string, sheetUrl?: string): CampaignSnapshot {
    const parsed = parseGoogleSheetCsv(csvText);
    const now = new Date().toISOString();

    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM weeks WHERE campaign_id = ?").run(campaignId);
      this.db.prepare("DELETE FROM teams WHERE campaign_id = ?").run(campaignId);
      this.db.prepare("DELETE FROM todos WHERE campaign_id = ?").run(campaignId);

      if (sheetUrl) {
        this.db.prepare("UPDATE campaigns SET sheet_url = ?, updated_at = ? WHERE id = ?").run(sheetUrl.trim(), now, campaignId);
      }

      const weekIds: string[] = [];
      const insertWeek = this.db.prepare(
        `INSERT INTO weeks (id, campaign_id, order_index, month_label, date_range, countdown_label, phase, stage, major_events_json, memo, progress_override)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      parsed.weeks.forEach((w, idx) => {
        const wId = `wk-${randomUUID().slice(0, 8)}`;
        weekIds.push(wId);
        insertWeek.run(
          wId,
          campaignId,
          idx,
          w.monthLabel,
          w.dateRange,
          w.countdownLabel,
          w.phase,
          w.stage,
          JSON.stringify(w.majorEvents),
          w.memo,
          w.progressOverride,
        );
      });

      const insertTeam = this.db.prepare(
        `INSERT INTO teams (id, campaign_id, name, lead, color, target_headcount, order_index)
         VALUES (?, ?, ?, '', ?, 5, ?)`,
      );
      const insertCell = this.db.prepare(
        `INSERT INTO cells (week_id, team_id, stage, weekly_focus, cross_team, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insertTodo = this.db.prepare(
        `INSERT INTO todos (id, campaign_id, team_id, week_id, title, assignee, done, priority, due_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', ?, 'normal', '', ?, ?)`,
      );

      parsed.teams.forEach((t, tIdx) => {
        const tId = `tm-${randomUUID().slice(0, 8)}`;
        insertTeam.run(tId, campaignId, t.name, t.color, tIdx);
        for (const c of t.cells) {
          const wId = weekIds[c.weekIndex];
          if (!wId) continue;
          insertCell.run(wId, tId, c.stage, c.weeklyFocus, c.crossTeam, now);
          for (const tdTitle of c.todos) {
            const done = /^✓|^☑|^\[x\]/i.test(tdTitle);
            const cleanTitle = tdTitle.replace(/^[✓☑☐\[\]xX\s]+/, "").trim();
            if (cleanTitle) {
              insertTodo.run(`todo-${randomUUID().slice(0, 8)}`, campaignId, tId, wId, cleanTitle, done ? 1 : 0, now, now);
            }
          }
        }
      });

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return this.getSnapshot(campaignId);
  }

  applyAutoSchedule(
    campaignId: string,
    input: {
      pacing: PacingLevel;
      mainGoal?: string;
      monthlyGoals?: MonthlyGoal[];
      preview: Pick<AutoSchedulePreview, "cells" | "todos"> & {
        weekStages?: Array<{ weekId: string; stage: CellStage }>;
      };
    },
  ): CampaignSnapshot {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.updateCampaignMeta(campaignId, {
        pacing: input.pacing,
        ...(input.mainGoal !== undefined ? { mainGoal: input.mainGoal } : {}),
        ...(input.monthlyGoals !== undefined ? { monthlyGoals: input.monthlyGoals } : {}),
      });

      const stageByWeek = new Map<string, CellStage>();
      for (const cell of input.preview.cells) {
        if (!stageByWeek.has(cell.weekId) && cell.stage !== "待排") {
          stageByWeek.set(cell.weekId, cell.stage);
        }
      }
      for (const ws of input.preview.weekStages ?? []) {
        stageByWeek.set(ws.weekId, ws.stage);
      }
      const updateWeekStage = this.db.prepare("UPDATE weeks SET stage = ? WHERE id = ? AND campaign_id = ?");
      for (const [weekId, stage] of stageByWeek) {
        updateWeekStage.run(stage, weekId, campaignId);
      }

      for (const cell of input.preview.cells) {
        const existing = this.db
          .prepare("SELECT cross_team FROM cells WHERE week_id = ? AND team_id = ?")
          .get(cell.weekId, cell.teamId) as { cross_team?: string } | undefined;
        this.upsertCell({
          weekId: cell.weekId,
          teamId: cell.teamId,
          stage: cell.stage,
          weeklyFocus: cell.weeklyFocus,
          crossTeam: cell.crossTeam ?? existing?.cross_team ?? "",
        });
      }

      const existingTitles = new Set(
        (
          this.db.prepare("SELECT title FROM todos WHERE campaign_id = ?").all(campaignId) as Array<{ title: string }>
        ).map((r) => r.title.trim().toLowerCase()),
      );

      for (const td of input.preview.todos) {
        if (existingTitles.has(td.title.trim().toLowerCase())) continue;
        existingTitles.add(td.title.trim().toLowerCase());
        this.addTodo(campaignId, {
          teamId: td.teamId,
          weekId: td.weekId,
          title: td.title,
          priority: td.priority,
        });
      }

      this.db.prepare("UPDATE campaigns SET updated_at = ? WHERE id = ?").run(now, campaignId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getSnapshot(campaignId);
  }

  // ── Campaign Bot Messages & Action Proposal Execution ────────────────────
  appendBotMessage(campaignId: string, role: "user" | "assistant", content: string, proposals: BotActionProposal[] = []): BotMessage {
    const now = new Date().toISOString();
    const id = `bot-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare("INSERT INTO bot_messages (id, campaign_id, role, content, proposals_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, campaignId, role, content, JSON.stringify(proposals), now);
    return { id, campaignId, role, content, proposals, createdAt: now };
  }

  markProposalApplied(messageId: string, proposalId: string): BotActionProposal {
    const row = this.db.prepare("SELECT * FROM bot_messages WHERE id = ?").get(messageId) as Record<string, unknown> | undefined;
    if (!row) throw new AppError(404, "找不到指定的助理對話訊息。");
    const proposals = safeJsonParse<BotActionProposal[]>(String(row.proposals_json ?? "[]"), []);
    const target = proposals.find((p) => p.id === proposalId);
    if (!target) throw new AppError(404, "找不到指定的操作建議。");
    target.applied = true;
    this.db.prepare("UPDATE bot_messages SET proposals_json = ? WHERE id = ?").run(JSON.stringify(proposals), messageId);
    return target;
  }

  close(): void {
    this.db.close();
  }
}
