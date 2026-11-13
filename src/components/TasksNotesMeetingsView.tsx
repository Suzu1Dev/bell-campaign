import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeftRight,
  ArrowUpRight,
  Calendar,
  CheckCircle2,
  Circle,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Pin,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { CampaignMeeting, CampaignNote, CampaignSnapshot } from "../../shared/types";
import { explainDraftHref, personalTaskHref, prDraftHref, type SuiteLinks } from "../../shared/suite";
import { computeCampaignMetrics } from "../../shared/sheets";
import { detectDocSourceFromUrl, meetingToGoogleDocHtml, meetingToHackMd } from "../../shared/docs";
import { apiWrite } from "../lib/api";

// ── 1. Tasks & Team Progress Tracking (`#/tasks`) ──────────────────────────
export function TasksView({
  snapshot,
  suiteLinks,
  onSnapshot,
  notify,
}: {
  snapshot: CampaignSnapshot;
  suiteLinks: SuiteLinks;
  onSnapshot: (next: CampaignSnapshot) => void;
  notify: (msg: string) => void;
}) {
  const metrics = useMemo(() => computeCampaignMetrics(snapshot), [snapshot]);
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"open" | "all" | "done">("all");
  const [newTitle, setNewTitle] = useState("");
  const [newTeamId, setNewTeamId] = useState(snapshot.teams[0]?.id ?? "");
  const [newWeekId, setNewWeekId] = useState<string>(snapshot.weeks[0]?.id ?? "");
  const [newPriority, setNewPriority] = useState<"normal" | "high">("normal");

  const filteredTodos = useMemo(() => {
    return snapshot.todos.filter((t) => {
      if (teamFilter !== "all" && t.teamId !== teamFilter) return false;
      if (statusFilter === "open" && t.done) return false;
      if (statusFilter === "done" && !t.done) return false;
      return true;
    });
  }, [snapshot.todos, teamFilter, statusFilter]);

  async function addTodo(e: React.FormEvent) {
    e.preventDefault();
    const targetTeam = newTeamId || snapshot.teams[0]?.id;
    if (!newTitle.trim() || !targetTeam) return;
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/campaigns/${snapshot.campaign.id}/todos`,
        "POST",
        {
          teamId: targetTeam,
          weekId: newWeekId || null,
          title: newTitle.trim(),
          priority: newPriority,
        },
      );
      onSnapshot(next);
      setNewTitle("");
      notify("已新增待辦事項");
    } catch (err) {
      notify(err instanceof Error ? err.message : "新增失敗");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Per-Team Progress Cards */}
      <section className="radar-grid" aria-label="各大組別專案進度">
        {snapshot.teams.map((team) => {
          const tp = metrics.teamProgress[team.id] ?? { percent: 0, done: 0, total: 0, latestStage: "待排" };
          const active = teamFilter === team.id;
          return (
            <div
              key={team.id}
              className="kpi-card"
              style={{
                cursor: "pointer",
                borderColor: active ? "var(--campaign)" : undefined,
              }}
              onClick={() => setTeamFilter(active ? "all" : team.id)}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span className={`team-dot team-dot-${team.color}`} />
                  <strong style={{ fontSize: 14 }}>{team.name}</strong>
                </div>
                <span className="pill">{team.lead ? `組長：${team.lead}` : "籌備組"}</span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 4 }}>
                <span className="kpi-value tabular">{tp.percent}%</span>
                <span className="tabular" style={{ fontSize: 12.5, color: "var(--text-3)" }}>
                  已完成 {tp.done} / {tp.total}
                </span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${tp.percent}%` }} />
              </div>
            </div>
          );
        })}
      </section>

      {/* Quick Add Todo + Filters */}
      <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        <form onSubmit={addTodo} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ flex: "1 1 240px" }}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="新增組別待辦事項…"
          />
          <select
            className="select"
            style={{ width: 148 }}
            value={newTeamId || snapshot.teams[0]?.id || ""}
            onChange={(e) => setNewTeamId(e.target.value)}
          >
            {snapshot.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select
            className="select"
            style={{ width: 152 }}
            value={newWeekId}
            onChange={(e) => setNewWeekId(e.target.value)}
          >
            <option value="">不指定週次</option>
            {snapshot.weeks.map((w) => (
              <option key={w.id} value={w.id}>
                {w.countdownLabel} ({w.dateRange})
              </option>
            ))}
          </select>
          <select
            className="select"
            style={{ width: 108 }}
            value={newPriority}
            onChange={(e) => setNewPriority(e.target.value as "normal" | "high")}
          >
            <option value="normal">一般</option>
            <option value="high">高優先</option>
          </select>
          <button type="submit" className="btn btn-primary">
            <Plus size={14} />
            <span>新增待辦</span>
          </button>
        </form>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              className={`btn btn-sm ${teamFilter === "all" ? "btn-primary" : ""}`}
              onClick={() => setTeamFilter("all")}
            >
              全部組別 ({snapshot.todos.length})
            </button>
            {snapshot.teams.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`btn btn-sm ${teamFilter === t.id ? "btn-primary" : ""}`}
                onClick={() => setTeamFilter(t.id)}
              >
                {t.name}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 6 }}>
            {(
              [
                ["all", "全部"],
                ["open", "待完成"],
                ["done", "已完成"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`btn btn-sm ${statusFilter === k ? "btn-primary" : ""}`}
                onClick={() => setStatusFilter(k)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          {filteredTodos.length === 0 ? (
            <div style={{ padding: "24px 0", textAlign: "center", color: "var(--text-3)", fontSize: 13.5 }}>
              目前篩選條件下沒有待辦事項
            </div>
          ) : (
            filteredTodos.map((td) => {
              const team = snapshot.teams.find((t) => t.id === td.teamId);
              const week = snapshot.weeks.find((w) => w.id === td.weekId);
              const personalHref = personalTaskHref(
                suiteLinks.personal,
                `[${snapshot.campaign.name} · ${team?.name ?? "籌備"}] ${td.title}`,
                "#/tasks",
                window.location.hostname,
              );
              const prHref = prDraftHref(
                suiteLinks.pr,
                {
                  title: td.title,
                  draft: `[${snapshot.campaign.name} · ${team?.name ?? "籌備"}] ${td.title}`,
                  back: "#/tasks",
                },
                window.location.hostname,
              );
              return (
                <div
                  key={td.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 8px",
                    borderTop: "1px solid var(--line)",
                  }}
                >
                  <button
                    type="button"
                    aria-label={`切換完成：${td.title}`}
                    onClick={async () => {
                      const next = await apiWrite<CampaignSnapshot>(
                        `/api/todos/${td.id}?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
                        "PATCH",
                        { done: !td.done },
                      );
                      onSnapshot(next);
                    }}
                    style={{
                      border: "none",
                      background: "transparent",
                      padding: 0,
                      cursor: "pointer",
                      color: td.done ? "var(--ok)" : "var(--text-3)",
                      flexShrink: 0,
                    }}
                  >
                    {td.done ? <CheckCircle2 size={17} /> : <Circle size={17} />}
                  </button>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: td.done ? "var(--text-3)" : "var(--text)",
                        textDecoration: td.done ? "line-through" : "none",
                      }}
                    >
                      {td.title}
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 3, flexWrap: "wrap", fontSize: 12, color: "var(--text-3)" }}>
                      {team && (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <span className={`team-dot team-dot-${team.color}`} />
                          {team.name}
                        </span>
                      )}
                      {week && <span>· {week.countdownLabel}（{week.dateRange}）</span>}
                      {td.assignee && <span>· {td.assignee}</span>}
                      {td.dueDate && <span className="tabular">· 期限 {td.dueDate}</span>}
                    </div>
                  </div>

                  {td.priority === "high" && !td.done && <span className="pill pill-warn">高優先</span>}

                  {personalHref && (
                    <a href={personalHref} className="suite-chip suite-chip-personal" title="送到 BELL Personal 待辦草稿">
                      <span>送到 Personal</span>
                      <ArrowUpRight size={12} />
                    </a>
                  )}

                  {prHref && (
                    <a href={prHref} className="suite-chip suite-chip-pr" title="送到 BELL PR 貢獻草稿">
                      <span>送到 BELL PR</span>
                      <ArrowUpRight size={12} />
                    </a>
                  )}

                  <button
                    type="button"
                    className="btn-ghost"
                    style={{ border: "none", padding: 4, cursor: "pointer" }}
                    aria-label="刪除待辦"
                    onClick={async () => {
                      const next = await apiWrite<CampaignSnapshot>(
                        `/api/todos/${td.id}?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
                        "DELETE",
                      );
                      onSnapshot(next);
                      notify("已刪除待辦");
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

// ── 2. Meetings Workspace (`#/meetings`) + Bidirectional Google Docs & HackMD ─
export function MeetingsView({
  snapshot,
  onSnapshot,
  notify,
}: {
  snapshot: CampaignSnapshot;
  onSnapshot: (next: CampaignSnapshot) => void;
  notify: (msg: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string>(snapshot.meetings[0]?.id ?? "new");
  const current = snapshot.meetings.find((m) => m.id === selectedId);

  const [draft, setDraft] = useState<Omit<CampaignMeeting, "id" | "campaignId" | "updatedAt">>(() =>
    current
      ? {
          title: current.title,
          meetingDate: current.meetingDate,
          attendees: current.attendees,
          agenda: current.agenda,
          arrangements: current.arrangements,
          precautions: current.precautions,
          decisions: current.decisions,
          docUrl: current.docUrl ?? "",
          docSource: current.docSource ?? "",
        }
      : {
          title: "",
          meetingDate: new Date().toISOString().slice(0, 10) + " 20:30",
          attendees: "",
          agenda: "",
          arrangements: "",
          precautions: "",
          decisions: "",
          docUrl: "",
          docSource: "",
        },
  );

  // Bidirectional Cloud Sync Dialog state
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncTab, setSyncTab] = useState<"import" | "export">("import");
  const [importTarget, setImportTarget] = useState<"new" | "overwrite">("new");
  const [importUrl, setImportUrl] = useState("");
  const [importText, setImportText] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);

  function selectMeeting(m: CampaignMeeting | null) {
    if (!m) {
      setSelectedId("new");
      setDraft({
        title: "",
        meetingDate: new Date().toISOString().slice(0, 10) + " 20:30",
        attendees: snapshot.teams.map((t) => t.name).join("、"),
        agenda: "1. 各組當週進度檢核\n2. 跨部合作項目對齊",
        arrangements: "",
        precautions: "",
        decisions: "",
        docUrl: "",
        docSource: "",
      });
      return;
    }
    setSelectedId(m.id);
    setDraft({
      title: m.title,
      meetingDate: m.meetingDate,
      attendees: m.attendees,
      agenda: m.agenda,
      arrangements: m.arrangements,
      precautions: m.precautions,
      decisions: m.decisions,
      docUrl: m.docUrl ?? "",
      docSource: m.docSource ?? "",
    });
  }

  async function saveMeeting() {
    if (!draft.title.trim()) {
      notify("請輸入會議標題");
      return;
    }
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/campaigns/${snapshot.campaign.id}/meetings`,
        "POST",
        {
          ...(selectedId !== "new" ? { id: selectedId } : {}),
          ...draft,
          docSource: draft.docUrl ? detectDocSourceFromUrl(draft.docUrl) : draft.docSource,
        },
      );
      onSnapshot(next);
      if (selectedId === "new" && next.meetings[0]) {
        setSelectedId(next.meetings[0].id);
      }
      notify("已儲存會議記錄");
    } catch (err) {
      notify(err instanceof Error ? err.message : "儲存失敗");
    }
  }

  async function runDocImport(opts: { docUrl?: string; rawContent?: string; targetMeetingId?: string }) {
    setSyncBusy(true);
    try {
      const res = await apiWrite<{ meeting: CampaignMeeting; snapshot: CampaignSnapshot }>(
        `/api/campaigns/${snapshot.campaign.id}/meetings/import-doc`,
        "POST",
        {
          ...(opts.targetMeetingId ? { meetingId: opts.targetMeetingId } : {}),
          ...(opts.docUrl ? { docUrl: opts.docUrl } : {}),
          ...(opts.rawContent ? { rawContent: opts.rawContent } : {}),
        },
      );
      onSnapshot(res.snapshot);
      selectMeeting(res.meeting);
      setImportUrl("");
      setImportText("");
      setSyncOpen(false);
      notify(`已同步「${res.meeting.title}」內容至會議記錄`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "匯入雲端文件失敗");
    } finally {
      setSyncBusy(false);
    }
  }

  async function copyRichGoogleDoc() {
    const safeDraft = {
      ...draft,
      title: draft.title.trim() || "未命名會議記錄",
    };
    const html = meetingToGoogleDocHtml(safeDraft, snapshot.campaign.name);
    const md = meetingToHackMd(safeDraft, snapshot.campaign.name);
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([md], { type: "text/plain" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(md);
      }
      notify("已複製 Google 文件富文本格式，可直接 ⌘V 貼入 Google 文件保留標題與清單");
    } catch {
      await navigator.clipboard.writeText(md);
      notify("已複製結構化會議內容");
    }
  }

  async function copyHackMd() {
    const safeDraft = {
      ...draft,
      title: draft.title.trim() || "未命名會議記錄",
    };
    await navigator.clipboard.writeText(meetingToHackMd(safeDraft, snapshot.campaign.name));
    notify("已複製 HackMD Markdown（含 YAML 標籤與完整章節）");
  }

  function downloadDraftFile(format: "md" | "doc") {
    if (selectedId !== "new") {
      window.location.href = `/api/meetings/${encodeURIComponent(selectedId)}/export?format=${format}`;
      return;
    }
    const safeDraft = { ...draft, title: draft.title.trim() || "meeting-notes" };
    const content =
      format === "doc"
        ? meetingToGoogleDocHtml(safeDraft, snapshot.campaign.name)
        : meetingToHackMd(safeDraft, snapshot.campaign.name);
    const mime = format === "doc" ? "application/msword;charset=utf-8" : "text/markdown;charset=utf-8";
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeDraft.title}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function convertDecisionToTodo() {
    const text = draft.decisions.trim().split(/\n+/)[0]?.replace(/^[-*•[\]\sx]+/i, "").trim();
    const teamId = snapshot.teams[0]?.id;
    if (!text || !teamId) {
      notify("請先在決議欄輸入內容");
      return;
    }
    const next = await apiWrite<CampaignSnapshot>(`/api/campaigns/${snapshot.campaign.id}/todos`, "POST", {
      teamId,
      title: text.slice(0, 120),
      priority: "high",
    });
    onSnapshot(next);
    notify("已將會議決議轉為高優先待辦");
  }

  const docSourceLabel =
    draft.docSource === "gdoc" || draft.docUrl.includes("docs.google.com")
      ? "Google 文件"
      : draft.docSource === "hackmd" || draft.docUrl.includes("hackmd.io")
        ? "HackMD"
        : "雲端文件";

  return (
    <div className="meetings-grid">
      <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
          <strong style={{ fontSize: 14 }}>會議列表 ({snapshot.meetings.length})</strong>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setSyncTab("import");
                setImportTarget("new");
                setSyncOpen(true);
              }}
              title="從 Google 文件或 HackMD 匯入新會議"
            >
              <Upload size={12} />
              <span>匯入</span>
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => selectMeeting(null)}>
              <Plus size={13} />
              <span>新增</span>
            </button>
          </div>
        </div>

        {snapshot.meetings.map((m) => {
          const srcTag =
            m.docSource === "gdoc"
              ? "Google 文件"
              : m.docSource === "hackmd"
                ? "HackMD"
                : "";
          return (
            <div
              key={m.id}
              onClick={() => selectMeeting(m)}
              style={{
                padding: "10px 12px",
                borderRadius: "var(--radius-sm)",
                border: `1px solid ${selectedId === m.id ? "var(--campaign)" : "var(--line)"}`,
                background: selectedId === m.id ? "var(--campaign-tint)" : "var(--panel)",
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 6 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{m.title}</div>
                {srcTag && (
                  <span className="pill" style={{ height: 19, fontSize: 11, padding: "0 6px" }}>
                    {srcTag}
                  </span>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-3)", marginTop: 4 }}>
                <Calendar size={12} />
                <span className="tabular">{m.meetingDate}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Bidirectional Google Docs & HackMD Studio Strip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexWrap: "wrap",
            padding: "10px 12px",
            borderRadius: "var(--radius-sm)",
            background: "var(--panel)",
            border: "1px solid var(--line)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {draft.docUrl ? (
              <>
                <a
                  href={draft.docUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="pill pill-ok"
                  title="開啟綁定的雲端會議文件"
                >
                  <FileText size={12} />
                  <span>已連結 {docSourceLabel}</span>
                  <ExternalLink size={11} />
                </a>
                {selectedId !== "new" && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={syncBusy}
                    onClick={() => void runDocImport({ docUrl: draft.docUrl, targetMeetingId: selectedId })}
                  >
                    <RefreshCw size={12} />
                    <span>{syncBusy ? "同步中…" : "從雲端拉取更新"}</span>
                  </button>
                )}
              </>
            ) : (
              <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>
                支援 <strong>Google 文件</strong> 與 <strong>HackMD</strong> 雙向匯入／匯出（自動對應大綱、議程、注意事項與決議）
              </span>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-sm" onClick={() => void copyRichGoogleDoc()}>
              <Copy size={12} />
              <span>直貼 Google 文件</span>
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void copyHackMd()}>
              <Copy size={12} />
              <span>複製 HackMD</span>
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setSyncTab("import");
                setImportTarget(selectedId !== "new" ? "overwrite" : "new");
                setSyncOpen(true);
              }}
            >
              <ArrowLeftRight size={12} />
              <span>雙向匯入／匯出</span>
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 10 }}>
          <div>
            <label className="field-label">會議名稱</label>
            <input
              className="input"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="例如：倒數 2 週 · 全場流彩排前對齊會"
            />
          </div>
          <div>
            <label className="field-label">開會時間</label>
            <input
              className="input"
              value={draft.meetingDate}
              onChange={(e) => setDraft({ ...draft, meetingDate: e.target.value })}
            />
          </div>
        </div>

        <div>
          <label className="field-label">與會組別／人員</label>
          <input
            className="input"
            value={draft.attendees}
            onChange={(e) => setDraft({ ...draft, attendees: e.target.value })}
          />
        </div>

        <div>
          <label className="field-label">會前大綱</label>
          <textarea
            className="textarea"
            rows={3}
            value={draft.agenda}
            onChange={(e) => setDraft({ ...draft, agenda: e.target.value })}
            placeholder="列出本次會議必決議的核心議題…"
          />
        </div>

        <div>
          <label className="field-label">議程與時間安排</label>
          <textarea
            className="textarea"
            rows={3}
            value={draft.arrangements}
            onChange={(e) => setDraft({ ...draft, arrangements: e.target.value })}
            placeholder="各段落報告時長與主持順序…"
          />
        </div>

        <div>
          <label className="field-label">會前注意事項與提醒</label>
          <textarea
            className="textarea"
            rows={3}
            value={draft.precautions}
            onChange={(e) => setDraft({ ...draft, precautions: e.target.value })}
            placeholder="會前需先準備好的檔案、撞期風險提醒…"
          />
        </div>

        <div>
          <label className="field-label">會議決議與後續行動</label>
          <textarea
            className="textarea"
            rows={2}
            value={draft.decisions}
            onChange={(e) => setDraft({ ...draft, decisions: e.target.value })}
          />
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-sm" onClick={convertDecisionToTodo}>
              <span>將首條決議轉為待辦</span>
            </button>
            {selectedId !== "new" && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  const next = await apiWrite<CampaignSnapshot>(
                    `/api/meetings/${selectedId}?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
                    "DELETE",
                  );
                  onSnapshot(next);
                  selectMeeting(next.meetings[0] ?? null);
                  notify("已刪除會議記錄");
                }}
              >
                <Trash2 size={13} />
                <span>刪除</span>
              </button>
            )}
          </div>
          <button type="button" className="btn btn-primary" onClick={saveMeeting}>
            儲存會議記錄
          </button>
        </div>
      </div>

      {/* ── Bidirectional Google Docs & HackMD Sync Modal ────────────────── */}
      <Dialog.Root open={syncOpen} onOpenChange={setSyncOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content is-wide">
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <Dialog.Title style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
                    會議記錄雙向匯入／匯出（Google 文件 · HackMD）
                  </Dialog.Title>
                  <Dialog.Description style={{ margin: "3px 0 0", fontSize: 13, color: "var(--text-3)" }}>
                    自動識別標題、開會時間、與會人員、會前大綱、議程安排、注意事項與會議決議，雙向無損互通。
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <button type="button" className="icon-btn" aria-label="關閉">
                    <X size={15} />
                  </button>
                </Dialog.Close>
              </div>

              <div className="partner-tabs">
                <button
                  type="button"
                  className={`partner-tab-btn ${syncTab === "import" ? "is-active" : ""}`}
                  onClick={() => setSyncTab("import")}
                >
                  <Upload size={13} />
                  <span>從 Google 文件 ／ HackMD 匯入</span>
                </button>
                <button
                  type="button"
                  className={`partner-tab-btn ${syncTab === "export" ? "is-active" : ""}`}
                  onClick={() => setSyncTab("export")}
                >
                  <Download size={13} />
                  <span>匯出至 Google 文件 ／ HackMD 與連結綁定</span>
                </button>
              </div>

              {syncTab === "import" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {selectedId !== "new" && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, color: "var(--text-2)", fontWeight: 500 }}>匯入寫入方式：</span>
                      <button
                        type="button"
                        className={`btn btn-sm ${importTarget === "new" ? "btn-primary" : ""}`}
                        onClick={() => setImportTarget("new")}
                      >
                        建立為新的一筆會議
                      </button>
                      <button
                        type="button"
                        className={`btn btn-sm ${importTarget === "overwrite" ? "btn-primary" : ""}`}
                        onClick={() => setImportTarget("overwrite")}
                      >
                        覆寫更新目前會議（{draft.title || "未命名"}）
                      </button>
                    </div>
                  )}

                  <div
                    style={{
                      padding: 14,
                      borderRadius: "var(--radius-md)",
                      background: "var(--panel)",
                      border: "1px solid var(--line)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <label className="field-label" style={{ marginBottom: 0 }}>
                      方式一：貼上公開 Google 文件或 HackMD 筆記網址直接讀取
                    </label>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <input
                        className="input"
                        style={{ flex: "1 1 280px" }}
                        placeholder="https://docs.google.com/document/d/... 或 https://hackmd.io/@team/note"
                        value={importUrl}
                        onChange={(e) => setImportUrl(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={syncBusy || !importUrl.trim()}
                        onClick={() =>
                          void runDocImport({
                            docUrl: importUrl.trim(),
                            targetMeetingId: importTarget === "overwrite" && selectedId !== "new" ? selectedId : undefined,
                          })
                        }
                      >
                        {syncBusy ? "讀取解析中…" : "從網址匯入"}
                      </button>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                      提示：匯入後會自動綁定此網址，日後點「從雲端拉取更新」即可一鍵同步最新共筆。
                    </div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <label className="field-label" style={{ marginBottom: 0 }}>
                        方式二：上傳 `.md` / `.html` / `.txt` 檔，或直接貼上文件內容（適用私密權限文件）
                      </label>
                      <div style={{ display: "flex", gap: 6 }}>
                        <label className="btn btn-sm" style={{ cursor: "pointer" }}>
                          <Upload size={12} />
                          <span>選擇本地檔案</span>
                          <input
                            type="file"
                            accept=".md,.markdown,.txt,.html,.htm"
                            style={{ display: "none" }}
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              const text = await file.text();
                              setImportText(text);
                              e.target.value = "";
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() =>
                            setImportText(`---
title: "倒數 2 週 · 全場流彩排與講者接待共筆"
tags: [BELL Campaign, 會議記錄]
---

# 倒數 2 週 · 全場流彩排與講者接待共筆
- **開會時間**：2026-07-22 20:30
- **與會組別／人員**：全體組長、音控廠商代表

## 會前大綱
1. 確認 4 位與談講者最終簡報比例與轉接頭規格
2. 演練報到尖峰雙通道分流與臨時工站點

## 議程與時間安排
- 20:30–20:45 各組紅黃綠燈快報
- 20:45–21:15 分鐘級 Cue 表走位核對

## 會前注意事項與提醒
- 請行銷組會前先將桌牌印刷出血檔上傳至文件歸檔區

## 會議決議與後續行動
- 7/25 前收齊所有講者 PDF 備份並完成休息室動線標示`)
                          }
                        >
                          填入 HackMD 範例
                        </button>
                      </div>
                    </div>

                    <textarea
                      rows={7}
                      className="textarea"
                      style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}
                      placeholder="貼上 HackMD Markdown 或從 Google 文件全選複製的文字…"
                      value={importText}
                      onChange={(e) => setImportText(e.target.value)}
                    />

                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                      <button type="button" className="btn" onClick={() => setSyncOpen(false)}>
                        取消
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={syncBusy || !importText.trim()}
                        onClick={() =>
                          void runDocImport({
                            docUrl: importUrl.trim() || undefined,
                            rawContent: importText,
                            targetMeetingId: importTarget === "overwrite" && selectedId !== "new" ? selectedId : undefined,
                          })
                        }
                      >
                        解析內容並匯入
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
                    <div className="card" style={{ padding: 16, background: "var(--panel)", display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <strong style={{ fontSize: 14.5 }}>匯出至 Google 文件</strong>
                        <span className="pill">保留 H1/H2 標題與清單</span>
                      </div>
                      <p style={{ margin: 0, fontSize: 13, color: "var(--text-2)" }}>
                        一鍵複製富文本格式後，在空白 Google 文件按 <code>⌘V</code> 即可原樣貼上結構化標題與條列；或下載 <code>.doc</code> 上傳雲端硬碟開啟。
                      </p>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "auto" }}>
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => void copyRichGoogleDoc()}>
                          <Copy size={12} />
                          <span>複製富文本直貼 Google 文件</span>
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => downloadDraftFile("doc")}>
                          <Download size={12} />
                          <span>下載 .doc 檔</span>
                        </button>
                      </div>
                    </div>

                    <div className="card" style={{ padding: 16, background: "var(--panel)", display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <strong style={{ fontSize: 14.5 }}>匯出至 HackMD</strong>
                        <span className="pill">含 YAML 標籤頭</span>
                      </div>
                      <p style={{ margin: 0, fontSize: 13, color: "var(--text-2)" }}>
                        自動生成帶 YAML `title` / `tags` 的標準 HackMD 共筆語法，貼回 HackMD 修改後還可再一鍵同步回來。
                      </p>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "auto" }}>
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => void copyHackMd()}>
                          <Copy size={12} />
                          <span>複製 HackMD Markdown</span>
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => downloadDraftFile("md")}>
                          <Download size={12} />
                          <span>下載 .md 檔</span>
                        </button>
                        <a href="https://hackmd.io/new" target="_blank" rel="noreferrer" className="btn btn-sm">
                          <span>開新 HackMD</span>
                          <ExternalLink size={11} />
                        </a>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="field-label">綁定此會議對應的 Google 文件 ／ HackMD 網址（方便團隊隨時開啟與雙向拉取更新）</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        className="input"
                        placeholder="https://docs.google.com/document/d/... 或 https://hackmd.io/..."
                        value={draft.docUrl}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            docUrl: e.target.value,
                            docSource: detectDocSourceFromUrl(e.target.value),
                          })
                        }
                      />
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={async () => {
                          await saveMeeting();
                          setSyncOpen(false);
                        }}
                      >
                        儲存連結與會議
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

// ── 3. Personal Notes (`#/notes`) ──────────────────────────────────────────
export function NotesView({
  snapshot,
  suiteLinks,
  onSnapshot,
  notify,
}: {
  snapshot: CampaignSnapshot;
  suiteLinks: SuiteLinks;
  onSnapshot: (next: CampaignSnapshot) => void;
  notify: (msg: string) => void;
}) {
  const [activeNote, setActiveNote] = useState<CampaignNote | null>(snapshot.notes[0] ?? null);
  const [title, setTitle] = useState(snapshot.notes[0]?.title ?? "");
  const [body, setBody] = useState(snapshot.notes[0]?.body ?? "");
  const [tagsStr, setTagsStr] = useState((snapshot.notes[0]?.tags ?? []).join("、"));
  const [pinned, setPinned] = useState(Boolean(snapshot.notes[0]?.pinned));

  function openNote(n: CampaignNote | null) {
    setActiveNote(n);
    setTitle(n?.title ?? "");
    setBody(n?.body ?? "");
    setTagsStr((n?.tags ?? []).join("、"));
    setPinned(Boolean(n?.pinned));
  }

  async function saveNote() {
    if (!title.trim()) {
      notify("請輸入筆記標題");
      return;
    }
    const tags = tagsStr
      .split(/[,、，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const next = await apiWrite<CampaignSnapshot>(`/api/campaigns/${snapshot.campaign.id}/notes`, "POST", {
      ...(activeNote ? { id: activeNote.id } : {}),
      title: title.trim(),
      body,
      tags,
      pinned,
    });
    onSnapshot(next);
    if (!activeNote && next.notes[0]) setActiveNote(next.notes[0]);
    notify("已儲存個人筆記");
  }

  const explainHref = explainDraftHref(
    suiteLinks.explain,
    { text: `${title}\n\n${body}`.trim(), title: title || "活動籌備筆記", back: "#/notes" },
    window.location.hostname,
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, alignItems: "start" }}>
      <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong style={{ fontSize: 14 }}>個人筆記 ({snapshot.notes.length})</strong>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => openNote(null)}>
            <Plus size={13} />
            <span>新筆記</span>
          </button>
        </div>

        {snapshot.notes.map((n) => (
          <div
            key={n.id}
            onClick={() => openNote(n)}
            style={{
              padding: "10px 12px",
              borderRadius: "var(--radius-sm)",
              border: `1px solid ${activeNote?.id === n.id ? "var(--campaign)" : "var(--line)"}`,
              background: activeNote?.id === n.id ? "var(--campaign-tint)" : "var(--panel)",
              cursor: "pointer",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
              <strong style={{ fontSize: 13.5 }}>{n.title}</strong>
              {n.pinned && <Pin size={12} style={{ color: "var(--campaign-text)" }} />}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--text-3)", marginTop: 4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {n.body}
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="記錄靈感、決策脈絡或私下備忘…"
          />
          <button
            type="button"
            className={`btn ${pinned ? "btn-primary" : ""}`}
            onClick={() => setPinned(!pinned)}
          >
            <Pin size={14} />
            <span>{pinned ? "已置頂" : "置頂"}</span>
          </button>
        </div>

        <input
          className="input"
          value={tagsStr}
          onChange={(e) => setTagsStr(e.target.value)}
          placeholder="標籤（以頓號或空白分隔，例如：撞期決策、講者體驗）"
        />

        <textarea
          className="textarea"
          rows={10}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="自由寫下對活動節奏、主持橋段、風險備案的想法…"
        />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                const teamId = snapshot.teams[0]?.id;
                if (!title.trim() || !teamId) return;
                const next = await apiWrite<CampaignSnapshot>(`/api/campaigns/${snapshot.campaign.id}/todos`, "POST", {
                  teamId,
                  title: title.trim(),
                });
                onSnapshot(next);
                notify("已將筆記轉為專案待辦");
              }}
            >
              <span>轉為組別待辦</span>
            </button>
            {explainHref && (
              <a href={explainHref} className="suite-chip suite-chip-explain">
                <Sparkles size={12} />
                <span>在 Explain 拆解概念</span>
                <ArrowUpRight size={12} />
              </a>
            )}
            {activeNote && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  const next = await apiWrite<CampaignSnapshot>(
                    `/api/notes/${activeNote.id}?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
                    "DELETE",
                  );
                  onSnapshot(next);
                  openNote(next.notes[0] ?? null);
                  notify("已刪除筆記");
                }}
              >
                <Trash2 size={13} />
                <span>刪除</span>
              </button>
            )}
          </div>

          <button type="button" className="btn btn-primary" onClick={saveNote}>
            儲存筆記
          </button>
        </div>
      </div>
    </div>
  );
}
