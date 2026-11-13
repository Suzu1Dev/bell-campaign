import {
  CELL_STAGES,
  PACING_META,
  TEAM_COLORS,
  type AutoScheduleInput,
  type AutoSchedulePreview,
  type CampaignSummary,
  type CampaignSnapshot,
  type CellStage,
  type ProposedCellChange,
  type ProposedNewTodo,
  type TeamColor,
  type WeekEventItem,
} from "./types.js";

const STAGE_PROGRESS_MAP: Record<CellStage, number> = {
  待排: 0,
  "進度20%": 20,
  "進度25%": 25,
  "進度40%": 40,
  "進度50%": 50,
  "進度60%": 60,
  "進度75%": 75,
  "進度80%": 80,
  "進度100%": 100,
  Debug: 92,
  RC: 96,
  活動: 100,
  復盤: 100,
};

export function stageToPercent(stage: CellStage): number {
  return STAGE_PROGRESS_MAP[stage] ?? 0;
}

export const MAX_PREP_WEEKS = 52;
export const MONTH_LABELS_ZH = [
  "一月",
  "二月",
  "三月",
  "四月",
  "五月",
  "六月",
  "七月",
  "八月",
  "九月",
  "十月",
  "十一月",
  "十二月",
] as const;

const ZH_NUM_MAP: Record<string, number> = {
  十二: 12,
  十一: 11,
  十: 10,
  九: 9,
  八: 8,
  七: 7,
  六: 6,
  五: 5,
  四: 4,
  三: 3,
  二: 2,
  一: 1,
};

/** Extracts 1..12 month numbers from Chinese ("十一月") or Arabic ("11月", "11月底～1月初", "2-3月") strings. */
export function parseMonthNumbers(raw: string): number[] {
  const found = new Set<number>();
  const rangeRegex = /(\d{1,2})\s*(?:月(?:底|初|中)?)?\s*[~～\-至到]\s*(\d{1,2})\s*月/g;
  for (const m of raw.matchAll(rangeRegex)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a >= 1 && a <= 12 && b >= 1 && b <= 12) {
      let cur = a;
      for (let guard = 0; guard < 12; guard++) {
        found.add(cur);
        if (cur === b) break;
        cur = (cur % 12) + 1;
      }
    }
  }
  for (const m of raw.matchAll(/(?<!\d)(1[0-2]|[1-9])\s*月/g)) {
    found.add(Number(m[1]));
  }
  for (const [zh, num] of Object.entries(ZH_NUM_MAP)) {
    if (raw.includes(`${zh}月`)) {
      if (num === 1 && raw.includes("十一月") && !/(?<!十)一月/.test(raw)) continue;
      if (num === 2 && raw.includes("十二月") && !/(?<!十)二月/.test(raw)) continue;
      found.add(num);
    }
  }
  return [...found];
}

export function formatCampaignDateLabel(
  campaign: Pick<CampaignSummary, "eventDate" | "dateTentative" | "tentativeNote">,
): string {
  if (campaign.dateTentative) {
    return campaign.tentativeNote.trim() || `${campaign.eventDate}（日期待定）`;
  }
  return campaign.eventDate;
}

export interface WeeklyTimelineDef {
  orderIndex: number;
  monthLabel: string;
  dateRange: string;
  startDate: string;
  endDate: string;
  countdownLabel: string;
  phase: "prep" | "event" | "post";
  stage: CellStage;
}

export interface BuildTimelineInput {
  eventDate: string;
  startDate?: string;
  prepWeeks?: number;
  postWeeks?: number;
  dateTentative?: boolean;
  referenceToday?: string;
}

export function buildWeeklyTimelineDefs(input: BuildTimelineInput): {
  startIso: string;
  prepCount: number;
  postWeeks: number;
  weeks: WeeklyTimelineDef[];
} {
  const postWeeks = Math.max(0, Math.min(8, input.postWeeks ?? 2));
  const todayIso = input.referenceToday || new Date().toISOString().slice(0, 10);
  const todayTime = Date.parse(`${todayIso}T00:00:00Z`);
  const eventTime = Date.parse(`${input.eventDate}T00:00:00Z`);
  const safeEventTime = Number.isFinite(eventTime) ? eventTime : todayTime + 6 * 7 * 86400_000;

  let prepCount = 6;
  if (input.prepWeeks !== undefined && Number.isFinite(input.prepWeeks)) {
    prepCount = Math.max(1, Math.min(MAX_PREP_WEEKS, Math.round(input.prepWeeks)));
  } else if (input.startDate && /^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) {
    const startTime = Date.parse(`${input.startDate}T00:00:00Z`);
    if (Number.isFinite(startTime) && safeEventTime > startTime) {
      prepCount = Math.max(1, Math.min(MAX_PREP_WEEKS, Math.ceil((safeEventTime - startTime) / (7 * 86400_000))));
    } else if (Number.isFinite(startTime)) {
      prepCount = 1;
    }
  } else if (safeEventTime > todayTime) {
    prepCount = Math.max(1, Math.min(MAX_PREP_WEEKS, Math.ceil((safeEventTime - todayTime) / (7 * 86400_000))));
  }

  const baseStart = new Date(safeEventTime - prepCount * 7 * 86400_000);
  const startIso = baseStart.toISOString().slice(0, 10);
  const totalWeeks = prepCount + 1 + postWeeks;
  const fmt = (d: Date) => `${d.getUTCMonth() + 1}/${String(d.getUTCDate()).padStart(2, "0")}`;

  const weeks: WeeklyTimelineDef[] = [];
  for (let i = 0; i < totalWeeks; i++) {
    const ws = new Date(baseStart.getTime() + i * 7 * 86400_000);
    const we = new Date(ws.getTime() + 6 * 86400_000);
    const phase: "prep" | "event" | "post" = i < prepCount ? "prep" : i === prepCount ? "event" : "post";
    const countdownLabel =
      phase === "prep"
        ? `倒數 ${prepCount - i} 周`
        : phase === "event"
          ? input.dateTentative
            ? "暫定活動當周"
            : "活動當周"
          : `活動後 ${i - prepCount} 周`;

    weeks.push({
      orderIndex: i,
      monthLabel: MONTH_LABELS_ZH[ws.getUTCMonth()],
      dateRange: `${fmt(ws)}~${fmt(we)}`,
      startDate: ws.toISOString().slice(0, 10),
      endDate: we.toISOString().slice(0, 10),
      countdownLabel,
      phase,
      stage: defaultWeekStage(phase, i, prepCount),
    });
  }

  return { startIso, prepCount, postWeeks, weeks };
}

export function defaultWeekStage(
  phase: "prep" | "event" | "post",
  prepIdx: number,
  prepCount: number,
): CellStage {
  if (phase === "event") return "活動";
  if (phase === "post") return "復盤";
  const bufferCount = prepCount >= 5 ? 2 : prepCount >= 3 ? 1 : 0;
  const activeCount = Math.max(1, prepCount - bufferCount);
  if (prepIdx >= activeCount) {
    return prepIdx === prepCount - 1 && bufferCount >= 1 ? "RC" : "Debug";
  }
  const ratio = (prepIdx + 1) / activeCount;
  if (ratio <= 0.25) return "進度25%";
  if (ratio <= 0.5) return "進度50%";
  if (ratio <= 0.75) return "進度75%";
  return "進度100%";
}

export interface CampaignMetrics {
  overallPercent: number;
  completedTodos: number;
  totalTodos: number;
  conflictWeekCount: number;
  teamProgress: Record<string, { percent: number; done: number; total: number; latestStage: CellStage }>;
  weekProgress: Record<string, { percent: number; done: number; total: number; hasConflict: boolean }>;
}

export function computeCampaignMetrics(snapshot: Pick<CampaignSnapshot, "weeks" | "teams" | "cells" | "todos">): CampaignMetrics {
  const cellMap = new Map<string, CellStage>();
  for (const cell of snapshot.cells) {
    cellMap.set(`${cell.weekId}:${cell.teamId}`, cell.stage);
  }

  const teamProgress: CampaignMetrics["teamProgress"] = {};
  for (const team of snapshot.teams) {
    const teamTodos = snapshot.todos.filter((t) => t.teamId === team.id);
    const done = teamTodos.filter((t) => t.done).length;
    const total = teamTodos.length;

    let latestStage: CellStage = "待排";
    let maxStageScore = 0;
    for (const week of snapshot.weeks) {
      const stage = cellMap.get(`${week.id}:${team.id}`);
      if (stage && stage !== "待排") {
        const s = stageToPercent(stage);
        if (s >= maxStageScore) {
          maxStageScore = s;
          latestStage = stage;
        }
      }
    }

    const todoPct = total > 0 ? Math.round((done / total) * 100) : null;
    const percent = todoPct !== null ? todoPct : maxStageScore;
    teamProgress[team.id] = { percent, done, total, latestStage };
  }

  const weekProgress: CampaignMetrics["weekProgress"] = {};
  const orderedWeeks = [...snapshot.weeks].sort((a, b) => a.orderIndex - b.orderIndex);
  for (const week of orderedWeeks) {
    const hasConflict = week.majorEvents.some((ev) => ev.kind === "conflict");
    const weekTodos = snapshot.todos.filter((t) => t.weekId === week.id);
    const done = weekTodos.filter((t) => t.done).length;
    const total = weekTodos.length;

    let percent = 0;
    if (week.progressOverride !== null && Number.isFinite(week.progressOverride)) {
      percent = Math.max(0, Math.min(100, Math.round(week.progressOverride)));
    } else if (total > 0) {
      percent = Math.round((done / total) * 100);
    } else if (week.stage && week.stage !== "待排") {
      percent = stageToPercent(week.stage);
    } else if (snapshot.teams.length > 0) {
      const sum = snapshot.teams.reduce((acc, team) => {
        const st = cellMap.get(`${week.id}:${team.id}`) ?? "待排";
        return acc + stageToPercent(st);
      }, 0);
      percent = Math.round(sum / snapshot.teams.length);
    }
    weekProgress[week.id] = { percent, done, total, hasConflict };
  }

  const totalTodos = snapshot.todos.length;
  const completedTodos = snapshot.todos.filter((t) => t.done).length;
  const teamValues = Object.values(teamProgress);
  const overallPercent =
    totalTodos > 0
      ? Math.round((completedTodos / totalTodos) * 100)
      : teamValues.length > 0
        ? Math.round(teamValues.reduce((acc, item) => acc + item.percent, 0) / teamValues.length)
        : 0;

  const conflictWeekCount = orderedWeeks.filter((w) => w.majorEvents.some((ev) => ev.kind === "conflict")).length;

  return {
    overallPercent,
    completedTodos,
    totalTodos,
    conflictWeekCount,
    teamProgress,
    weekProgress,
  };
}

/** RFC-4180 compliant CSV parser supporting multi-line quoted cells (Google Sheets export format). */
export function parseCsvGrid(raw: string): string[][] {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.length > 0));
}

export function normalizeStage(raw: string): CellStage {
  const clean = raw.replace(/\s+/g, "");
  if ((CELL_STAGES as readonly string[]).includes(clean)) return clean as CellStage;
  if (/100%/.test(clean)) return "進度100%";
  if (/80%/.test(clean)) return "進度80%";
  if (/75%/.test(clean)) return "進度75%";
  if (/60%/.test(clean)) return "進度60%";
  if (/50%/.test(clean)) return "進度50%";
  if (/40%/.test(clean)) return "進度40%";
  if (/25%/.test(clean)) return "進度25%";
  if (/20%|15%|10%/.test(clean)) return "進度20%";
  if (/debug/i.test(clean)) return "Debug";
  if (/^rc$/i.test(clean)) return "RC";
  if (/活動/.test(clean)) return "活動";
  if (/復盤|結案|檢討/.test(clean)) return "復盤";
  return "待排";
}

function classifyEventKind(title: string): "milestone" | "conflict" {
  return /撞期|coscup|conf|大選|連假|當兵|出國|停電|施工|撞/i.test(title) ? "conflict" : "milestone";
}

export interface ParsedGoogleSheetCampaign {
  weeks: Array<{
    monthLabel: string;
    dateRange: string;
    countdownLabel: string;
    phase: "prep" | "event" | "post";
    stage: CellStage;
    majorEvents: WeekEventItem[];
    memo: string;
    progressOverride: number | null;
  }>;
  teams: Array<{
    name: string;
    color: TeamColor;
    cells: Array<{
      weekIndex: number;
      stage: CellStage;
      weeklyFocus: string;
      todos: string[];
      crossTeam: string;
    }>;
  }>;
}

/**
 * Parses the BELL Campaign / Google Sheets weekly countdown layout
 * (matching the reference spreadsheet: 月, 日期, 倒數週數, 整體進度, 主要排程, 備註, and multi-row team blocks).
 */
export function parseGoogleSheetCsv(csvText: string): ParsedGoogleSheetCampaign {
  const grid = parseCsvGrid(csvText);
  if (grid.length < 3) {
    throw new Error("試算表內容列數不足，請確認包含日期列與組別進度列。");
  }

  let monthRowIdx = -1;
  let dateRowIdx = -1;
  let countdownRowIdx = -1;
  let majorEventRowIdx = -1;
  let memoRowIdx = -1;
  let overallRowIdx = -1;

  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const c0 = grid[r][0] ?? "";
    const c1 = grid[r][1] ?? "";
    const label = `${c0}${c1}`;
    if (c1 === "月" || c0 === "月") monthRowIdx = r;
    else if (label.includes("日期")) dateRowIdx = r;
    else if (label.includes("倒數")) countdownRowIdx = r;
    else if (label.includes("主要排程") || label.includes("重大事件") || label.includes("撞期")) majorEventRowIdx = r;
    else if (label.includes("備註")) memoRowIdx = r;
    else if (
      label.includes("整體進度") ||
      label.includes("專案進度") ||
      label.includes("總進度") ||
      (c0 === "" && c1 === "完成度") ||
      (c0 === "完成度" && c1 === "")
    ) {
      overallRowIdx = r;
    }
  }

  if (dateRowIdx < 0) dateRowIdx = 1;
  const dateRow = grid[dateRowIdx] ?? [];
  const startCol = 2;
  const weekCols: number[] = [];
  for (let c = startCol; c < dateRow.length; c++) {
    if ((dateRow[c] ?? "").trim()) weekCols.push(c);
  }
  if (weekCols.length === 0) {
    throw new Error("找不到每週日期欄位（例如 6/22~6/28），請檢查試算表格式。");
  }

  let runningMonth = "";
  const weeks = weekCols.map((col, idx) => {
    const rawMonth = monthRowIdx >= 0 ? (grid[monthRowIdx]?.[col] ?? "").trim() : "";
    if (rawMonth) runningMonth = rawMonth;
    const dateRange = (dateRow[col] ?? "").trim();
    const countdownLabel =
      countdownRowIdx >= 0 && (grid[countdownRowIdx]?.[col] ?? "").trim()
        ? (grid[countdownRowIdx][col] ?? "").trim()
        : `第 ${idx + 1} 週`;
    const phase: "prep" | "event" | "post" = /活動後|會後|結案/.test(countdownLabel)
      ? "post"
      : /當周|當週|活動日/.test(countdownLabel)
        ? "event"
        : "prep";

    const rawMajor = majorEventRowIdx >= 0 ? (grid[majorEventRowIdx]?.[col] ?? "").trim() : "";
    const mergedEventLines: string[] = [];
    if (rawMajor) {
      const rawLines = rawMajor
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (let i = 0; i < rawLines.length; i++) {
        const cur = rawLines[i];
        const next = rawLines[i + 1];
        if (next && /^\d{1,2}\/\d{1,2}(?:~\d{1,2}\/\d{1,2})?$/.test(cur)) {
          mergedEventLines.push(`${cur} ${next}`);
          i += 1;
        } else {
          mergedEventLines.push(cur);
        }
      }
    }
    const majorEvents: WeekEventItem[] = mergedEventLines.map((line, evIdx) => ({
      id: `ev-${idx}-${evIdx}`,
      title: line,
      kind: classifyEventKind(line),
    }));

    const memo = memoRowIdx >= 0 ? (grid[memoRowIdx]?.[col] ?? "").trim() : "";
    const rawOverall = overallRowIdx >= 0 ? (grid[overallRowIdx]?.[col] ?? "").trim() : "";
    const stage: CellStage = rawOverall ? normalizeStage(rawOverall) : "待排";
    let progressOverride: number | null = null;
    if (rawOverall && stage === "待排") {
      const m = /(\d{1,3})\s*%/.exec(rawOverall);
      if (m) progressOverride = Math.min(100, Number(m[1]));
    }

    return {
      monthLabel: runningMonth || "籌備期",
      dateRange,
      countdownLabel,
      phase,
      stage,
      majorEvents,
      memo,
      progressOverride,
    };
  });

  const headerEnd = Math.max(dateRowIdx, countdownRowIdx, majorEventRowIdx, memoRowIdx, overallRowIdx) + 1;
  const teams: ParsedGoogleSheetCampaign["teams"] = [];
  let currentTeam: ParsedGoogleSheetCampaign["teams"][number] | null = null;
  let currentSubKind: "stage" | "focus" | "todo" | "cross" = "todo";

  for (let r = headerEnd; r < grid.length; r++) {
    const row = grid[r];
    const teamCol = (row[0] ?? "").trim();
    const subCol = (row[1] ?? "").trim();

    if (teamCol && !["倒數週數", "主要排程", "備註", "整體進度", "專案進度"].includes(teamCol)) {
      currentTeam = {
        name: teamCol,
        color: TEAM_COLORS[teams.length % TEAM_COLORS.length],
        cells: weekCols.map((_, weekIndex) => ({
          weekIndex,
          stage: "待排",
          weeklyFocus: "",
          todos: [],
          crossTeam: "",
        })),
      };
      teams.push(currentTeam);
    }

    if (!currentTeam) continue;

    if (subCol.includes("完成度") || subCol.includes("階段")) currentSubKind = "stage";
    else if (subCol.includes("本週進度") || subCol.includes("本周進度") || subCol.includes("重點")) currentSubKind = "focus";
    else if (subCol.includes("待辦")) currentSubKind = "todo";
    else if (subCol.includes("跨部")) currentSubKind = "cross";

    weekCols.forEach((col, weekIndex) => {
      const val = (row[col] ?? "").trim();
      if (!val) return;
      const target = currentTeam!.cells[weekIndex];
      if (currentSubKind === "stage") {
        target.stage = normalizeStage(val);
      } else if (currentSubKind === "focus") {
        target.weeklyFocus = target.weeklyFocus ? `${target.weeklyFocus} · ${val}` : val;
      } else if (currentSubKind === "todo") {
        for (const item of val.split(/\n+/).map((s) => s.trim()).filter(Boolean)) {
          target.todos.push(item);
        }
      } else if (currentSubKind === "cross") {
        target.crossTeam = target.crossTeam ? `${target.crossTeam} ／ ${val}` : val;
      }
    });
  }

  // Lift legacy per-team repeated stages up to the unified top-level project progress row
  const prepCount = weeks.filter((w) => w.phase === "prep").length;
  let prepSeen = 0;
  weeks.forEach((w, wIdx) => {
    const isPrep = w.phase === "prep";
    const curPrepIdx = prepSeen;
    if (isPrep) prepSeen += 1;
    if (w.stage !== "待排") return;
    const lifted = teams.map((t) => t.cells[wIdx]?.stage ?? "待排").find((st) => st !== "待排");
    w.stage = lifted ?? defaultWeekStage(w.phase, curPrepIdx, prepCount);
  });

  return { weeks, teams };
}

/** Builds a 2D matrix aligned with the Google Sheets layout for 1-click TSV copy & CSV export. */
export function buildGoogleSheetMatrix(snapshot: CampaignSnapshot): string[][] {
  const orderedWeeks = [...snapshot.weeks].sort((a, b) => a.orderIndex - b.orderIndex);
  const orderedTeams = [...snapshot.teams].sort((a, b) => a.orderIndex - b.orderIndex);
  const metrics = computeCampaignMetrics(snapshot);
  const cellMap = new Map(snapshot.cells.map((c) => [`${c.weekId}:${c.teamId}`, c]));

  let lastMonth = "";
  const monthRow = [
    "",
    "月",
    ...orderedWeeks.map((w) => {
      if (w.monthLabel !== lastMonth) {
        lastMonth = w.monthLabel;
        return w.monthLabel;
      }
      return "";
    }),
  ];
  const dateRow = ["", "日期", ...orderedWeeks.map((w) => w.dateRange)];
  const countdownRow = ["倒數週數", "", ...orderedWeeks.map((w) => w.countdownLabel)];
  const progressRow = [
    "整體進度",
    `總完成 ${metrics.overallPercent}%`,
    ...orderedWeeks.map((w) => w.stage),
  ];
  const majorRow = [
    "主要排程／撞期",
    "",
    ...orderedWeeks.map((w) =>
      w.majorEvents.map((e) => (e.kind === "conflict" ? `[撞期避開] ${e.title}` : e.title)).join("\n"),
    ),
  ];
  const memoRow = ["備註", "", ...orderedWeeks.map((w) => w.memo)];

  const rows: string[][] = [monthRow, dateRow, countdownRow, progressRow, majorRow, memoRow];

  for (const team of orderedTeams) {
    rows.push([
      team.name,
      "本週進度",
      ...orderedWeeks.map((w) => cellMap.get(`${w.id}:${team.id}`)?.weeklyFocus ?? ""),
    ]);
    rows.push([
      "",
      "待辦事項",
      ...orderedWeeks.map((w) =>
        snapshot.todos
          .filter((t) => t.teamId === team.id && t.weekId === w.id)
          .map((t) => `${t.done ? "✓" : "☐"} ${t.title}`)
          .join("\n"),
      ),
    ]);
    rows.push([
      "",
      "跨部合作",
      ...orderedWeeks.map((w) => cellMap.get(`${w.id}:${team.id}`)?.crossTeam ?? ""),
    ]);
  }

  return rows;
}

export function matrixToTsv(matrix: string[][]): string {
  return matrix
    .map((row) =>
      row
        .map((cell) => {
          if (/[\t\n"]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
          return cell;
        })
        .join("\t"),
    )
    .join("\n");
}

export function matrixToCsvBom(matrix: string[][]): string {
  const body = matrix
    .map((row) =>
      row
        .map((cell) => {
          if (/[,\n"]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
          return cell;
        })
        .join(","),
    )
    .join("\r\n");
  return `\uFEFF${body}`;
}

export function buildWeeklyDigestText(snapshot: CampaignSnapshot): string {
  const metrics = computeCampaignMetrics(snapshot);
  const orderedWeeks = [...snapshot.weeks].sort((a, b) => a.orderIndex - b.orderIndex);
  const orderedTeams = [...snapshot.teams].sort((a, b) => a.orderIndex - b.orderIndex);
  const activeWeek =
    orderedWeeks.find((w) => (metrics.weekProgress[w.id]?.percent ?? 0) < 100 && w.phase === "prep") ??
    orderedWeeks[0];

  const lines: string[] = [
    `【${snapshot.campaign.name} · 時程協作週報】`,
    `活動日期：${formatCampaignDateLabel(snapshot.campaign)} ｜ 整體完成度：${metrics.overallPercent}%（${metrics.completedTodos}/${metrics.totalTodos} 項待辦）`,
  ];

  if (activeWeek) {
    lines.push(`當前焦點週次：${activeWeek.countdownLabel}（${activeWeek.dateRange} · 整體階段：${activeWeek.stage}）`);
    if (activeWeek.majorEvents.length > 0) {
      lines.push(
        `本週重要事件／撞期提醒：${activeWeek.majorEvents
          .map((e) => (e.kind === "conflict" ? `⚠️ ${e.title}` : `📌 ${e.title}`))
          .join("、")}`,
      );
    }
  }

  lines.push("", "▸ 各組進度與待辦重點：");
  for (const team of orderedTeams) {
    const tp = metrics.teamProgress[team.id];
    const openTodos = snapshot.todos.filter((t) => t.teamId === team.id && !t.done).slice(0, 3);
    const cell = activeWeek
      ? snapshot.cells.find((c) => c.weekId === activeWeek.id && c.teamId === team.id)
      : undefined;
    lines.push(
      `• ${team.name}（待辦 ${tp?.done ?? 0}/${tp?.total ?? 0} 完成）${
        cell?.weeklyFocus ? `：${cell.weeklyFocus}` : ""
      }`,
    );
    if (openTodos.length > 0) {
      lines.push(`  待完成：${openTodos.map((t) => t.title).join(" ／ ")}`);
    }
  }

  if (snapshot.campaign.sheetUrl) {
    lines.push("", `Google 試算表完整時程：${snapshot.campaign.sheetUrl}`);
  }
  return lines.join("\n");
}

export function buildAppsScriptSyncCode(snapshot: CampaignSnapshot): string {
  const matrixJson = JSON.stringify(buildGoogleSheetMatrix(snapshot));
  return `/**
 * BELL Campaign → Google 試算表 & Google 簡報 一鍵寫入腳本
 * 使用方式：開啟目標 Google 試算表 →「擴充功能」→「Apps Script」貼上執行 syncBellCampaign()
 */
function syncBellCampaign() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = ${JSON.stringify(snapshot.campaign.name.slice(0, 28))};
  let sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  sheet.clear();

  const rows = ${matrixJson};
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.setFrozenRows(4);
  sheet.setFrozenColumns(2);
  sheet.getRange(1, 1, 4, rows[0].length).setFontWeight("bold").setBackground("#F2F3F6");
  sheet.autoResizeColumns(1, rows[0].length);
}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Generates a crisp, self-contained offline-capable HTML share page & slide briefing for teammates. */
export function buildStandaloneShareHtml(snapshot: CampaignSnapshot): string {
  const metrics = computeCampaignMetrics(snapshot);
  const orderedWeeks = [...snapshot.weeks].sort((a, b) => a.orderIndex - b.orderIndex);
  const orderedTeams = [...snapshot.teams].sort((a, b) => a.orderIndex - b.orderIndex);
  const cellMap = new Map(snapshot.cells.map((c) => [`${c.weekId}:${c.teamId}`, c]));

  const stageRuns: Array<{ stage: CellStage; count: number }> = [];
  for (const w of orderedWeeks) {
    const last = stageRuns[stageRuns.length - 1];
    if (last && last.stage === w.stage) last.count += 1;
    else stageRuns.push({ stage: w.stage, count: 1 });
  }

  const stageCols = stageRuns
    .map(
      (run) =>
        `<th colspan="${run.count}" class="stage-head"><div class="stage-pill">${escapeHtml(run.stage)}${
          run.count > 1 ? ` · 連續 ${run.count} 週` : ""
        }</div></th>`,
    )
    .join("");

  const headerCols = orderedWeeks
    .map((w) => {
      const conflicts = w.majorEvents
        .map(
          (e) =>
            `<span class="badge ${e.kind === "conflict" ? "conflict" : "milestone"}">${escapeHtml(e.title)}</span>`,
        )
        .join("");
      return `<th>
        <div class="month">${escapeHtml(w.monthLabel)} · ${escapeHtml(w.dateRange)}</div>
        <div class="cd">${escapeHtml(w.countdownLabel)}</div>
        <div class="events">${conflicts}</div>
      </th>`;
    })
    .join("");

  const bodyRows = orderedTeams
    .map((team) => {
      const tp = metrics.teamProgress[team.id];
      const tds = orderedWeeks
        .map((w) => {
          const cell = cellMap.get(`${w.id}:${team.id}`);
          const todos = snapshot.todos.filter((t) => t.teamId === team.id && t.weekId === w.id);
          return `<td>
            ${cell?.weeklyFocus ? `<div class="focus">${escapeHtml(cell.weeklyFocus)}</div>` : ""}
            ${
              todos.length
                ? `<ul class="todos">${todos
                    .map((t) => `<li class="${t.done ? "done" : ""}">${t.done ? "✓" : "○"} ${escapeHtml(t.title)}</li>`)
                    .join("")}</ul>`
                : ""
            }
            ${cell?.crossTeam ? `<div class="cross">跨部：${escapeHtml(cell.crossTeam)}</div>` : ""}
          </td>`;
        })
        .join("");
      return `<tr>
        <td class="team-col">
          <strong>${escapeHtml(team.name)}</strong>
          <span>組長：${escapeHtml(team.lead || "待定")} · 待辦 ${tp?.done ?? 0}/${tp?.total ?? 0}</span>
        </td>
        ${tds}
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(snapshot.campaign.name)} · BELL Campaign 時程分享</title>
<style>
  body { margin: 0; padding: 28px; font-family: "PingFang TC", "Noto Sans TC", system-ui, sans-serif; background: #F8F9FB; color: #111317; }
  header { max-width: 1360px; margin: 0 auto 20px; display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 22px; }
  .meta { color: #636872; font-size: 13px; margin-top: 4px; }
  .kpi { background: #FFFFFF; border: 1px solid rgba(15,17,21,.1); border-radius: 8px; padding: 10px 16px; font-size: 13px; }
  .wrap { max-width: 1360px; margin: 0 auto; overflow-x: auto; background: #FFFFFF; border: 1px solid rgba(15,17,21,.1); border-radius: 10px; }
  table { border-collapse: collapse; width: 100%; min-width: 920px; font-size: 13px; }
  th, td { border-bottom: 1px solid rgba(15,17,21,.08); border-right: 1px solid rgba(15,17,21,.08); padding: 10px 12px; vertical-align: top; text-align: left; }
  th { background: #F2F3F6; min-width: 165px; }
  .stage-head { background: #FFFFFF; padding: 4px 8px; vertical-align: middle; }
  .stage-pill { background: #F9ECF1; color: #9E2B5C; border: 1px solid rgba(158,43,92,.26); border-radius: 999px; padding: 3px 10px; font-weight: 600; font-size: 11.5px; line-height: 1.3; }
  .team-col { position: sticky; left: 0; background: #FFFFFF; min-width: 150px; z-index: 1; }
  .team-col span { display: block; color: #636872; font-size: 12px; margin-top: 4px; }
  .month { font-size: 12px; color: #636872; font-weight: 500; }
  .cd { font-size: 14px; font-weight: 600; margin-top: 2px; }
  .badge { display: inline-block; margin-top: 4px; padding: 2px 6px; border-radius: 4px; font-size: 11px; }
  .badge.conflict { background: #FAF1E1; color: #8A5200; }
  .badge.milestone { background: #F9ECF1; color: #9E2B5C; }
  .focus { font-weight: 500; margin-bottom: 6px; }
  .todos { margin: 0; padding: 0; list-style: none; color: #3B3F46; }
  .todos li { margin-bottom: 3px; }
  .todos li.done { color: #636872; text-decoration: line-through; }
  .cross { margin-top: 6px; padding-top: 4px; border-top: 1px dashed rgba(15,17,21,.12); font-size: 12px; color: #5640D8; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(snapshot.campaign.name)}</h1>
      <div class="meta">${escapeHtml(snapshot.campaign.subtitle)} · 活動時間 ${escapeHtml(formatCampaignDateLabel(snapshot.campaign))}</div>
    </div>
    <div class="kpi">整體進度 <strong>${metrics.overallPercent}%</strong> · 已完成 ${metrics.completedTodos}/${metrics.totalTodos} 待辦</div>
  </header>
  <div class="wrap">
    <table>
      <thead>
        <tr><th class="team-col stage-head">整體專案進度（${metrics.overallPercent}%）</th>${stageCols}</tr>
        <tr><th class="team-col">組別 ／ 週次</th>${headerCols}</tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

/**
 * Deterministic pacing scheduler: distributes parsed tasks & team stages across countdown weeks,
 * avoiding heavy launches in weeks flagged with external clashing events (`conflict`) and respecting
 * the chosen `PacingLevel` ("neither too loose nor too tight" at `balanced`).
 */
export function buildPacingSchedulePreview(
  snapshot: Pick<CampaignSnapshot, "weeks" | "teams" | "cells" | "todos">,
  input: AutoScheduleInput,
): AutoSchedulePreview {
  const meta = PACING_META.find((p) => p.id === input.pacing) ?? PACING_META[2];
  const orderedWeeks = [...snapshot.weeks].sort((a, b) => a.orderIndex - b.orderIndex);
  const prepWeeks = orderedWeeks.filter((w) => w.phase === "prep");
  const eventWeek = orderedWeeks.find((w) => w.phase === "event");
  const postWeeks = orderedWeeks.filter((w) => w.phase === "post");

  const rawLines = input.tasksText
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean);

  const avoidedConflictWeeks = orderedWeeks
    .filter((w) => w.majorEvents.some((ev) => ev.kind === "conflict"))
    .map((w) => `${w.countdownLabel}（${w.dateRange}）`);

  const usablePrep = prepWeeks.length > 0 ? prepWeeks : orderedWeeks.slice(0, Math.max(1, orderedWeeks.length - 1));
  const activeCutoff = Math.max(1, usablePrep.length - meta.bufferWeeks);

  // Compute slot capacity weights per prep week: conflict weeks drop capacity to 35% so tasks steer clear
  const slotWeights = usablePrep.map((w, idx) => {
    const hasConflict = w.majorEvents.some((ev) => ev.kind === "conflict");
    const inBuffer = idx >= activeCutoff;
    let weight = 1.0 * meta.factor;
    if (inBuffer) weight *= 0.45;
    if (hasConflict) weight *= 0.35;
    // Balanced / Compact front-loads middle-early weeks smoothly instead of piling up at week -1
    const posRatio = usablePrep.length > 1 ? idx / (usablePrep.length - 1) : 0.5;
    if (input.pacing === "compact" || input.pacing === "intense") {
      weight *= 1.15 - posRatio * 0.35;
    } else if (input.pacing === "relaxed") {
      weight *= 0.85 + Math.sin(posRatio * Math.PI) * 0.25;
    } else {
      weight *= 0.92 + Math.sin(posRatio * Math.PI) * 0.28;
    }
    return { week: w, weight: Math.max(0.2, weight), hasConflict, assigned: 0 };
  });

  const todos: ProposedNewTodo[] = [];
  const teams = snapshot.teams;

  if (teams.length > 0) {
    rawLines.forEach((line, idx) => {
      // 1. Explicit team prefix / name mention wins first; 2. Keyword affinity; 3. Round-robin
      let matchedTeam =
        teams.find((t) => line.startsWith(t.name) || line.startsWith(`[${t.name}]`)) ??
        teams.find((t) => line.includes(t.name));

      if (!matchedTeam) {
        for (const t of teams) {
          const tn = t.name.toLowerCase();
          if (
            ((tn.includes("出題") || tn.includes("競賽") || tn.includes("賽務")) &&
              /出題|驗題|賽制|輪次|題目|解題|flag|livectf/i.test(line)) ||
            ((tn.includes("infra") || tn.includes("技術") || tn.includes("平台") || tn.includes("架構")) &&
              /infra|平台|靶機|容器|環境|伺服器|部署|計分|轉播/i.test(line)) ||
            ((tn.includes("社團") || tn.includes("各校") || tn.includes("資格")) &&
              /各校|社團|資格|領獎|新手|社員|審核/.test(line)) ||
            ((tn.includes("行政") || tn.includes("廠商") || tn.includes("公關") || tn.includes("贊助")) &&
              /行政|廠商|贊助|洽談|報名|預算|核銷/.test(line)) ||
            ((tn.includes("行銷") || tn.includes("宣傳") || tn.includes("設計")) &&
              /社群|貼文|宣傳|視覺|設計|曝光/.test(line)) ||
            (tn.includes("場務") && /場地|報到|器材|動線|便當|志工/.test(line)) ||
            ((tn.includes("講者") || tn.includes("panel") || tn.includes("咖啡") || tn.includes("議程")) &&
              /講者|信件|題綱|主持|簡報|名單|議程/.test(line))
          ) {
            matchedTeam = t;
            break;
          }
        }
      }
      if (!matchedTeam) matchedTeam = teams[idx % teams.length];
      const escapedTeam = matchedTeam.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const cleanTitle = line.replace(new RegExp(`^\\[?${escapedTeam}\\]?[:：\\s-]*`), "").trim() || line;

      const hintedMonths = parseMonthNumbers(line);
      const prefersMonthEnd = /月底|底前|下旬/.test(line);
      const prefersMonthStart = /月初|上旬/.test(line);

      // Pick the prep week with highest remaining capacity ratio (honoring month hints when present)
      let bestSlot = slotWeights[0];
      let bestScore = -Infinity;
      slotWeights.forEach((slot, sIdx) => {
        const loadPenalty = slot.assigned / Math.max(1, meta.maxTasksPerTeamWeek * Math.max(1, teams.length / 2));
        let monthBonus = 0;
        if (hintedMonths.length > 0) {
          const slotMonths = parseMonthNumbers(slot.week.monthLabel);
          const startMonth = Number(slot.week.dateRange.split("/")[0]);
          if (Number.isFinite(startMonth) && startMonth >= 1 && startMonth <= 12 && !slotMonths.includes(startMonth)) {
            slotMonths.push(startMonth);
          }
          if (slotMonths.some((m) => hintedMonths.includes(m))) {
            monthBonus += 3.2;
            const startDay = Number(slot.week.dateRange.split("/")[1]?.split(/[~-]/)[0] ?? 15);
            if (prefersMonthEnd && startDay >= 18) monthBonus += 0.8;
            else if (prefersMonthStart && startDay <= 12) monthBonus += 0.8;
          } else {
            monthBonus -= 1.5 - sIdx * 0.01;
          }
        }
        const candidateScore = slot.weight + monthBonus - loadPenalty;
        if (candidateScore > bestScore) {
          bestScore = candidateScore;
          bestSlot = slot;
        }
      });
      bestSlot.assigned += 1;

      todos.push({
        teamId: matchedTeam.id,
        weekId: bestSlot.week.id,
        title: cleanTitle,
        priority: /確認|死線|寄出|定案|收齊|驗題|資格|審核/.test(cleanTitle) ? "high" : "normal",
      });
    });
  }

  const weekStages: Array<{ weekId: string; stage: CellStage }> = [];
  usablePrep.forEach((week, idx) => {
    const inBuffer = idx >= activeCutoff;
    const ratio = activeCutoff > 0 ? (idx + 1) / activeCutoff : 1;
    let stage: CellStage = "進度25%";
    if (inBuffer) {
      stage = idx === usablePrep.length - 1 && meta.bufferWeeks >= 1 ? "RC" : "Debug";
    } else if (ratio <= 0.25) {
      stage = "進度25%";
    } else if (ratio <= 0.5) {
      stage = "進度50%";
    } else if (ratio <= 0.75) {
      stage = "進度75%";
    } else {
      stage = "進度100%";
    }
    weekStages.push({ weekId: week.id, stage });
  });
  if (eventWeek) weekStages.push({ weekId: eventWeek.id, stage: "活動" });
  postWeeks.forEach((pw) => weekStages.push({ weekId: pw.id, stage: "復盤" }));
  const weekStageMap = new Map(weekStages.map((ws) => [ws.weekId, ws.stage]));

  const cells: ProposedCellChange[] = [];
  for (const team of teams) {
    usablePrep.forEach((week, idx) => {
      const inBuffer = idx >= activeCutoff;
      const stage = weekStageMap.get(week.id) ?? "進度50%";

      const weekTeamTodos = todos.filter((t) => t.teamId === team.id && t.weekId === week.id);
      const weekMonths = parseMonthNumbers(week.monthLabel);
      const monthGoal = input.monthlyGoals.find((g) => {
        const gMonths = parseMonthNumbers(g.month);
        return (
          (gMonths.length > 0 && weekMonths.some((m) => gMonths.includes(m))) ||
          week.monthLabel.includes(g.month) ||
          g.month.includes(week.monthLabel)
        );
      });
      const trimClause = (s: string, maxLen = 22): string => {
        let clause = s.split(/[；;。（(]/)[0]?.trim() || s.trim();
        if (clause.length > maxLen && clause.includes("，")) {
          const head = clause.split("，")[0]?.trim() ?? "";
          if (head.length >= 6) clause = head;
        }
        return clause.length <= maxLen ? clause : `${clause.slice(0, maxLen - 1)}…`;
      };
      const focus =
        weekTeamTodos.length > 0
          ? weekTeamTodos.map((t) => trimClause(t.title, 20)).slice(0, 2).join(" · ")
          : inBuffer
            ? stage === "RC"
              ? "總彩排驗收與最終確認"
              : "跨組流程除錯與備案檢核"
            : monthGoal?.goal
              ? trimClause(monthGoal.goal, 22)
              : "依排程推進組內交付";

      cells.push({
        weekId: week.id,
        teamId: team.id,
        stage,
        weeklyFocus: focus,
      });
    });

    if (eventWeek) {
      cells.push({
        weekId: eventWeek.id,
        teamId: team.id,
        stage: "活動",
        weeklyFocus: "活動當日執行與現場應變",
      });
    }
    postWeeks.forEach((pw, pIdx) => {
      cells.push({
        weekId: pw.id,
        teamId: team.id,
        stage: "復盤",
        weeklyFocus: pIdx === 0 ? "成果歸檔、感謝信與核銷整理" : "專案復盤檢討與文件交接",
      });
    });
  }

  const weeklyLoadScores = orderedWeeks.map((w) => {
    const hasConflict = w.majorEvents.some((ev) => ev.kind === "conflict");
    const existingCount = snapshot.todos.filter((t) => t.weekId === w.id && !t.done).length;
    const addedCount = todos.filter((t) => t.weekId === w.id).length;
    const rawLoad = w.phase === "event" ? 82 : w.phase === "post" ? 38 : Math.min(95, 22 + (existingCount + addedCount) * 14);
    const score = hasConflict && w.phase === "prep" ? Math.min(52, rawLoad) : rawLoad;
    return {
      weekId: w.id,
      label: w.countdownLabel,
      score,
      hasConflict,
    };
  });

  const conflictNote =
    avoidedConflictWeeks.length > 0
      ? `已自動避開 ${avoidedConflictWeeks.join("、")} 的大型撞期時段，將重頭交付前移或分流；`
      : "";

  return {
    pacing: input.pacing,
    rationale: `採用「${meta.label}」節奏規劃：${conflictNote}${
      meta.bufferWeeks > 0 ? `並在活動前預留 ${meta.bufferWeeks} 週 Debug／RC 驗收緩衝` : "全週期高密度推進"
    }，共分配 ${todos.length} 項關鍵任務。`,
    avoidedConflictWeeks,
    weekStages,
    cells,
    todos,
    weeklyLoadScores,
  };
}
