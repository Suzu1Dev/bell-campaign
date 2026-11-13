import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Briefcase,
  CheckCircle2,
  Circle,
  Edit3,
  FileText,
  HardHat,
  Mic,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  PARTNER_STATUSES,
  type CampaignPartner,
  type CampaignSnapshot,
  type PartnerKind,
  type PartnerStatus,
  type TempStaffTask,
} from "../../shared/types";
import { apiWrite } from "../lib/api";

const KIND_META: Record<
  PartnerKind,
  {
    label: string;
    addLabel: string;
    orgLabel: string;
    roleLabel: string;
    feeLabel: string;
    emptyHint: string;
  }
> = {
  speaker: {
    label: "特邀講者",
    addLabel: "新增講者",
    orgLabel: "單位／職稱",
    roleLabel: "主講／與談題目與場次",
    feeLabel: "講師車馬費／出席時段",
    emptyHint: "目前尚無講者資料，可點右上角「新增講者」建立邀約進度。",
  },
  vendor: {
    label: "合作廠商",
    addLabel: "新增廠商",
    orgLabel: "聯絡窗口／統編備註",
    roleLabel: "承攬項目與規格",
    feeLabel: "報價金額／進撤場時段",
    emptyHint: "目前尚無合作廠商，可點右上角「新增廠商」管理音響、外燴或印刷進度。",
  },
  temp_staff: {
    label: "臨時工支援",
    addLabel: "新增臨時工",
    orgLabel: "身份／備註標籤",
    roleLabel: "負責崗位與主要職責",
    feeLabel: "排班時段與津貼",
    emptyHint: "目前尚無臨時工編制，可點右上角「新增臨時工」指派組別與工作清單。",
  },
};

const STATUS_META: Record<PartnerStatus, { label: string; pillClass: string }> = {
  prospect: { label: "待邀約／詢價", pillClass: "pill" },
  contacting: { label: "接洽確認中", pillClass: "pill pill-warn" },
  confirmed: { label: "已確認合作", pillClass: "pill pill-campaign" },
  briefed: { label: "行前資料已寄", pillClass: "pill pill-ok" },
  completed: { label: "已完款／結案", pillClass: "pill pill-ok" },
  declined: { label: "婉拒／未合作", pillClass: "pill pill-danger" },
};

function isConfirmedStatus(st: PartnerStatus): boolean {
  return st === "confirmed" || st === "briefed" || st === "completed";
}

export default function PartnersView({
  snapshot,
  onSnapshot,
  onNavigateFiles,
  notify,
}: {
  snapshot: CampaignSnapshot;
  onSnapshot: (next: CampaignSnapshot) => void;
  onNavigateFiles: () => void;
  notify: (msg: string) => void;
}) {
  const [activeKind, setActiveKind] = useState<PartnerKind>("speaker");
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | PartnerStatus>("all");
  const [query, setQuery] = useState("");
  const [quickTaskDrafts, setQuickTaskDrafts] = useState<Record<string, string>>({});

  // Create / Edit Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formKind, setFormKind] = useState<PartnerKind>("speaker");
  const [formName, setFormName] = useState("");
  const [formOrg, setFormOrg] = useState("");
  const [formRole, setFormRole] = useState("");
  const [formContact, setFormContact] = useState("");
  const [formTeamId, setFormTeamId] = useState<string>("");
  const [formStatus, setFormStatus] = useState<PartnerStatus>("contacting");
  const [formShiftOrFee, setFormShiftOrFee] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formTasks, setFormTasks] = useState<TempStaffTask[]>([]);
  const [newModalTask, setNewModalTask] = useState("");

  const orderedTeams = useMemo(
    () => [...snapshot.teams].sort((a, b) => a.orderIndex - b.orderIndex),
    [snapshot.teams],
  );
  const teamMap = useMemo(() => new Map(orderedTeams.map((t) => [t.id, t])), [orderedTeams]);

  const grouped = useMemo(() => {
    const speakers = snapshot.partners.filter((p) => p.kind === "speaker");
    const vendors = snapshot.partners.filter((p) => p.kind === "vendor");
    const tempStaff = snapshot.partners.filter((p) => p.kind === "temp_staff");
    const allTasks = tempStaff.flatMap((p) => p.tasks);
    const doneTasks = allTasks.filter((t) => t.done).length;
    const taskPct = allTasks.length > 0 ? Math.round((doneTasks / allTasks.length) * 100) : 0;

    return {
      speakers,
      vendors,
      tempStaff,
      speakerConfirmed: speakers.filter((p) => isConfirmedStatus(p.status)).length,
      vendorConfirmed: vendors.filter((p) => isConfirmedStatus(p.status)).length,
      totalTasks: allTasks.length,
      doneTasks,
      taskPct,
    };
  }, [snapshot.partners]);

  const filteredPartners = useMemo(() => {
    const q = query.trim().toLowerCase();
    return snapshot.partners.filter((p) => {
      if (p.kind !== activeKind) return false;
      if (teamFilter !== "all" && p.teamId !== teamFilter) return false;
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (!q) return true;
      const hay = [
        p.name,
        p.organization,
        p.roleOrTopic,
        p.contact,
        p.shiftOrFee,
        p.notes,
        ...p.tasks.map((t) => t.title),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [snapshot.partners, activeKind, teamFilter, statusFilter, query]);

  function openCreateModal(kind: PartnerKind) {
    setEditingId(null);
    setFormKind(kind);
    setFormName("");
    setFormOrg("");
    setFormRole("");
    setFormContact("");
    setFormTeamId(kind === "temp_staff" ? (orderedTeams[0]?.id ?? "") : "");
    setFormStatus("contacting");
    setFormShiftOrFee("");
    setFormNotes("");
    setFormTasks([]);
    setNewModalTask("");
    setModalOpen(true);
  }

  function openEditModal(p: CampaignPartner) {
    setEditingId(p.id);
    setFormKind(p.kind);
    setFormName(p.name);
    setFormOrg(p.organization);
    setFormRole(p.roleOrTopic);
    setFormContact(p.contact);
    setFormTeamId(p.teamId ?? "");
    setFormStatus(p.status);
    setFormShiftOrFee(p.shiftOrFee);
    setFormNotes(p.notes);
    setFormTasks(p.tasks.map((t) => ({ ...t })));
    setNewModalTask("");
    setModalOpen(true);
  }

  async function submitPartnerForm(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim()) return;
    const pendingTask = newModalTask.trim();
    const tasksToSave =
      formKind === "temp_staff"
        ? [
            ...formTasks,
            ...(pendingTask ? [{ id: `st-${Date.now()}`, title: pendingTask, done: false }] : []),
          ]
        : [];
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/campaigns/${snapshot.campaign.id}/partners`,
        "POST",
        {
          ...(editingId ? { id: editingId } : {}),
          kind: formKind,
          name: formName.trim(),
          organization: formOrg.trim(),
          roleOrTopic: formRole.trim(),
          contact: formContact.trim(),
          teamId: formTeamId || null,
          status: formStatus,
          shiftOrFee: formShiftOrFee.trim(),
          notes: formNotes.trim(),
          tasks: tasksToSave,
        },
      );
      onSnapshot(next);
      setActiveKind(formKind);
      setModalOpen(false);
      notify(editingId ? `已更新「${formName.trim()}」資訊` : `已新增${KIND_META[formKind].label}「${formName.trim()}」`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "儲存合作名單失敗");
    }
  }

  async function updatePartnerStatus(partner: CampaignPartner, status: PartnerStatus) {
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/partners/${partner.id}?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
        "PATCH",
        { status },
      );
      onSnapshot(next);
      notify(`已將「${partner.name}」狀態更新為${STATUS_META[status].label}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "更新狀態失敗");
    }
  }

  async function toggleStaffTask(partner: CampaignPartner, taskId: string) {
    const nextTasks = partner.tasks.map((t) => (t.id === taskId ? { ...t, done: !t.done } : t));
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/partners/${partner.id}?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
        "PATCH",
        { tasks: nextTasks },
      );
      onSnapshot(next);
    } catch (err) {
      notify(err instanceof Error ? err.message : "更新工作項目失敗");
    }
  }

  async function addQuickStaffTask(partner: CampaignPartner) {
    const title = (quickTaskDrafts[partner.id] ?? "").trim();
    if (!title) return;
    const nextTasks: TempStaffTask[] = [
      ...partner.tasks,
      { id: `st-${Date.now().toString(36)}`, title, done: false },
    ];
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/partners/${partner.id}?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
        "PATCH",
        { tasks: nextTasks },
      );
      onSnapshot(next);
      setQuickTaskDrafts((prev) => ({ ...prev, [partner.id]: "" }));
      notify(`已為「${partner.name}」新增工作項目`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "新增工作項目失敗");
    }
  }

  async function removePartner(partner: CampaignPartner) {
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/partners/${partner.id}?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
        "DELETE",
      );
      onSnapshot(next);
      setModalOpen(false);
      notify(`已移除「${partner.name}」`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "刪除失敗");
    }
  }

  const meta = KIND_META[activeKind];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* ── Top 3-Category KPI Overview Cards ────────────────────────────── */}
      <section className="radar-grid" aria-label="合作名單分類總覽">
        <div
          className="kpi-card"
          style={{
            cursor: "pointer",
            borderColor: activeKind === "speaker" ? "var(--campaign)" : undefined,
          }}
          onClick={() => setActiveKind("speaker")}
        >
          <div className="kpi-head">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Mic size={14} style={{ color: "var(--campaign-text)" }} />
              <span>特邀講者邀約</span>
            </span>
            <span className="pill pill-campaign tabular">
              已確認 {grouped.speakerConfirmed} / {grouped.speakers.length}
            </span>
          </div>
          <div className="kpi-value tabular">
            {grouped.speakers.length} <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text-3)" }}>位講者與與談人</span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{
                width: `${grouped.speakers.length > 0 ? Math.round((grouped.speakerConfirmed / grouped.speakers.length) * 100) : 0}%`,
              }}
            />
          </div>
        </div>

        <div
          className="kpi-card"
          style={{
            cursor: "pointer",
            borderColor: activeKind === "vendor" ? "var(--campaign)" : undefined,
          }}
          onClick={() => setActiveKind("vendor")}
        >
          <div className="kpi-head">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Briefcase size={14} style={{ color: "var(--campaign-text)" }} />
              <span>合作廠商進度</span>
            </span>
            <span className="pill tabular">
              已定案 {grouped.vendorConfirmed} / {grouped.vendors.length}
            </span>
          </div>
          <div className="kpi-value tabular">
            {grouped.vendors.length} <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text-3)" }}>家協力廠商</span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{
                width: `${grouped.vendors.length > 0 ? Math.round((grouped.vendorConfirmed / grouped.vendors.length) * 100) : 0}%`,
              }}
            />
          </div>
        </div>

        <div
          className="kpi-card"
          style={{
            cursor: "pointer",
            borderColor: activeKind === "temp_staff" ? "var(--campaign)" : undefined,
          }}
          onClick={() => setActiveKind("temp_staff")}
        >
          <div className="kpi-head">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <HardHat size={14} style={{ color: "var(--campaign-text)" }} />
              <span>臨時工編制與任務完成率</span>
            </span>
            <span className="pill pill-ok tabular">{grouped.taskPct}% 完成</span>
          </div>
          <div className="kpi-value tabular">
            {grouped.tempStaff.length} 位{" "}
            <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text-3)" }}>
              · 工作項 {grouped.doneTasks}/{grouped.totalTasks}
            </span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${grouped.taskPct}%` }} />
          </div>
        </div>
      </section>

      {/* ── Segmented Category Bar & Filters ─────────────────────────────── */}
      <section
        className="card"
        style={{
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div className="partner-tabs" role="tablist" aria-label="合作對象分類">
          <button
            type="button"
            role="tab"
            aria-selected={activeKind === "speaker"}
            className={`partner-tab-btn ${activeKind === "speaker" ? "is-active" : ""}`}
            onClick={() => setActiveKind("speaker")}
          >
            <Mic size={14} />
            <span>特邀講者</span>
            <span className="tabular" style={{ opacity: 0.75 }}>({grouped.speakers.length})</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeKind === "vendor"}
            className={`partner-tab-btn ${activeKind === "vendor" ? "is-active" : ""}`}
            onClick={() => setActiveKind("vendor")}
          >
            <Briefcase size={14} />
            <span>合作廠商</span>
            <span className="tabular" style={{ opacity: 0.75 }}>({grouped.vendors.length})</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeKind === "temp_staff"}
            className={`partner-tab-btn ${activeKind === "temp_staff" ? "is-active" : ""}`}
            onClick={() => setActiveKind("temp_staff")}
          >
            <HardHat size={14} />
            <span>臨時工編制與任務</span>
            <span className="tabular" style={{ opacity: 0.75 }}>({grouped.tempStaff.length})</span>
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <select
            aria-label="篩選負責組別"
            className="select"
            style={{ width: 148, height: 32, padding: "0 8px", fontSize: 13 }}
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
          >
            <option value="all">全部所屬組別</option>
            {orderedTeams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <select
            aria-label="篩選接洽狀態"
            className="select"
            style={{ width: 142, height: 32, padding: "0 8px", fontSize: 13 }}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "all" | PartnerStatus)}
          >
            <option value="all">全部接洽狀態</option>
            {PARTNER_STATUSES.map((st) => (
              <option key={st} value={st}>
                {STATUS_META[st].label}
              </option>
            ))}
          </select>

          <div style={{ position: "relative", width: 196 }}>
            <Search
              size={14}
              style={{
                position: "absolute",
                left: 9,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--text-3)",
                pointerEvents: "none",
              }}
            />
            <input
              type="search"
              className="input"
              style={{ height: 32, paddingLeft: 28, fontSize: 13 }}
              placeholder="搜尋姓名、項目、任務…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <button type="button" className="btn btn-primary" onClick={() => openCreateModal(activeKind)}>
            <Plus size={14} />
            <span>{meta.addLabel}</span>
          </button>
        </div>
      </section>

      {/* ── Partner / Temp Staff Cards ───────────────────────────────────── */}
      {filteredPartners.length === 0 ? (
        <div className="card" style={{ padding: 36, textAlign: "center", color: "var(--text-3)" }}>
          <div style={{ fontSize: 14.5, fontWeight: 600, color: "var(--text-2)" }}>{meta.emptyHint}</div>
        </div>
      ) : (
        <section className="partner-grid" aria-label={`${meta.label}清單`}>
          {filteredPartners.map((partner) => {
            const team = partner.teamId ? teamMap.get(partner.teamId) : undefined;
            const st = STATUS_META[partner.status];
            const doneCount = partner.tasks.filter((t) => t.done).length;
            const totalCount = partner.tasks.length;
            const completionPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

            return (
              <article key={partner.id} className="partner-card">
                {/* Header: Name, Team Badge (prominent for Temp Staff), and Status */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 15.5 }}>{partner.name}</strong>
                      {team && (
                        <span className="pill" style={{ height: 21, fontSize: 11.5 }}>
                          <span className={`team-dot team-dot-${team.color}`} />
                          <span>{team.name}</span>
                        </span>
                      )}
                    </div>
                    {partner.organization && (
                      <div style={{ fontSize: 12.5, color: "var(--text-3)", marginTop: 2 }}>
                        {partner.organization}
                      </div>
                    )}
                  </div>

                  <span className={st.pillClass}>{st.label}</span>
                </div>

                {/* Structured Details */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 5,
                    fontSize: 13,
                    padding: "9px 11px",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--panel)",
                    border: "1px solid var(--line)",
                  }}
                >
                  {partner.roleOrTopic && (
                    <div>
                      <span style={{ color: "var(--text-3)" }}>
                        {partner.kind === "speaker" ? "講題／場次：" : partner.kind === "vendor" ? "承攬項目：" : "負責崗位："}
                      </span>
                      <strong style={{ fontWeight: 600 }}>{partner.roleOrTopic}</strong>
                    </div>
                  )}
                  {partner.shiftOrFee && (
                    <div>
                      <span style={{ color: "var(--text-3)" }}>
                        {partner.kind === "temp_staff" ? "排班與津貼：" : "時段／費用："}
                      </span>
                      <span>{partner.shiftOrFee}</span>
                    </div>
                  )}
                  {partner.contact && (
                    <div>
                      <span style={{ color: "var(--text-3)" }}>聯絡窗口：</span>
                      <span>{partner.contact}</span>
                    </div>
                  )}
                </div>

                {/* Temp Staff Dedicated Task Checklist & Completion Progress */}
                {partner.kind === "temp_staff" && (
                  <div className="staff-task-box">
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
                        負責工作項目與完成狀況
                      </span>
                      <span className="tabular" style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--campaign-text)", fontWeight: 600 }}>
                        {doneCount}/{totalCount} 完成 ({completionPct}%)
                      </span>
                    </div>

                    <div className="progress-track" style={{ height: 5 }}>
                      <div className="progress-fill" style={{ width: `${completionPct}%` }} />
                    </div>

                    {partner.tasks.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
                        {partner.tasks.map((task) => (
                          <div key={task.id} className={`staff-task-row ${task.done ? "is-done" : ""}`}>
                            <button
                              type="button"
                              onClick={() => void toggleStaffTask(partner, task.id)}
                              aria-label={`切換完成：${task.title}`}
                              style={{
                                display: "flex",
                                alignItems: "flex-start",
                                gap: 7,
                                border: "none",
                                background: "transparent",
                                padding: 0,
                                textAlign: "left",
                                cursor: "pointer",
                                color: "inherit",
                                flex: 1,
                              }}
                            >
                              <span style={{ color: task.done ? "var(--ok)" : "var(--text-3)", marginTop: 2, flexShrink: 0 }}>
                                {task.done ? <CheckCircle2 size={14} /> : <Circle size={14} />}
                              </span>
                              <span>{task.title}</span>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void addQuickStaffTask(partner);
                      }}
                      style={{ display: "flex", gap: 6, marginTop: 2 }}
                    >
                      <input
                        className="input"
                        style={{ height: 28, fontSize: 12.5 }}
                        placeholder="＋ 指派新工作項目…"
                        value={quickTaskDrafts[partner.id] ?? ""}
                        onChange={(e) =>
                          setQuickTaskDrafts((prev) => ({ ...prev, [partner.id]: e.target.value }))
                        }
                      />
                      <button
                        type="submit"
                        className="btn btn-sm"
                        disabled={!(quickTaskDrafts[partner.id] ?? "").trim()}
                      >
                        新增
                      </button>
                    </form>
                  </div>
                )}

                {partner.notes && (
                  <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.5 }}>
                    備註：{partner.notes}
                  </div>
                )}

                {/* Card Footer: Quick Status Switch + Handbook Link / Edit */}
                <div
                  style={{
                    marginTop: "auto",
                    paddingTop: 10,
                    borderTop: "1px solid var(--line)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <select
                    aria-label={`更新 ${partner.name} 接洽狀態`}
                    className="select"
                    style={{ width: 166, height: 28, padding: "0 8px", fontSize: 12.5 }}
                    value={partner.status}
                    onChange={(e) => void updatePartnerStatus(partner, e.target.value as PartnerStatus)}
                  >
                    {PARTNER_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        狀態：{STATUS_META[s].label}
                      </option>
                    ))}
                  </select>

                  <div style={{ display: "flex", gap: 6 }}>
                    {(partner.kind === "speaker" || partner.kind === "vendor") && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={onNavigateFiles}
                        title="前往文件與手冊頁自動生成行前手冊"
                      >
                        <FileText size={12} />
                        <span>{partner.kind === "speaker" ? "講者手冊" : "廠商須知"}</span>
                      </button>
                    )}
                    <button type="button" className="btn btn-sm" onClick={() => openEditModal(partner)}>
                      <Edit3 size={12} />
                      <span>編輯</span>
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {/* ── Add / Edit Partner Dialog ────────────────────────────────────── */}
      <Dialog.Root open={modalOpen} onOpenChange={setModalOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <form onSubmit={submitPartnerForm} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Dialog.Title style={{ margin: 0, fontSize: 16.5, fontWeight: 700 }}>
                  {editingId ? `編輯${KIND_META[formKind].label}` : KIND_META[formKind].addLabel}
                </Dialog.Title>
                <Dialog.Close asChild>
                  <button type="button" className="icon-btn" aria-label="關閉">
                    <X size={15} />
                  </button>
                </Dialog.Close>
              </div>
              <Dialog.Description style={{ margin: 0, fontSize: 13, color: "var(--text-3)" }}>
                分類管理講者、合作廠商與臨時工編制，隨時掌握接洽進度與任務完成率。
              </Dialog.Description>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label className="field-label">名單分類</label>
                  <select
                    className="select"
                    value={formKind}
                    onChange={(e) => setFormKind(e.target.value as PartnerKind)}
                  >
                    <option value="speaker">特邀講者</option>
                    <option value="vendor">合作廠商</option>
                    <option value="temp_staff">臨時工支援</option>
                  </select>
                </div>
                <div>
                  <label className="field-label">目前接洽／執行狀態</label>
                  <select
                    className="select"
                    value={formStatus}
                    onChange={(e) => setFormStatus(e.target.value as PartnerStatus)}
                  >
                    {PARTNER_STATUSES.map((st) => (
                      <option key={st} value={st}>
                        {STATUS_META[st].label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label className="field-label">姓名／廠商名稱 *</label>
                  <input
                    required
                    className="input"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder={formKind === "vendor" ? "例如：聲光舞台音響工程" : "例如：林雅婷"}
                  />
                </div>
                <div>
                  <label className="field-label">{KIND_META[formKind].orgLabel}</label>
                  <input
                    className="input"
                    value={formOrg}
                    onChange={(e) => setFormOrg(e.target.value)}
                    placeholder="選填"
                  />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label className="field-label">所屬／對口組別</label>
                  <select
                    className="select"
                    value={formTeamId}
                    onChange={(e) => setFormTeamId(e.target.value)}
                  >
                    <option value="">不指定組別</option>
                    {orderedTeams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label">聯絡方式（Email／電話／LINE）</label>
                  <input
                    className="input"
                    value={formContact}
                    onChange={(e) => setFormContact(e.target.value)}
                    placeholder="窗口聯絡資訊"
                  />
                </div>
              </div>

              <div>
                <label className="field-label">{KIND_META[formKind].roleLabel}</label>
                <input
                  className="input"
                  value={formRole}
                  onChange={(e) => setFormRole(e.target.value)}
                />
              </div>

              <div>
                <label className="field-label">{KIND_META[formKind].feeLabel}</label>
                <input
                  className="input"
                  value={formShiftOrFee}
                  onChange={(e) => setFormShiftOrFee(e.target.value)}
                  placeholder={formKind === "temp_staff" ? "例如：8/05 08:00–17:30 · 時薪 NT$220" : "例如：報價 NT$32,000（含稅）"}
                />
              </div>

              {formKind === "temp_staff" && (
                <div className="staff-task-box">
                  <label className="field-label" style={{ marginBottom: 0 }}>
                    負責工作項目清單
                  </label>
                  {formTasks.map((t) => (
                    <div key={t.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
                      <span>{t.done ? `✓ ${t.title}` : `• ${t.title}`}</span>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ border: "none", padding: 2, cursor: "pointer" }}
                        onClick={() => setFormTasks(formTasks.filter((x) => x.id !== t.id))}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      className="input"
                      placeholder="輸入負責工作項目後點加入…"
                      value={newModalTask}
                      onChange={(e) => setNewModalTask(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && newModalTask.trim()) {
                          e.preventDefault();
                          setFormTasks([
                            ...formTasks,
                            { id: `st-${Date.now().toString(36)}`, title: newModalTask.trim(), done: false },
                          ]);
                          setNewModalTask("");
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        if (!newModalTask.trim()) return;
                        setFormTasks([
                          ...formTasks,
                          { id: `st-${Date.now().toString(36)}`, title: newModalTask.trim(), done: false },
                        ]);
                        setNewModalTask("");
                      }}
                    >
                      加入
                    </button>
                  </div>
                </div>
              )}

              <div>
                <label className="field-label">接洽與現場備註</label>
                <textarea
                  rows={2}
                  className="textarea"
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                <div>
                  {editingId && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        const target = snapshot.partners.find((x) => x.id === editingId);
                        if (target) void removePartner(target);
                      }}
                    >
                      <Trash2 size={13} />
                      <span>刪除此筆</span>
                    </button>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="btn" onClick={() => setModalOpen(false)}>
                    取消
                  </button>
                  <button type="submit" className="btn btn-primary">
                    儲存名單
                  </button>
                </div>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
