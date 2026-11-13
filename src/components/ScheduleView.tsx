import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  CalendarPlus,
  CalendarRange,
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
  buildWeeklyTimelineDefs,
  computeCampaignMetrics,
  formatCampaignDateLabel,
  matrixToTsv,
  stageToPercent,
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

  // Group contiguous month epochs across the full timeline (supports multi-month & cross-year spans)
  const monthEpochs = useMemo(() => {
    const epochs: Array<{ id: string; label: string; weeks: CampaignWeek[] }> = [];
    for (const w of orderedWeeks) {
      const last = epochs[epochs.length - 1];
      if (last && last.label === w.monthLabel) {
        last.weeks.push(w);
      } else {
        epochs.push({ id: `${epochs.length}:${w.monthLabel}`, label: w.monthLabel, weeks: [w] });
      }
    }
    return epochs;
  }, [orderedWeeks]);

  const [monthFilter, setMonthFilter] = useState<string>("all");
  const activeEpoch = useMemo(
    () => (monthFilter === "all" ? null : monthEpochs.find((e) => e.id === monthFilter) ?? null),
    [monthEpochs, monthFilter],
  );
  const visibleWeeks = activeEpoch ? activeEpoch.weeks : orderedWeeks;

  // Group contiguous month headers cleanly for currently visible weeks
  const monthSpans = useMemo(() => {
    const spans: Array<{ label: string; span: number }> = [];
    for (const w of visibleWeeks) {
      const last = spans[spans.length - 1];
      if (last && last.label === w.monthLabel) {
        last.span += 1;
      } else {
        spans.push({ label: w.monthLabel, span: 1 });
      }
    }
    return spans;
  }, [visibleWeeks]);

  // Unified top-level project progress runs (merging consecutive identical stages into one continuous line)
  const projectStageRuns = useMemo(() => {
    const runs: Array<{ stage: CellStage; weeks: CampaignWeek[] }> = [];
    for (const w of visibleWeeks) {
      const st = w.stage ?? "待排";
      const prev = runs[runs.length - 1];
      if (prev && prev.stage === st) {
        prev.weeks.push(w);
      } else {
        runs.push({ stage: st, weeks: [w] });
      }
    }
    return runs;
  }, [visibleWeeks]);

  // Dialog states
  const [aiOpen, setAiOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [tlStartDate, setTlStartDate] = useState(snapshot.campaign.startDate);
  const [tlEventDate, setTlEventDate] = useState(snapshot.campaign.eventDate);
  const [tlPostWeeks, setTlPostWeeks] = useState(snapshot.campaign.postWeeks);
  const [tlTentative, setTlTentative] = useState(snapshot.campaign.dateTentative);
  const [tlTentativeNote, setTlTentativeNote] = useState(snapshot.campaign.tentativeNote);
  const [tlBusy, setTlBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareTab, setShareTab] = useState<"sheets" | "slides" | "team">("sheets");
  const [slideIdx, setSlideIdx] = useState(0);

  // Cell editor state (team weekly focus, cross-team & todos only — progress stage lives in unified top bar)
  const [editingCell, setEditingCell] = useState<{
    week: CampaignWeek;
    team: CampaignTeam;
    weeklyFocus: string;
    crossTeam: string;
    newTodo: string;
  } | null>(null);

  // Week editor state (unified project progress stage, span, dates, memo, milestones & clashing events)
  const [editingWeek, setEditingWeek] = useState<{
    week: CampaignWeek;
    stage: CellStage;
    spanCount: number;
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

  const timelinePreview = useMemo(
    () =>
      buildWeeklyTimelineDefs({
        startDate: tlStartDate,
        eventDate: tlEventDate,
        postWeeks: tlPostWeeks,
        dateTentative: tlTentative,
      }),
    [tlStartDate, tlEventDate, tlPostWeeks, tlTentative],
  );

  function openAiDialog() {
    setPacing(snapshot.campaign.pacing);
    setMainGoal(snapshot.campaign.mainGoal);
    if (snapshot.campaign.monthlyGoals.length > 0) {
      setMonthlyGoals(snapshot.campaign.monthlyGoals);
    }
    if (snapshot.todos.length > 0) {
      const teamNameMap = new Map(snapshot.teams.map((t) => [t.id, t.name]));
      setTasksText(
        snapshot.todos
          .filter((td) => !td.done)
          .slice(0, 12)
          .map((td) => `${teamNameMap.get(td.teamId) ?? "籌備組"}：${td.title}`)
          .join("\n"),
      );
    }
    setAiServerPreview(null);
    setAiOpen(true);
  }

  function openTimelineDialog() {
    setTlStartDate(snapshot.campaign.startDate);
    setTlEventDate(snapshot.campaign.eventDate);
    setTlPostWeeks(snapshot.campaign.postWeeks);
    setTlTentative(snapshot.campaign.dateTentative);
    setTlTentativeNote(snapshot.campaign.tentativeNote);
    setTimelineOpen(true);
  }

  async function handleApplyTimeline() {
    setTlBusy(true);
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/campaigns/${snapshot.campaign.id}/timeline`,
        "POST",
        {
          startDate: tlStartDate,
          eventDate: tlEventDate,
          postWeeks: tlPostWeeks,
          dateTentative: tlTentative,
          tentativeNote: tlTentative ? tlTentativeNote.trim() || "日期待定" : "",
        },
      );
      onSnapshot(next);
      setMonthFilter("all");
      setTimelineOpen(false);
      notify(`已更新籌備時程區間（會前倒數 ${timelinePreview.prepCount} 週，共 ${timelinePreview.weeks.length} 週）`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "更新時程區間失敗");
    } finally {
      setTlBusy(false);
    }
  }

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

  function openWeekEditor(week: CampaignWeek, spanCount = 1) {
    setEditingWeek({
      week,
      stage: week.stage ?? "待排",
      spanCount,
      monthLabel: week.monthLabel,
      dateRange: week.dateRange,
      countdownLabel: week.countdownLabel,
      phase: week.phase,
      memo: week.memo,
      events: [...week.majorEvents],
      newEventTitle: "",
      newEventKind: "conflict",
    });
  }

  async function saveCellEdit() {
    if (!editingCell) return;
    try {
      const existing = cellMap.get(`${editingCell.week.id}:${editingCell.team.id}`);
      let next = await apiWrite<CampaignSnapshot>(
        `/api/cells?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
        "PUT",
        {
          weekId: editingCell.week.id,
          teamId: editingCell.team.id,
          stage: existing?.stage ?? editingCell.week.stage ?? "待排",
          weeklyFocus: editingCell.weeklyFocus,
          crossTeam: editingCell.crossTeam,
        },
      );
      if (editingCell.newTodo.trim()) {
        next = await apiWrite<CampaignSnapshot>(`/api/campaigns/${snapshot.campaign.id}/todos`, "POST", {
          teamId: editingCell.team.id,
          weekId: editingCell.week.id,
          title: editingCell.newTodo.trim(),
        });
      }
      onSnapshot(next);
      setEditingCell(null);
      notify("已更新組別本週重點與待辦");
    } catch (err) {
      notify(err instanceof Error ? err.message : "儲存失敗");
    }
  }

  async function saveWeekEdit() {
    if (!editingWeek) return;
    try {
      let next = await apiWrite<CampaignSnapshot>(
        `/api/weeks/${editingWeek.week.id}?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
        "PATCH",
        {
          monthLabel: editingWeek.monthLabel,
          dateRange: editingWeek.dateRange,
          countdownLabel: editingWeek.countdownLabel,
          phase: editingWeek.phase,
          stage: editingWeek.stage,
          memo: editingWeek.memo,
          majorEvents: editingWeek.events,
        },
      );

      if (editingWeek.spanCount > 1) {
        const startIdx = orderedWeeks.findIndex((w) => w.id === editingWeek.week.id);
        const extraWeeks = startIdx >= 0 ? orderedWeeks.slice(startIdx + 1, startIdx + editingWeek.spanCount) : [];
        for (const extra of extraWeeks) {
          next = await apiWrite<CampaignSnapshot>(
            `/api/weeks/${extra.id}?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
            "PATCH",
            { stage: editingWeek.stage },
          );
        }
      }

      onSnapshot(next);
      setEditingWeek(null);
      notify(
        editingWeek.spanCount > 1
          ? `已將整體專案進度「${editingWeek.stage}」拉成連續 ${editingWeek.spanCount} 週橫條`
          : "已更新整體專案進度與週次設定",
      );
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
            weekStages: livePreview.weekStages,
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

        <div
          className="kpi-card"
          style={{ cursor: "pointer" }}
          onClick={openTimelineDialog}
          title="點擊調整籌備起算日、擴展長程倒數週數（1–52 週）或設定日期待定"
        >
          <div className="kpi-head">
            <span>活動日期與週期</span>
            {snapshot.campaign.dateTentative ? (
              <span className="pill pill-warn" style={{ height: 20, fontSize: 11, padding: "0 7px" }}>
                日期待定
              </span>
            ) : (
              <span className="tabular" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {snapshot.campaign.eventDate}
              </span>
            )}
          </div>
          <div className="kpi-value tabular">
            {orderedWeeks.length} 週{" "}
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-3)" }}>
              {snapshot.campaign.dateTentative
                ? `· 倒數 ${orderedWeeks.filter((w) => w.phase === "prep").length} 週起算`
                : daysUntilEvent !== null
                  ? daysUntilEvent >= 0
                    ? `· 倒數 ${daysUntilEvent} 天`
                    : `· 已舉辦（會後復盤）`
                  : ""}
            </span>
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: snapshot.campaign.dateTentative ? "var(--campaign-text)" : "var(--text-3)",
              fontWeight: snapshot.campaign.dateTentative ? 500 : 400,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {snapshot.campaign.dateTentative
              ? `${formatCampaignDateLabel(snapshot.campaign)} · 點擊調整週數 →`
              : `倒數 ${orderedWeeks.filter((w) => w.phase === "prep").length} 週至會後 ${orderedWeeks.filter((w) => w.phase === "post").length} 週 · 點擊調整 →`}
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
          onClick={openAiDialog}
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
            {snapshot.campaign.dateTentative && (
              <span className="pill pill-warn" title="正式日期確認後可隨時點擊「時程區間 · 週數」一鍵對齊">
                {formatCampaignDateLabel(snapshot.campaign)}
              </span>
            )}
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
            <button type="button" className="btn btn-sm" onClick={openTimelineDialog}>
              <CalendarRange size={13} />
              <span>時程區間 · 週數</span>
            </button>
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
              onClick={openAiDialog}
            >
              <Sparkles size={13} />
              <span>AI 自動排程</span>
            </button>
          </div>
        </div>

        {monthEpochs.length > 1 && (
          <div className="month-filter-bar" role="tablist" aria-label="依月份篩選時程週次">
            <span className="month-filter-caption">月份視角</span>
            <button
              type="button"
              role="tab"
              aria-selected={!activeEpoch}
              className={`month-chip ${!activeEpoch ? "is-active" : ""}`}
              onClick={() => setMonthFilter("all")}
            >
              <span>全部週次</span>
              <span className="month-chip-count tabular">{orderedWeeks.length}</span>
            </button>
            {monthEpochs.map((ep) => {
              const isAct = activeEpoch?.id === ep.id;
              return (
                <button
                  key={ep.id}
                  type="button"
                  role="tab"
                  aria-selected={isAct}
                  className={`month-chip ${isAct ? "is-active" : ""}`}
                  onClick={() => setMonthFilter(ep.id)}
                >
                  <span>{ep.label}</span>
                  <span className="month-chip-count tabular">{ep.weeks.length}</span>
                </button>
              );
            })}
          </div>
        )}

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

              {/* Row 2: Slim Architectural Project Progress Track across the Top */}
              <tr className="project-progress-row">
                <th
                  className="sticky-col project-progress-sticky"
                  title={`已完成 ${metrics.completedTodos}/${metrics.totalTodos} 項待辦 · 點擊右側任一階段可調整`}
                >
                  <div className="project-progress-sticky-inner">
                    <span className="project-progress-label">整體進度</span>
                    <span className="project-progress-pct tabular">{metrics.overallPercent}%</span>
                  </div>
                  <div className="project-progress-edge-bar" aria-hidden="true">
                    <span style={{ width: `${metrics.overallPercent}%` }} />
                  </div>
                </th>

                {projectStageRuns.map((run, rIdx) => {
                  const firstWeek = run.weeks[0];
                  const lastWeek = run.weeks[run.weeks.length - 1];
                  const startDay = firstWeek.dateRange.split(/[–~-]/)[0]?.trim() ?? firstWeek.dateRange;
                  const endDay = lastWeek.dateRange.split(/[–~-]/).pop()?.trim() ?? lastWeek.dateRange;
                  const stagePct = stageToPercent(run.stage);
                  const showMeter = run.weeks.length === 1 && run.stage.startsWith("進度");
                  const isFirst = rIdx === 0;
                  const isLast = rIdx === projectStageRuns.length - 1;
                  return (
                    <th
                      key={`proj-stage-${firstWeek.id}`}
                      colSpan={run.weeks.length}
                      className={`project-stage-th ${isFirst ? "is-first" : ""} ${isLast ? "is-last" : ""}`}
                    >
                      <button
                        type="button"
                        className={stageSpanClass(run.stage)}
                        title="點擊調整此週期的整體專案完成進度階段與延續週數"
                        onClick={() => openWeekEditor(firstWeek, run.weeks.length)}
                      >
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <span className="stage-node-dot" />
                          <span>{run.stage}</span>
                        </span>
                        {run.weeks.length > 1 ? (
                          <span className="stage-span-meta">
                            連續 {run.weeks.length} 週 · {startDay}–{endDay}
                          </span>
                        ) : showMeter ? (
                          <span className="stage-inline-meter" aria-hidden="true">
                            <span style={{ width: `${stagePct}%` }} />
                          </span>
                        ) : null}
                      </button>
                    </th>
                  );
                })}
              </tr>

              {/* Row 3: Week Countdown, Dates, and Major Events / Clashing Activities */}
              <tr>
                <th className="sticky-col" style={{ padding: "10px 12px", background: "var(--panel)" }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)" }}>倒數週數 ／ 撞期雷達</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 3, fontWeight: 400 }}>
                    點擊週次記錄撞期活動或重要死線
                  </div>
                </th>
                {visibleWeeks.map((week) => {
                  const wp = metrics.weekProgress[week.id] ?? { percent: 0, done: 0, total: 0, hasConflict: false };
                  return (
                    <th
                      key={week.id}
                      className={`week-head-cell ${week.phase === "event" ? "is-event-week" : ""} ${wp.hasConflict ? "has-conflict" : ""}`}
                      onClick={() => openWeekEditor(week, 1)}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
                        <span className="week-countdown">{week.countdownLabel}</span>
                        <span className="week-dates tabular">{week.dateRange}</span>
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

                return (
                  <tr key={team.id}>
                    <td className="sticky-col team-row-header">
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <span className={`team-dot team-dot-${team.color}`} />
                        <strong style={{ fontSize: 13.5 }}>{team.name}</strong>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 4 }}>
                        {team.lead ? `負責：${team.lead}` : "尚未指派組長"}
                      </div>
                      <div className="progress-track" style={{ height: 4, marginTop: 8 }}>
                        <div className="progress-fill" style={{ width: `${tp.percent}%` }} />
                      </div>
                      <div className="tabular" style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 4 }}>
                        組內待辦 {tp.done}/{tp.total} 完成
                      </div>
                    </td>

                    {visibleWeeks.map((week, wIdx) => {
                      const cell = cellMap.get(`${week.id}:${team.id}`);
                      const prevWeek = wIdx > 0 ? visibleWeeks[wIdx - 1] : null;
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
                              weeklyFocus: cell?.weeklyFocus ?? "",
                              crossTeam: cell?.crossTeam ?? "",
                              newTodo: "",
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
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Dialog 1: Edit Team Cell (Weekly Focus, Cross-Team, Quick Todo) ── */}
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
                    整體專案進度與週次設定 · {editingWeek.week.countdownLabel}
                  </Dialog.Title>
                  <Dialog.Close asChild>
                    <button type="button" className="icon-btn" aria-label="關閉">
                      <X size={15} />
                    </button>
                  </Dialog.Close>
                </div>

                <div>
                  <label className="field-label">本週整體專案完成進度／階段（全團隊共用頂部進度線，不重複顯示於各組）</label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {CELL_STAGES.map((st) => (
                      <button
                        key={st}
                        type="button"
                        className={`btn btn-sm ${editingWeek.stage === st ? "btn-primary" : ""}`}
                        onClick={() => setEditingWeek({ ...editingWeek, stage: st })}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="field-label">階段延續週數（連續相同進度會自動合併成一條橫條）</label>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {[1, 2, 3, 4, 6, 8].map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`btn btn-sm ${editingWeek.spanCount === n ? "btn-primary" : ""}`}
                        onClick={() => setEditingWeek({ ...editingWeek, spanCount: n })}
                      >
                        {n === 1 ? "僅本週" : `連續 ${n} 週`}
                      </button>
                    ))}
                  </div>
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
                          {item.label
                            .replace("倒數 ", "W-")
                            .replace(" 周", "")
                            .replace(/暫定?活動當周/, "D-Day")
                            .replace("活動後 ", "W+")}
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
                            <span style={{ fontSize: 12, color: "var(--text-3)" }}>
                              {snapshot.campaign.dateTentative ? "預計舉辦時間" : "正式活動日"}
                            </span>
                            <strong className="tabular" style={{ fontSize: snapshot.campaign.dateTentative ? 15 : 18 }}>
                              {formatCampaignDateLabel(snapshot.campaign)}
                            </strong>
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
      {/* ── Dialog 7: Long-Term Timeline & Tentative Date Configurator ── */}
      <Dialog.Root open={timelineOpen} onOpenChange={setTimelineOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content" style={{ maxWidth: 520 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <Dialog.Title style={{ margin: 0, fontSize: 16.5, fontWeight: 700 }}>
                    調整籌備時程區間與倒數週數
                  </Dialog.Title>
                  <Dialog.Description style={{ margin: "2px 0 0", fontSize: 12.5, color: "var(--text-3)" }}>
                    支援 1–52 週跨月長程規劃與「日期待定」模式；變更時將自動保留現有待辦與紀錄
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <button type="button" className="icon-btn" aria-label="關閉">
                    <X size={15} />
                  </button>
                </Dialog.Close>
              </div>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span className="field-label" style={{ marginBottom: 0 }}>舉辦日期狀態</span>
                <div className="segmented-inline" role="radiogroup" aria-label="舉辦日期狀態">
                  <button
                    type="button"
                    className={`seg-btn ${!tlTentative ? "is-active" : ""}`}
                    onClick={() => setTlTentative(false)}
                  >
                    已確定正式日期
                  </button>
                  <button
                    type="button"
                    className={`seg-btn ${tlTentative ? "is-active" : ""}`}
                    onClick={() => {
                      setTlTentative(true);
                      if (!tlTentativeNote.trim()) {
                        const ym = tlEventDate.slice(0, 7).split("-");
                        const m = Number(ym[1] || 2);
                        setTlTentativeNote(`預計 ${ym[0]} 年 ${m}–${(m % 12) + 1} 月（日期待定）`);
                      }
                    }}
                  >
                    日期待定（先排月份）
                  </button>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                    <label className="field-label" style={{ marginBottom: 0 }}>籌備起算日</label>
                    <button
                      type="button"
                      className="btn-ghost"
                      style={{ border: "none", padding: "0 4px", fontSize: 11.5, color: "var(--campaign-text)", cursor: "pointer" }}
                      onClick={() => setTlStartDate(new Date().toISOString().slice(0, 10))}
                    >
                      設為今天
                    </button>
                  </div>
                  <input
                    type="date"
                    className="input"
                    value={tlStartDate}
                    onChange={(e) => setTlStartDate(e.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label">
                    {tlTentative ? "暫定基準週期（展開週次用）" : "正式活動日期"}
                  </label>
                  <input
                    type="date"
                    className="input"
                    value={tlEventDate}
                    onChange={(e) => setTlEventDate(e.target.value)}
                  />
                </div>
              </div>

              {tlTentative && (
                <div>
                  <label className="field-label">預計舉辦月份／區間標註（顯示於時程總表與週報）</label>
                  <input
                    className="input"
                    value={tlTentativeNote}
                    onChange={(e) => setTlTentativeNote(e.target.value)}
                    placeholder="例如：預計 2027 年 2–3 月舉辦（日期待定）"
                  />
                </div>
              )}

              <div>
                <label className="field-label">活動後延伸復盤週數</label>
                <select
                  className="select"
                  value={tlPostWeeks}
                  onChange={(e) => setTlPostWeeks(Number(e.target.value))}
                >
                  <option value={0}>不延伸會後週</option>
                  <option value={1}>活動後 1 週</option>
                  <option value={2}>活動後 2 週（推薦）</option>
                  <option value={3}>活動後 3 週</option>
                  <option value={4}>活動後 4 週</option>
                </select>
              </div>

              <div className="timeline-preview-hint">
                <div>
                  將展開 <strong>倒數 {timelinePreview.prepCount} 週</strong> 會前籌備 ＋ 活動當週
                  {timelinePreview.postWeeks > 0 ? ` ＋ 會後 ${timelinePreview.postWeeks} 週` : ""}
                  （共 <strong>{timelinePreview.weeks.length} 週</strong> ·{" "}
                  <span className="tabular">
                    {timelinePreview.weeks[0]?.dateRange.split("~")[0]} ~{" "}
                    {timelinePreview.weeks.at(-1)?.dateRange.split("~")[1]}
                  </span>
                  ）
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 3 }}>
                  現有待辦事項、組別進度重點與撞期警示皆會依週次日期自動保留對齊。
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                <button type="button" className="btn" onClick={() => setTimelineOpen(false)}>
                  取消
                </button>
                <button type="button" className="btn btn-primary" disabled={tlBusy} onClick={handleApplyTimeline}>
                  <Check size={14} />
                  <span>{tlBusy ? "更新時程中…" : "套用時程區間"}</span>
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
