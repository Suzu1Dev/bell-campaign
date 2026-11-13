import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  Calendar,
  CheckCircle2,
  Circle,
  Pin,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { CampaignMeeting, CampaignNote, CampaignSnapshot } from "../../shared/types";
import { explainDraftHref, personalTaskHref, type SuiteLinks } from "../../shared/suite";
import { computeCampaignMetrics } from "../../shared/sheets";
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
                <span className="pill">{tp.latestStage}</span>
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

// ── 2. Meetings Workspace (`#/meetings`) ───────────────────────────────────
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
        }
      : {
          title: "",
          meetingDate: new Date().toISOString().slice(0, 10) + " 20:30",
          attendees: "",
          agenda: "",
          arrangements: "",
          precautions: "",
          decisions: "",
        },
  );

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
    });
  }

  async function saveMeeting() {
    if (!draft.title.trim()) {
      notify("請輸入會議標題");
      return;
    }
    const next = await apiWrite<CampaignSnapshot>(
      `/api/campaigns/${snapshot.campaign.id}/meetings`,
      "POST",
      {
        ...(selectedId !== "new" ? { id: selectedId } : {}),
        ...draft,
      },
    );
    onSnapshot(next);
    if (selectedId === "new" && next.meetings[0]) {
      setSelectedId(next.meetings[0].id);
    }
    notify("已儲存會議記錄");
  }

  async function convertDecisionToTodo() {
    const text = draft.decisions.trim().split(/\n+/)[0]?.trim();
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

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, alignItems: "start" }}>
      <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong style={{ fontSize: 14 }}>會議列表 ({snapshot.meetings.length})</strong>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => selectMeeting(null)}>
            <Plus size={13} />
            <span>新增會議</span>
          </button>
        </div>

        {snapshot.meetings.map((m) => (
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
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{m.title}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-3)", marginTop: 4 }}>
              <Calendar size={12} />
              <span className="tabular">{m.meetingDate}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, gridColumn: "span 1" }}>
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
