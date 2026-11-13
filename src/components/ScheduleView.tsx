import { Fragment, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  CalendarPlus,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Flag,
  Gauge,
  Plus,
  Presentation,
  Share2,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  CELL_STAGES,
  PACING_META,
  TEAM_COLORS,
  type AutoSchedulePreview,
  type CampaignSnapshot,
  type CampaignTeam,
  type CampaignWeek,
  type CellStage,
  type MonthlyGoal,
  type PacingLevel,
  type TeamColor,
  type WeekEventItem,
} from "../../shared/types";
import {
  buildAppsScriptSyncCode,
  buildGoogleSheetMatrix,
  buildPacingSchedulePreview,
  buildWeeklyDigestText,
  computeCampaignMetrics,
  matrixToTsv,
} from "../../shared/sheets";
import { apiWrite } from "../lib/api";

function stageSpanClass(stage: CellStage): string {
  if (stage === "待排") return "stage-span-bar is-idle";
  if (stage === "進度100%" || stage === "復盤") return "stage-span-bar is-done";
  if (stage === "Debug" || stage === "RC") return "stage-span-bar is-verify";
  if (stage === "活動") return "stage-span-bar is-live";
  return "stage-span-bar is-progress";
}

export default function ScheduleView({
  snapshot,
  onSnapshot,
  notify,
}: {
  snapshot: CampaignSnapshot;
  onSnapshot: (next: CampaignSnapshot) => void;
  notify: (msg: string) => void;
}) {
  const metrics = useMemo(() => computeCampaignMetrics(snapshot), [snapshot]);
  const orderedWeeks = useMemo(
    () => [...snapshot.weeks].sort((a, b) => a.orderIndex - b.orderIndex),
    [snapshot.weeks],
  );
  const orderedTeams = useMemo(
    () => [...snapshot.teams].sort((a, b) => a.orderIndex - b.orderIndex),
    [snapshot.teams],
  );

  const cellMap = useMemo(
    () => new Map(snapshot.cells.map((c) => [`${c.weekId}:${c.teamId}`, c])),
    [snapshot.cells],
  );

  // Group contiguous month headers cleanly
  const monthSpans = useMemo(() => {
    const spans: Array<{ label: string; span: number }> = [];
    for (const w of orderedWeeks) {
      const last = spans[spans.length - 1];
      if (last && last.label === w.monthLabel) {
        last.span += 1;
      } else {
        spans.push({ label: w.monthLabel, span: 1 });
      }
    }
    return spans;
  }, [orderedWeeks]);

  // Dialog states
  const [aiOpen, setAiOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareTab, setShareTab] = useState<"sheets" | "slides" | "team">("sheets");
  const [slideIdx, setSlideIdx] = useState(0);

  // Cell editor state
  const [editingCell, setEditingCell] = useState<{
    week: CampaignWeek;
    team: CampaignTeam;
    stage: CellStage;
    weeklyFocus: string;
    crossTeam: string;
    newTodo: string;
    spanCount: number;
  } | null>(null);

  // Week editor state (dates, memo, milestones & clashing events)
  const [editingWeek, setEditingWeek] = useState<{
    week: CampaignWeek;
    monthLabel: string;
    dateRange: string;
    countdownLabel: string;
    phase: "prep" | "event" | "post";
    memo: string;
    events: WeekEventItem[];
    newEventTitle: string;
    newEventKind: "milestone" | "conflict";
  } | null>(null);

  // Add week / team state
  const [addTeamOpen, setAddTeamOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamLead, setNewTeamLead] = useState("");
  const [newTeamColor, setNewTeamColor] = useState<TeamColor>("rose");

  const [addWeekOpen, setAddWeekOpen] = useState(false);
  const [newWeekMonth, setNewWeekMonth] = useState("八月");
  const [newWeekRange, setNewWeekRange] = useState("");
  const [newWeekCountdown, setNewWeekCountdown] = useState("活動後 3 周");
  const [newWeekPhase, setNewWeekPhase] = useState<"prep" | "event" | "post">("post");

  // AI Auto-Schedule state
  const [pacing, setPacing] = useState<PacingLevel>(snapshot.campaign.pacing);
  const [mainGoal, setMainGoal] = useState(snapshot.campaign.mainGoal);
  const [monthlyGoals, setMonthlyGoals] = useState<MonthlyGoal[]>(
    snapshot.campaign.monthlyGoals.length > 0
      ? snapshot.campaign.monthlyGoals
      : [
          { month: "六月", goal: "名單研究與企劃啟動" },
          { month: "七月", goal: "講者確認、宣傳發佈與全流程彩排" },
          { month: "八月", goal: "正式活動執行與會後核銷復盤" },
        ],
  );
  const [tasksText, setTasksText] = useState(
    "世界咖啡館：確認圓桌引導手卡與換桌動線\nPanel 與談：收齊 4 位與談人最終投影片備份\n行銷與設計組：排定倒數貼文並避開週末撞期高峰\n場務與志工組：完成報到 QR 驗票壓力測試與茶點確認",
  );
  const [aiBusy, setAiBusy] = useState(false);
  const [aiServerPreview, setAiServerPreview] = useState<AutoSchedulePreview | null>(null);

  // Live instant pacing preview so dragging/clicking pacing stops responds in 0ms!
  const livePreview = useMemo(
    () =>
      aiServerPreview && aiServerPreview.pacing === pacing
        ? aiServerPreview
        : buildPacingSchedulePreview(snapshot, {
            mainGoal,
            monthlyGoals,
            tasksText,
            pacing,
          }),
    [aiServerPreview, snapshot, mainGoal, monthlyGoals, tasksText, pacing],
  );

  // Sheet import state inside Share dialog
  const [sheetUrlInput, setSheetUrlInput] = useState(snapshot.campaign.sheetUrl);
  const [slidesUrlInput, setSlidesUrlInput] = useState(snapshot.campaign.slidesUrl);
  const [csvImportText, setCsvImportText] = useState("");
  const [importBusy, setImportBusy] = useState(false);

  const currentPacingMeta = PACING_META.find((p) => p.id === snapshot.campaign.pacing) ?? PACING_META[2];

  const daysUntilEvent = useMemo(() => {
    const target = Date.parse(`${snapshot.campaign.eventDate}T00:00:00Z`);
    if (!Number.isFinite(target)) return null;
    const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    return Math.round((target - today) / 86400_000);
  }, [snapshot.campaign.eventDate]);

  async function toggleTodoInline(todoId: string, done: boolean, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/todos/${todoId}?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
        "PATCH",
        { done },
      );
      onSnapshot(next);
    } catch (err) {
      notify(err instanceof Error ? err.message : "更新待辦失敗");
    }
  }

  async function saveCellEdit() {
    if (!editingCell) return;
    try {
      const startIdx = orderedWeeks.findIndex((w) => w.id === editingCell.week.id);
      const targetWeeks =
        startIdx >= 0 && editingCell.spanCount > 1
          ? orderedWeeks.slice(startIdx, startIdx + editingCell.spanCount)
          : [editingCell.week];

      let next = snapshot;
      for (let i = 0; i < targetWeeks.length; i += 1) {
        const w = targetWeeks[i];
        const existing = cellMap.get(`${w.id}:${editingCell.team.id}`);
        next = await apiWrite<CampaignSnapshot>(
          `/api/cells?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
          "PUT",
          {
            weekId: w.id,
            teamId: editingCell.team.id,
            stage: editingCell.stage,
            weeklyFocus: i === 0 ? editingCell.weeklyFocus : existing?.weeklyFocus ?? "",
            crossTeam: i === 0 ? editingCell.crossTeam : existing?.crossTeam ?? "",
          },
        );
      }
      if (editingCell.newTodo.trim()) {
        next = await apiWrite<CampaignSnapshot>(`/api/campaigns/${snapshot.campaign.id}/todos`, "POST", {
          teamId: editingCell.team.id,
          weekId: editingCell.week.id,
          title: editingCell.newTodo.trim(),
        });
      }
      onSnapshot(next);
      setEditingCell(null);
      notify(targetWeeks.length > 1 ? `已同步套用階段橫條至連續 ${targetWeeks.length} 週` : "已更新週次進度");
    } catch (err) {
      notify(err instanceof Error ? err.message : "儲存失敗");
    }
  }

  async function saveWeekEdit() {
    if (!editingWeek) return;
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/weeks/${editingWeek.week.id}?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
        "PATCH",
        {
          monthLabel: editingWeek.monthLabel,
          dateRange: editingWeek.dateRange,
          countdownLabel: editingWeek.countdownLabel,
          phase: editingWeek.phase,
          memo: editingWeek.memo,
          majorEvents: editingWeek.events,
        },
      );
      onSnapshot(next);
      setEditingWeek(null);
      notify("已更新週次與撞期標記");
    } catch (err) {
      notify(err instanceof Error ? err.message : "儲存週次失敗");
    }
  }

  async function handleRunAiPreview() {
    setAiBusy(true);
    try {
      const preview = await apiWrite<AutoSchedulePreview>(
        `/api/campaigns/${snapshot.campaign.id}/auto-schedule/preview`,
        "POST",
        { mainGoal, monthlyGoals, tasksText, pacing },
      );
      setAiServerPreview(preview);
      notify("已依緊湊度生成排程預覽");
    } catch (err) {
      notify(err instanceof Error ? err.message : "AI 排程預覽失敗");
    } finally {
      setAiBusy(false);
    }
  }

  async function handleApplyAiSchedule() {
    setAiBusy(true);
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/campaigns/${snapshot.campaign.id}/auto-schedule/apply`,
        "POST",
        {
          pacing,
          mainGoal,
          monthlyGoals,
          preview: {
            cells: livePreview.cells,
            todos: livePreview.todos,
          },
        },
      );
      onSnapshot(next);
      setAiOpen(false);
      notify(`已套用「${PACING_META.find((p) => p.id === pacing)?.label}」時程安排`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "套用排程失敗");
    } finally {
      setAiBusy(false);
    }
  }

  async function handleImportSheet() {
    setImportBusy(true);
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/campaigns/${snapshot.campaign.id}/import-sheet`,
        "POST",
        {
          sheetUrl: sheetUrlInput.trim() || undefined,
          csvText: csvImportText.trim() || undefined,
        },
      );
      onSnapshot(next);
      setCsvImportText("");
      notify("已成功從 Google 試算表結構匯入時程");
    } catch (err) {
      notify(err instanceof Error ? err.message : "匯入試算表失敗");
    } finally {
      setImportBusy(false);
    }
  }

  async function handleSaveLinks() {
    try {
      const next = await apiWrite<CampaignSnapshot>(`/api/campaigns/${snapshot.campaign.id}`, "PATCH", {
        sheetUrl: sheetUrlInput,
        slidesUrl: slidesUrlInput,
      });
      onSnapshot(next);
      notify("已儲存 Google 試算表與簡報連結");
    } catch (err) {
      notify(err instanceof Error ? err.message : "儲存連結失敗");
    }
  }

  async function copyText(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    notify(`已複製${label}`);
  }

  const conflictEvents = useMemo(
    () =>
      orderedWeeks.flatMap((w) =>
        w.majorEvents
          .filter((e) => e.kind === "conflict")
          .map((e) => ({ week: w, event: e })),
      ),
    [orderedWeeks],
  );

  return (
    <>
      {/* Top KPI Summary Cards */}
      <section className="kpi-grid" aria-label="專案關鍵指標">
        <div className="kpi-card">
          <div className="kpi-head">
            <span>整體專案進度</span>
            <span className="pill pill-campaign tabular">{metrics.overallPercent}%</span>
          </div>
          <div className="kpi-value tabular">
            {metrics.completedTodos} / {metrics.totalTodos} <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-3)" }}>項待辦</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${metrics.overallPercent}%` }} />
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-head">
            <span>活動日期與週期</span>
            <span className="tabular" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{snapshot.campaign.eventDate}</span>
          </div>
          <div className="kpi-value tabular">
            {orderedWeeks.length} 週{" "}
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-3)" }}>
              {daysUntilEvent !== null
                ? daysUntilEvent >= 0
                  ? `· 倒數 ${daysUntilEvent} 天`
                  : `· 已舉辦（會後復盤）`
                : ""}
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>
            含會前倒數至活動後 {orderedWeeks.filter((w) => w.phase === "post").length} 週結案
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-head">
            <span>撞期與風險雷達</span>
            <AlertTriangle size={14} style={{ color: conflictEvents.length > 0 ? "var(--warn)" : "var(--text-3)" }} />
          </div>
          <div className="kpi-value tabular">
            {conflictEvents.length} 處{" "}
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-3)" }}>大型撞期警示</span>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {conflictEvents[0] ? `${conflictEvents[0].week.dateRange} ${conflictEvents[0].event.title}` : "各週時段無外部撞期"}
          </div>
        </div>

        <div
          className="kpi-card"
          style={{ cursor: "pointer" }}
          onClick={() => {
            setPacing(snapshot.campaign.pacing);
            setMainGoal(snapshot.campaign.mainGoal);
            setAiOpen(true);
          }}
        >
          <div className="kpi-head">
            <span>排程緊湊度</span>
            <Gauge size={14} style={{ color: "var(--campaign-text)" }} />
          </div>
          <div className="kpi-value">{currentPacingMeta.label}</div>
          <div style={{ fontSize: 12.5, color: "var(--campaign-text)", fontWeight: 500 }}>
            點擊調整節奏或啟動 AI 排程 →
          </div>
        </div>
      </section>

      {/* Master Weekly Countdown Matrix */}
      <section className="matrix-card" aria-label="每週倒數時程矩陣">
        <div className="matrix-toolbar">
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 14.5 }}>每週時程矩陣</strong>
            <span className="pill">{orderedTeams.length} 組別 × {orderedWeeks.length} 週</span>
            {snapshot.campaign.sheetUrl && (
              <a
                href={snapshot.campaign.sheetUrl}
                target="_blank"
                rel="noreferrer"
                className="pill"
                style={{ color: "var(--ok)", borderColor: "var(--ok-line)", background: "var(--ok-bg)" }}
              >
                <FileSpreadsheet size={12} />
                <span>已連結 Google 試算表</span>
                <ExternalLink size={11} />
              </a>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-sm" onClick={() => setAddTeamOpen(true)}>
              <Users size={13} />
              <span>新增組別</span>
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setAddWeekOpen(true)}>
              <CalendarPlus size={13} />
              <span>新增週次</span>
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setShareOpen(true)}>
              <Share2 size={13} />
              <span>試算表 · 簡報分享</span>
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setPacing(snapshot.campaign.pacing);
                setMainGoal(snapshot.campaign.mainGoal);
                setAiOpen(true);
              }}
            >
              <Sparkles size={13} />
              <span>AI 自動排程</span>
            </button>
          </div>
        </div>

        <div className="matrix-viewport">
          <table className="schedule-table">
            <thead>
              {/* Row 1: Month Spans */}
              <tr>
                <th className="sticky-col month-band-cell">月份 ／ 組別</th>
                {monthSpans.map((m, idx) => (
                  <th key={`${m.label}-${idx}`} colSpan={m.span} className="month-band-cell">
                    {m.label}
                  </th>
                ))}
              </tr>

              {/* Row 2: Week Dates, Countdown, Weekly %, and Major Events / Clashing Activities */}
              <tr>
                <th className="sticky-col" style={{ padding: "12px", background: "var(--panel)" }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)" }}>倒數與整體進度</div>
                  <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 4, fontWeight: 400 }}>
                    點擊任一週標題可記錄撞期活動或重要死線
                  </div>
                </th>
                {orderedWeeks.map((week) => {
                  const wp = metrics.weekProgress[week.id] ?? { percent: 0, done: 0, total: 0, hasConflict: false };
                  return (
                    <th
                      key={week.id}
                      className={`week-head-cell ${week.phase === "event" ? "is-event-week" : ""} ${wp.hasConflict ? "has-conflict" : ""}`}
                      onClick={() =>
                        setEditingWeek({
                          week,
                          monthLabel: week.monthLabel,
                          dateRange: week.dateRange,
                          countdownLabel: week.countdownLabel,
                          phase: week.phase,
                          memo: week.memo,
                          events: [...week.majorEvents],
                          newEventTitle: "",
                          newEventKind: "conflict",
                        })
                      }
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
                        <span className="week-countdown">{week.countdownLabel}</span>
                        <span className="week-dates tabular">{week.dateRange}</span>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                        <div className="progress-track" style={{ height: 4, flex: 1 }}>
                          <div className="progress-fill" style={{ width: `${wp.percent}%` }} />
                        </div>
                        <span className="tabular" style={{ fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--text-2)" }}>
                          {wp.percent}%
                        </span>
                      </div>

                      {week.majorEvents.map((ev) => (
                        <div key={ev.id} className={`event-flag ${ev.kind === "conflict" ? "is-conflict" : "is-milestone"}`}>
                          {ev.kind === "conflict" ? (
                            <AlertTriangle size={12} style={{ marginTop: 2, flexShrink: 0 }} />
                          ) : (
                            <Flag size={12} style={{ marginTop: 2, flexShrink: 0 }} />
                          )}
                          <span>{ev.title}</span>
                        </div>
                      ))}

                      {week.memo && (
                        <div style={{ marginTop: 5, fontSize: 11.5, color: "var(--text-3)", fontWeight: 400 }}>
                          備註：{week.memo}
                        </div>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>

            <tbody>
              {orderedTeams.map((team) => {
                const tp = metrics.teamProgress[team.id] ?? { percent: 0, done: 0, total: 0, latestStage: "待排" };
                const stageRuns: Array<{ stage: CellStage; weeks: CampaignWeek[] }> = [];
                for (const w of orderedWeeks) {
                  const st = cellMap.get(`${w.id}:${team.id}`)?.stage ?? "待排";
                  const prev = stageRuns[stageRuns.length - 1];
                  if (prev && prev.stage === st) {
                    prev.weeks.push(w);
                  } else {
                    stageRuns.push({ stage: st, weeks: [w] });
                  }
                }

                return (
                  <Fragment key={team.id}>
                    {/* Row A: Merged Continuous Horizontal Stage Ribbon (`colSpan`) */}
                    <tr className="stage-ribbon-row">
                      <td className="sticky-col team-row-header" rowSpan={2}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                          <span className={`team-dot team-dot-${team.color}`} />
                          <strong style={{ fontSize: 13.5 }}>{team.name}</strong>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 4 }}>
                          {team.lead ? `負責：${team.lead}` : "尚未指派組長"}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
                          <div className="progress-track" style={{ height: 5, flex: 1 }}>
                            <div className="progress-fill" style={{ width: `${tp.percent}%` }} />
                          </div>
                          <span className="tabular" style={{ fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--text-2)" }}>
                            {tp.percent}%
                          </span>
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 3 }}>
                          待辦 {tp.done}/{tp.total} 完成
                        </div>
                      </td>

                      {stageRuns.map((run) => {
                        const firstWeek = run.weeks[0];
                        const lastWeek = run.weeks[run.weeks.length - 1];
                        const firstCell = cellMap.get(`${firstWeek.id}:${team.id}`);
                        const isAllPost = run.weeks.every((w) => w.phase === "post");
                        const startDay = firstWeek.dateRange.split(/[–~-]/)[0]?.trim() ?? firstWeek.dateRange;
                        const endDay = lastWeek.dateRange.split(/[–~-]/).pop()?.trim() ?? lastWeek.dateRange;
                        return (
                          <td
                            key={`ribbon-${team.id}-${firstWeek.id}`}
                            colSpan={run.weeks.length}
                            className={`stage-ribbon-cell ${isAllPost ? "is-post" : ""}`}
                          >
                            <div
                              className={stageSpanClass(run.stage)}
                              role="button"
                              tabIndex={0}
                              title="點擊調整此階段與連續週數"
                              onClick={() =>
                                setEditingCell({
                                  week: firstWeek,
                                  team,
                                  stage: run.stage,
                                  weeklyFocus: firstCell?.weeklyFocus ?? "",
                                  crossTeam: firstCell?.crossTeam ?? "",
                                  newTodo: "",
                                  spanCount: run.weeks.length,
                                })
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setEditingCell({
                                    week: firstWeek,
                                    team,
                                    stage: run.stage,
                                    weeklyFocus: firstCell?.weeklyFocus ?? "",
                                    crossTeam: firstCell?.crossTeam ?? "",
                                    newTodo: "",
                                    spanCount: run.weeks.length,
                                  });
                                }
                              }}
                            >
                              <span>{run.stage}</span>
                              {run.weeks.length > 1 && (
                                <span className="stage-span-meta">
                                  連續 {run.weeks.length} 週 · {startDay}–{endDay}
                                </span>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>

                    {/* Row B: Per-Week Focus & Todos (Deduplicating Repeated Focus/CrossTeam) */}
                    <tr>
                      {orderedWeeks.map((week, wIdx) => {
                        const cell = cellMap.get(`${week.id}:${team.id}`);
                        const stage = cell?.stage ?? "待排";
                        const prevWeek = wIdx > 0 ? orderedWeeks[wIdx - 1] : null;
                        const prevCell = prevWeek ? cellMap.get(`${prevWeek.id}:${team.id}`) : undefined;

                        const curFocus = (cell?.weeklyFocus ?? "").trim();
                        const prevFocus = (prevCell?.weeklyFocus ?? "").trim();
                        const showFocus = Boolean(curFocus) && curFocus !== prevFocus;

                        const curCross = (cell?.crossTeam ?? "").trim();
                        const prevCross = (prevCell?.crossTeam ?? "").trim();
                        const showCross = Boolean(curCross) && curCross !== prevCross;

                        const cellTodos = snapshot.todos.filter((td) => td.teamId === team.id && td.weekId === week.id);
                        const isEmptyBody = !showFocus && !showCross && cellTodos.length === 0;

                        return (
                          <td
                            key={`${week.id}:${team.id}`}
                            className={`matrix-cell ${week.phase === "post" ? "is-post" : ""}`}
                            onClick={() =>
                              setEditingCell({
                                week,
                                team,
                                stage,
                                weeklyFocus: cell?.weeklyFocus ?? "",
                                crossTeam: cell?.crossTeam ?? "",
                                newTodo: "",
                                spanCount: 1,
                              })
                            }
                          >
                            {cellTodos.length > 0 && (
                              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 2 }}>
                                <span className="tabular" style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--font-mono)" }}>
                                  待辦 {cellTodos.filter((t) => t.done).length}/{cellTodos.length}
                                </span>
                              </div>
                            )}

                            {showFocus && (
                              <div className="cell-focus" style={{ marginTop: 2 }}>
                                {curFocus}
                              </div>
                            )}

                            {cellTodos.length > 0 && (
                              <ul className="cell-todo-list">
                                {cellTodos.map((td) => (
                                  <li key={td.id} className={`cell-todo-item ${td.done ? "is-done" : ""}`}>
                                    <button
                                      type="button"
                                      aria-label={`切換完成：${td.title}`}
                                      onClick={(e) => toggleTodoInline(td.id, !td.done, e)}
                                      style={{
                                        border: "none",
                                        background: "transparent",
                                        padding: 0,
                                        marginTop: 1,
                                        cursor: "pointer",
                                        color: td.done ? "var(--ok)" : "var(--text-3)",
                                        flexShrink: 0,
                                      }}
                                    >
                                      {td.done ? <CheckCircle2 size={13} /> : <Circle size={13} />}
                                    </button>
                                    <span>{td.title}</span>
                                  </li>
                                ))}
                              </ul>
                            )}

                            {showCross && <div className="cell-cross">跨部：{curCross}</div>}

                            {isEmptyBody && (
                              <div style={{ fontSize: 12, color: "var(--text-4)", paddingTop: 2 }}>
                                {curFocus ? "↳ 延續上週重點" : "＋ 點擊補充重點或待辦"}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Dialog 1: Edit Cell (Stage, Multi-Week Span, Weekly Focus, Cross-Team, Quick Todo) ── */}
      <Dialog.Root open={Boolean(editingCell)} onOpenChange={(o) => !o && setEditingCell(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            {editingCell && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <Dialog.Title style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                    {editingCell.team.name} · {editingCell.week.countdownLabel}（{editingCell.week.dateRange}）
                  </Dialog.Title>
                  <Dialog.Close asChild>
                    <button type="button" className="icon-btn" aria-label="關閉">
                      <X size={15} />
                    </button>
                  </Dialog.Close>
                </div>

                <div>
                  <label className="field-label">當週階段與完成度（連續相同階段會自動合併為一條橫幅）</label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {CELL_STAGES.map((st) => (
                      <button
                        key={st}
                        type="button"
                        className={`btn btn-sm ${editingCell.stage === st ? "btn-primary" : ""}`}
                        onClick={() => setEditingCell({ ...editingCell, stage: st })}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="field-label">階段橫跨週數（從本週起算）</label>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {[1, 2, 3, 4].map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`btn btn-sm ${editingCell.spanCount === n ? "btn-primary" : ""}`}
                        onClick={() => setEditingCell({ ...editingCell, spanCount: n })}
                      >
                        {n === 1 ? "僅本週" : `連續 ${n} 週`}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="field-label">本週進度重點</label>
                  <input
                    className="input"
                    value={editingCell.weeklyFocus}
                    onChange={(e) => setEditingCell({ ...editingCell, weeklyFocus: e.target.value })}
                    placeholder="例如：第一波邀請信寄出、講者行前通知定稿"
                  />
                </div>

                <div>
                  <label className="field-label">跨部合作事項</label>
                  <input
                    className="input"
                    value={editingCell.crossTeam}
                    onChange={(e) => setEditingCell({ ...editingCell, crossTeam: e.target.value })}
                    placeholder="例如：與行銷組對齊講者介紹圖卡與圓桌題綱"
                  />
                </div>

                <div>
                  <label className="field-label">在此週新增組內待辦（選填）</label>
                  <input
                    className="input"
                    value={editingCell.newTodo}
                    onChange={(e) => setEditingCell({ ...editingCell, newTodo: e.target.value })}
                    placeholder="輸入後隨儲存一併建立待辦事項"
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                  <button type="button" className="btn" onClick={() => setEditingCell(null)}>
                    取消
                  </button>
                  <button type="button" className="btn btn-primary" onClick={saveCellEdit}>
                    儲存進度
                  </button>
                </div>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── Dialog 2: Edit Week & Clashing Activities (`撞期大型活動`) ── */}
      <Dialog.Root open={Boolean(editingWeek)} onOpenChange={(o) => !o && setEditingWeek(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            {editingWeek && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <Dialog.Title style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                    編輯週次與撞期警示 · {editingWeek.week.countdownLabel}
                  </Dialog.Title>
                  <Dialog.Close asChild>
                    <button type="button" className="icon-btn" aria-label="關閉">
                      <X size={15} />
                    </button>
                  </Dialog.Close>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                  <div>
                    <label className="field-label">月份</label>
                    <input
                      className="input"
                      value={editingWeek.monthLabel}
                      onChange={(e) => setEditingWeek({ ...editingWeek, monthLabel: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="field-label">日期區間</label>
                    <input
                      className="input"
                      value={editingWeek.dateRange}
                      onChange={(e) => setEditingWeek({ ...editingWeek, dateRange: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="field-label">倒數標籤</label>
                    <input
                      className="input"
                      value={editingWeek.countdownLabel}
                      onChange={(e) => setEditingWeek({ ...editingWeek, countdownLabel: e.target.value })}
                    />
                  </div>
                </div>

                <div>
                  <label className="field-label">重大事件與撞期活動（標記為「撞期避開」時，AI 排程會自動避開此週重頭交付）</label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
                    {editingWeek.events.map((ev) => (
                      <div
                        key={ev.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "6px 10px",
                          borderRadius: "var(--radius-sm)",
                          background: ev.kind === "conflict" ? "var(--warn-bg)" : "var(--campaign-tint)",
                          color: ev.kind === "conflict" ? "var(--warn)" : "var(--campaign-text)",
                          fontSize: 13,
                        }}
                      >
                        <span>
                          [{ev.kind === "conflict" ? "撞期避開" : "重要里程碑"}] {ev.title}
                        </span>
                        <button
                          type="button"
                          className="btn-ghost"
                          style={{ border: "none", cursor: "pointer", padding: 2 }}
                          onClick={() =>
                            setEditingWeek({
                              ...editingWeek,
                              events: editingWeek.events.filter((x) => x.id !== ev.id),
                            })
                          }
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <select
                      className="select"
                      style={{ width: 136 }}
                      value={editingWeek.newEventKind}
                      onChange={(e) =>
                        setEditingWeek({
                          ...editingWeek,
                          newEventKind: e.target.value as "milestone" | "conflict",
                        })
                      }
                    >
                      <option value="conflict">⚠️ 撞期活動</option>
                      <option value="milestone">📌 重要里程碑</option>
                    </select>
                    <input
                      className="input"
                      value={editingWeek.newEventTitle}
                      onChange={(e) => setEditingWeek({ ...editingWeek, newEventTitle: e.target.value })}
                      placeholder="例如：8/8~8/9 COSCUP 開源年會撞期"
                    />
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        if (!editingWeek.newEventTitle.trim()) return;
                        setEditingWeek({
                          ...editingWeek,
                          events: [
                            ...editingWeek.events,
                            {
                              id: `ev-${Date.now()}`,
                              title: editingWeek.newEventTitle.trim(),
                              kind: editingWeek.newEventKind,
                            },
                          ],
                          newEventTitle: "",
                        });
                      }}
                    >
                      加入
                    </button>
                  </div>
                </div>

                <div>
                  <label className="field-label">週次備註</label>
                  <input
                    className="input"
                    value={editingWeek.memo}
                    onChange={(e) => setEditingWeek({ ...editingWeek, memo: e.target.value })}
                    placeholder="例如：7/5 送出第一波邀請"
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button type="button" className="btn" onClick={() => setEditingWeek(null)}>
                    取消
                  </button>
                  <button type="button" className="btn btn-primary" onClick={saveWeekEdit}>
                    儲存週次設定
                  </button>
                </div>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── Dialog 3: AI Auto-Scheduler & Tactile Pacing Rhythm Studio ── */}
      <Dialog.Root open={aiOpen} onOpenChange={setAiOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content is-wide">
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <Dialog.Title style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
                    AI 自動排程與時程緊湊度調節
                  </Dialog.Title>
                  <Dialog.Description style={{ margin: "2px 0 0", fontSize: 13, color: "var(--text-3)" }}>
                    輸入目標與待辦清單，自由切換排程節奏並自動避開撞期時段
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <button type="button" className="icon-btn" aria-label="關閉">
                    <X size={15} />
                  </button>
                </Dialog.Close>
              </div>

              {/* Tactile 5-Stop Pacing Rhythm Selector + Live Load Bars */}
              <div className="pacing-box">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 13.5 }}>時程緊湊度節奏桿</strong>
                  <span className="pill pill-campaign">
                    {PACING_META.find((p) => p.id === pacing)?.summary}
                  </span>
                </div>

                <div className="pacing-stops" role="radiogroup" aria-label="時程緊湊度">
                  {PACING_META.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={pacing === p.id}
                      className={`pacing-stop-btn ${pacing === p.id ? "is-active" : ""}`}
                      onClick={() => setPacing(p.id)}
                    >
                      <span>{p.label}</span>
                    </button>
                  ))}
                </div>

                {/* Live Weekly Load Rhythm Visualization */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-3)" }}>
                    <span>各週工作負載分佈預覽（橘色代表已自動壓低負載的撞期週）</span>
                    <span>提議新增 {livePreview.todos.length} 項任務</span>
                  </div>
                  <div className="load-rhythm-strip">
                    {livePreview.weeklyLoadScores.map((item) => (
                      <div key={item.weekId} className="load-bar-col" title={`${item.label}：負載指數 ${item.score}`}>
                        <div
                          className={`load-bar ${item.hasConflict ? "is-conflict" : ""}`}
                          style={{ height: `${Math.max(14, Math.round(item.score * 0.58))}px` }}
                        />
                        <span style={{ fontSize: 11, color: "var(--text-3)", whiteSpace: "nowrap" }}>
                          {item.label.replace("倒數 ", "W-").replace(" 周", "").replace("活動當周", "D-Day").replace("活動後 ", "W+")}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label className="field-label">專案主要目標</label>
                  <textarea
                    className="textarea"
                    rows={2}
                    value={mainGoal}
                    onChange={(e) => setMainGoal(e.target.value)}
                    placeholder="例如：凝聚 180 位社群參與者，準時完成講者邀約與宣傳"
                  />
                </div>
                <div>
                  <label className="field-label">每月核心目標（月份：目標，每行一筆）</label>
                  <textarea
                    className="textarea"
                    rows={2}
                    value={monthlyGoals.map((g) => `${g.month}：${g.goal}`).join("\n")}
                    onChange={(e) => {
                      const next = e.target.value
                        .split(/\n+/)
                        .map((line) => {
                          const [m, ...rest] = line.split(/[:：]/);
                          return { month: (m ?? "").trim() || "當月", goal: rest.join("：").trim() };
                        })
                        .filter((g) => g.month || g.goal);
                      setMonthlyGoals(next);
                    }}
                  />
                </div>
              </div>

              <div>
                <label className="field-label">想完成的任務與交付事項（每行一項，可冠上組別名稱）</label>
                <textarea
                  className="textarea"
                  rows={4}
                  value={tasksText}
                  onChange={(e) => setTasksText(e.target.value)}
                />
              </div>

              <div
                style={{
                  background: "var(--panel)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--radius-sm)",
                  padding: "10px 12px",
                  fontSize: 13,
                  color: "var(--text-2)",
                }}
              >
                <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>排程預覽摘要</div>
                <div>{livePreview.rationale}</div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="btn" disabled={aiBusy} onClick={handleRunAiPreview}>
                  <Sparkles size={14} />
                  <span>{aiBusy ? "AI 運算中…" : "重新推演排程"}</span>
                </button>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="btn" onClick={() => setAiOpen(false)}>
                    取消
                  </button>
                  <button type="button" className="btn btn-primary" disabled={aiBusy} onClick={handleApplyAiSchedule}>
                    <Check size={14} />
                    <span>套用排程至時程表</span>
                  </button>
                </div>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── Dialog 4: Google Sheets · Google Slides · Team Sharing Studio ── */}
      <Dialog.Root open={shareOpen} onOpenChange={setShareOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content is-wide">
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Dialog.Title style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
                  Google 試算表 · 簡報與團隊協作分享
                </Dialog.Title>
                <Dialog.Close asChild>
                  <button type="button" className="icon-btn" aria-label="關閉">
                    <X size={15} />
                  </button>
                </Dialog.Close>
              </div>

              <div style={{ display: "flex", gap: 6, borderBottom: "1px solid var(--line)", paddingBottom: 10 }}>
                <button
                  type="button"
                  className={`btn btn-sm ${shareTab === "sheets" ? "btn-primary" : ""}`}
                  onClick={() => setShareTab("sheets")}
                >
                  <FileSpreadsheet size={13} />
                  <span>Google 試算表連結與匯出</span>
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${shareTab === "slides" ? "btn-primary" : ""}`}
                  onClick={() => setShareTab("slides")}
                >
                  <Presentation size={13} />
                  <span>Google 簡報與投影片檢視</span>
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${shareTab === "team" ? "btn-primary" : ""}`}
                  onClick={() => setShareTab("team")}
                >
                  <Share2 size={13} />
                  <span>單檔網頁與群組週報</span>
                </button>
              </div>

              {shareTab === "sheets" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10 }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => copyText(matrixToTsv(buildGoogleSheetMatrix(snapshot)), "試算表矩陣（可直接 ⌘V 貼入 Google 試算表 A1）")}
                    >
                      <Copy size={14} />
                      <span>複製矩陣直貼 Google 試算表</span>
                    </button>
                    <a className="btn" href={`/api/campaigns/${snapshot.campaign.id}/export.csv`} download>
                      <Download size={14} />
                      <span>下載 .csv 試算表檔</span>
                    </a>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => copyText(buildAppsScriptSyncCode(snapshot), " Google Apps Script 自動寫入腳本")}
                    >
                      <FileSpreadsheet size={14} />
                      <span>複製 Apps Script 自動同步碼</span>
                    </button>
                  </div>

                  <div>
                    <label className="field-label">連結團隊共用的 Google 試算表網址（支援從公開試算表直接匯入結構）</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        className="input"
                        value={sheetUrlInput}
                        onChange={(e) => setSheetUrlInput(e.target.value)}
                        placeholder="https://docs.google.com/spreadsheets/d/..."
                      />
                      <button type="button" className="btn" onClick={handleSaveLinks}>
                        綁定網址
                      </button>
                      <button type="button" className="btn" disabled={importBusy} onClick={handleImportSheet}>
                        {importBusy ? "匯入中…" : "從此試算表匯入"}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="field-label">或貼上 Google 試算表匯出的 CSV 文字直接建立週次與組別</label>
                    <textarea
                      className="textarea"
                      rows={3}
                      value={csvImportText}
                      onChange={(e) => setCsvImportText(e.target.value)}
                      placeholder="貼上包含「月、日期、倒數週數、各組完成度／本週進度／待辦事項」的 CSV…"
                    />
                  </div>
                </div>
              )}

              {shareTab === "slides" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div className="slide-stage">
                    {slideIdx === 0 && (
                      <>
                        <div>
                          <span className="pill pill-campaign">SLIDE 01 · 專案總覽</span>
                          <h3 style={{ fontSize: 24, margin: "12px 0 6px" }}>{snapshot.campaign.name}</h3>
                          <p style={{ margin: 0, color: "var(--text-2)", fontSize: 14.5 }}>
                            {snapshot.campaign.mainGoal || snapshot.campaign.subtitle}
                          </p>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                          <div className="kpi-card">
                            <span style={{ fontSize: 12, color: "var(--text-3)" }}>正式活動日</span>
                            <strong className="tabular" style={{ fontSize: 18 }}>{snapshot.campaign.eventDate}</strong>
                          </div>
                          <div className="kpi-card">
                            <span style={{ fontSize: 12, color: "var(--text-3)" }}>整體完成度</span>
                            <strong className="tabular" style={{ fontSize: 18 }}>{metrics.overallPercent}%</strong>
                          </div>
                          <div className="kpi-card">
                            <span style={{ fontSize: 12, color: "var(--text-3)" }}>排程節奏</span>
                            <strong style={{ fontSize: 18 }}>{currentPacingMeta.label}</strong>
                          </div>
                        </div>
                      </>
                    )}

                    {slideIdx === 1 && (
                      <>
                        <div>
                          <span className="pill pill-warn">SLIDE 02 · 重大里程碑與撞期避開雷達</span>
                          <h3 style={{ fontSize: 20, margin: "10px 0 12px" }}>關鍵時間點與外部撞期活動</h3>
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {orderedWeeks
                              .filter((w) => w.majorEvents.length > 0)
                              .slice(0, 5)
                              .map((w) => (
                                <div
                                  key={w.id}
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    padding: "8px 12px",
                                    background: "var(--panel)",
                                    borderRadius: "var(--radius-sm)",
                                    border: "1px solid var(--line)",
                                  }}
                                >
                                  <strong>
                                    {w.countdownLabel}（{w.dateRange}）
                                  </strong>
                                  <span>
                                    {w.majorEvents.map((e) => `${e.kind === "conflict" ? "⚠️" : "📌"} ${e.title}`).join(" · ")}
                                  </span>
                                </div>
                              ))}
                          </div>
                        </div>
                        <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>
                          BELL Campaign 時程簡報檢視 · 可直接投影於籌備週會
                        </div>
                      </>
                    )}

                    {slideIdx === 2 && (
                      <>
                        <div>
                          <span className="pill pill-ok">SLIDE 03 · 各大組別進度快報</span>
                          <h3 style={{ fontSize: 20, margin: "10px 0 12px" }}>各組完成度與優先推進事項</h3>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                            {orderedTeams.map((t) => {
                              const tp = metrics.teamProgress[t.id];
                              const nextTodo = snapshot.todos.find((td) => td.teamId === t.id && !td.done);
                              return (
                                <div key={t.id} className="kpi-card" style={{ padding: "10px 12px" }}>
                                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                                    <strong>{t.name}</strong>
                                    <span className="tabular">{tp?.percent ?? 0}%</span>
                                  </div>
                                  <div className="progress-track" style={{ height: 5 }}>
                                    <div className="progress-fill" style={{ width: `${tp?.percent ?? 0}%` }} />
                                  </div>
                                  <div style={{ fontSize: 12, color: "var(--text-2)" }}>
                                    下一步：{nextTodo ? nextTodo.title : "本階段待辦已完成"}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>總待辦完成：{metrics.completedTodos}/{metrics.totalTodos}</div>
                      </>
                    )}
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setSlideIdx((i) => (i + 2) % 3)}
                      >
                        <ChevronLeft size={14} />
                        <span>上一張</span>
                      </button>
                      <span className="tabular" style={{ fontSize: 13, color: "var(--text-2)" }}>
                        {slideIdx + 1} / 3
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setSlideIdx((i) => (i + 1) % 3)}
                      >
                        <span>下一張</span>
                        <ChevronRight size={14} />
                      </button>
                    </div>

                    <div style={{ display: "flex", gap: 8, flex: 1, justifyContent: "flex-end", minWidth: 260 }}>
                      <input
                        className="input"
                        style={{ maxWidth: 280, height: 30 }}
                        value={slidesUrlInput}
                        onChange={(e) => setSlidesUrlInput(e.target.value)}
                        placeholder="綁定 Google 簡報網址 https://docs.google.com/presentation/..."
                      />
                      <button type="button" className="btn btn-sm" onClick={handleSaveLinks}>
                        儲存連結
                      </button>
                      {snapshot.campaign.slidesUrl && (
                        <a href={snapshot.campaign.slidesUrl} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm">
                          <span>開啟簡報</span>
                          <ExternalLink size={12} />
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {shareTab === "team" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <a className="btn btn-primary" href={`/api/campaigns/${snapshot.campaign.id}/export.html`} download>
                      <Download size={14} />
                      <span>下載單檔互動時程網頁 (.html)</span>
                    </a>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => copyText(buildWeeklyDigestText(snapshot), "群組進度週報（可直貼 LINE／Discord／Slack）")}
                    >
                      <Copy size={14} />
                      <span>複製本週團隊週報文字</span>
                    </button>
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 14,
                      borderRadius: "var(--radius-sm)",
                      background: "var(--panel)",
                      border: "1px solid var(--line)",
                      fontSize: 12.5,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    {buildWeeklyDigestText(snapshot)}
                  </pre>
                </div>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── Dialog 5: Add Team ── */}
      <Dialog.Root open={addTeamOpen} onOpenChange={setAddTeamOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content" style={{ maxWidth: 440 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Dialog.Title style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>新增專案組別</Dialog.Title>
              <div>
                <label className="field-label">組別名稱</label>
                <input
                  className="input"
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  placeholder="例如：公關贊助組"
                />
              </div>
              <div>
                <label className="field-label">組長／負責人</label>
                <input
                  className="input"
                  value={newTeamLead}
                  onChange={(e) => setNewTeamLead(e.target.value)}
                  placeholder="選填"
                />
              </div>
              <div>
                <label className="field-label">代表色</label>
                <div style={{ display: "flex", gap: 8 }}>
                  {TEAM_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`btn btn-sm ${newTeamColor === c ? "btn-primary" : ""}`}
                      onClick={() => setNewTeamColor(c)}
                    >
                      <span className={`team-dot team-dot-${c}`} />
                      <span>{c}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
                <button type="button" className="btn" onClick={() => setAddTeamOpen(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={async () => {
                    if (!newTeamName.trim()) return;
                    const next = await apiWrite<CampaignSnapshot>(
                      `/api/campaigns/${snapshot.campaign.id}/teams`,
                      "POST",
                      { name: newTeamName.trim(), lead: newTeamLead.trim(), color: newTeamColor },
                    );
                    onSnapshot(next);
                    setNewTeamName("");
                    setNewTeamLead("");
                    setAddTeamOpen(false);
                    notify("已新增組別");
                  }}
                >
                  <Plus size={14} />
                  <span>建立組別</span>
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── Dialog 6: Add Week ── */}
      <Dialog.Root open={addWeekOpen} onOpenChange={setAddWeekOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content" style={{ maxWidth: 440 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Dialog.Title style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>新增時程週次</Dialog.Title>
              <div>
                <label className="field-label">所屬月份</label>
                <input className="input" value={newWeekMonth} onChange={(e) => setNewWeekMonth(e.target.value)} />
              </div>
              <div>
                <label className="field-label">日期區間</label>
                <input
                  className="input"
                  value={newWeekRange}
                  onChange={(e) => setNewWeekRange(e.target.value)}
                  placeholder="例如：8/24~8/30"
                />
              </div>
              <div>
                <label className="field-label">倒數／會後標籤</label>
                <input className="input" value={newWeekCountdown} onChange={(e) => setNewWeekCountdown(e.target.value)} />
              </div>
              <div>
                <label className="field-label">階段性質</label>
                <select
                  className="select"
                  value={newWeekPhase}
                  onChange={(e) => setNewWeekPhase(e.target.value as "prep" | "event" | "post")}
                >
                  <option value="prep">會前籌備週</option>
                  <option value="event">活動當週</option>
                  <option value="post">活動後復盤／結案週</option>
                </select>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
                <button type="button" className="btn" onClick={() => setAddWeekOpen(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={async () => {
                    if (!newWeekRange.trim() || !newWeekCountdown.trim()) return;
                    const next = await apiWrite<CampaignSnapshot>(
                      `/api/campaigns/${snapshot.campaign.id}/weeks`,
                      "POST",
                      {
                        monthLabel: newWeekMonth.trim() || "當月",
                        dateRange: newWeekRange.trim(),
                        countdownLabel: newWeekCountdown.trim(),
                        phase: newWeekPhase,
                      },
                    );
                    onSnapshot(next);
                    setNewWeekRange("");
                    setAddWeekOpen(false);
                    notify("已新增週次欄位");
                  }}
                >
                  <Plus size={14} />
                  <span>新增週次</span>
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
