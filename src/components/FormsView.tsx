import { useCallback, useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Check,
  ClipboardList,
  ExternalLink,
  FileSpreadsheet,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  UserCheck,
  Users,
  X,
} from "lucide-react";
import {
  APPLICANT_ROLES,
  APPLICANT_STATUSES,
  type ApplicantRole,
  type ApplicantStatus,
  type CampaignSnapshot,
  type FormResponseItem,
} from "../../shared/types";
import type { SuiteLinks } from "../../shared/suite";
import { apiWrite } from "../lib/api";
import SuiteHandoffMenu from "./SuiteHandoffMenu";

const STATUS_META: Record<ApplicantStatus, { label: string; pillClass: string }> = {
  pending: { label: "待審核", pillClass: "pill pill-warn" },
  interview: { label: "面談中", pillClass: "pill pill-campaign" },
  accepted: { label: "已錄取", pillClass: "pill pill-ok" },
  waitlist: { label: "備取", pillClass: "pill" },
  declined: { label: "婉拒", pillClass: "pill pill-danger" },
};

const ROLE_LABELS: Record<ApplicantRole, string> = {
  core: "籌備幹部",
  staff: "組員",
  day_volunteer: "當日志工",
};

const SHIFT_SLOTS = ["會前每週籌備", "8/04 場佈", "8/05 全日", "撤場"] as const;

export default function FormsView({
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
  const activeForm = snapshot.forms[0] ?? null;
  const responses = useMemo(
    () =>
      activeForm
        ? snapshot.formResponses.filter((r) => r.formId === activeForm.id)
        : snapshot.formResponses,
    [activeForm, snapshot.formResponses],
  );

  const orderedTeams = useMemo(
    () => [...snapshot.teams].sort((a, b) => a.orderIndex - b.orderIndex),
    [snapshot.teams],
  );
  const teamMap = useMemo(() => new Map(orderedTeams.map((t) => [t.id, t])), [orderedTeams]);

  const [statusFilter, setStatusFilter] = useState<"all" | ApplicantStatus>("all");
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [query, setQuery] = useState("");

  // Review drawer / modal state
  const [reviewing, setReviewing] = useState<FormResponseItem | null>(null);
  const [revStatus, setRevStatus] = useState<ApplicantStatus>("pending");
  const [revTeamId, setRevTeamId] = useState<string>("");
  const [revNote, setRevNote] = useState<string>("");

  // Form settings & Google Sheet sync state
  const [formEditOpen, setFormEditOpen] = useState(false);
  const [formTitle, setFormTitle] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formSheetSyncUrl, setFormSheetSyncUrl] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formStatus, setFormStatus] = useState<"open" | "closed">("open");
  const [syncingSheet, setSyncingSheet] = useState(false);
  const [autoRefreshSheet, setAutoRefreshSheet] = useState(false);

  // Manual add modal
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newHandle, setNewHandle] = useState("");
  const [newTeamId, setNewTeamId] = useState(orderedTeams[0]?.id ?? "");
  const [newSecTeamId, setNewSecTeamId] = useState<string>("");
  const [newRole, setNewRole] = useState<ApplicantRole>("staff");
  const [newSkills, setNewSkills] = useState("");
  const [newAvail, setNewAvail] = useState<string[]>(["8/05 全日"]);
  const [newExp, setNewExp] = useState("");
  const [newShirt, setNewShirt] = useState("M · 葷食");

  // CSV Import modal
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvText, setCsvText] = useState("");

  const statusCounts = useMemo(() => {
    const counts: Record<"all" | ApplicantStatus, number> = {
      all: responses.length,
      pending: 0,
      interview: 0,
      accepted: 0,
      waitlist: 0,
      declined: 0,
    };
    for (const r of responses) counts[r.status] += 1;
    return counts;
  }, [responses]);

  const teamStats = useMemo(() => {
    return orderedTeams.map((team) => {
      const accepted = responses.filter((r) => r.preferredTeamId === team.id && r.status === "accepted").length;
      const pending = responses.filter(
        (r) => r.preferredTeamId === team.id && (r.status === "pending" || r.status === "interview"),
      ).length;
      const gap = Math.max(0, team.targetHeadcount - accepted);
      const fillPct = team.targetHeadcount > 0 ? Math.min(100, Math.round((accepted / team.targetHeadcount) * 100)) : 100;
      return { team, accepted, pending, gap, fillPct };
    });
  }, [orderedTeams, responses]);

  const shiftCoverage = useMemo(() => {
    return SHIFT_SLOTS.map((slot) => {
      let accepted = 0;
      let candidate = 0;
      for (const r of responses) {
        const hit = r.availability.some((a) => a.includes(slot) || slot.includes(a));
        if (!hit) continue;
        if (r.status === "accepted") accepted += 1;
        else if (r.status === "pending" || r.status === "interview" || r.status === "waitlist") candidate += 1;
      }
      return { slot, accepted, candidate };
    });
  }, [responses]);

  const filteredResponses = useMemo(() => {
    const q = query.trim().toLowerCase();
    return responses.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (teamFilter !== "all" && r.preferredTeamId !== teamFilter && r.secondaryTeamId !== teamFilter) return false;
      if (!q) return true;
      const haystack = [
        r.applicantName,
        r.handle,
        r.email,
        r.experience,
        r.reviewerNote,
        ...r.skills,
        ...r.availability,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [responses, statusFilter, teamFilter, query]);

  const totalTarget = orderedTeams.reduce((acc, t) => acc + t.targetHeadcount, 0);
  const totalAccepted = statusCounts.accepted;

  function openReview(item: FormResponseItem) {
    setReviewing(item);
    setRevStatus(item.status);
    setRevTeamId(item.preferredTeamId);
    setRevNote(item.reviewerNote);
  }

  async function saveReview(nextStatus?: ApplicantStatus) {
    if (!reviewing) return;
    const statusToSave = nextStatus ?? revStatus;
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/form-responses/${reviewing.id}?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
        "PATCH",
        {
          status: statusToSave,
          preferredTeamId: revTeamId,
          reviewerNote: revNote,
        },
      );
      onSnapshot(next);
      setReviewing(null);
      notify(`已更新「${reviewing.applicantName}」審核狀態為${STATUS_META[statusToSave].label}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "更新審核狀態失敗");
    }
  }

  function openFormSettings() {
    if (!activeForm) return;
    setFormTitle(activeForm.title);
    setFormUrl(activeForm.sourceUrl);
    setFormSheetSyncUrl(activeForm.sheetSyncUrl ?? "");
    setFormDesc(activeForm.description);
    setFormStatus(activeForm.status);
    setFormEditOpen(true);
  }

  async function saveFormSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!activeForm || !formTitle.trim()) return;
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/forms/${activeForm.id}?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
        "PATCH",
        {
          title: formTitle.trim(),
          sourceUrl: formUrl.trim(),
          sheetSyncUrl: formSheetSyncUrl.trim(),
          description: formDesc.trim(),
          status: formStatus,
        },
      );
      onSnapshot(next);
      setFormEditOpen(false);
      notify("已更新招工表單與同步設定");
    } catch (err) {
      notify(err instanceof Error ? err.message : "更新失敗");
    }
  }

  const syncFromGoogleSheet = useCallback(
    async (silent = false, overrideUrl?: string) => {
      if (!activeForm) return;
      const targetUrl = (overrideUrl ?? activeForm.sheetSyncUrl ?? "").trim();
      if (!targetUrl) {
        if (!silent) openFormSettings();
        return;
      }
      setSyncingSheet(true);
      try {
        const res = await apiWrite<{ importedCount: number; snapshot: CampaignSnapshot }>(
          `/api/campaigns/${snapshot.campaign.id}/forms/${activeForm.id}/sync-sheet`,
          "POST",
          { sheetSyncUrl: targetUrl },
        );
        onSnapshot(res.snapshot);
        if (!silent || res.importedCount > 0) {
          notify(
            res.importedCount > 0
              ? `已從連結試算表同步新增 ${res.importedCount} 筆新回覆（重複名單已自動略過）`
              : "已檢查連結試算表，目前無新增報名回覆",
          );
        }
      } catch (err) {
        if (!silent) notify(err instanceof Error ? err.message : "同步試算表失敗");
      } finally {
        setSyncingSheet(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeForm, snapshot.campaign.id, onSnapshot, notify],
  );

  useEffect(() => {
    if (!autoRefreshSheet || !activeForm?.sheetSyncUrl) return;
    const timer = window.setInterval(() => {
      void syncFromGoogleSheet(true);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [autoRefreshSheet, activeForm?.sheetSyncUrl, syncFromGoogleSheet]);

  async function submitNewApplicant(e: React.FormEvent) {
    e.preventDefault();
    if (!activeForm || !newName.trim()) return;
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/forms/${activeForm.id}/responses?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
        "POST",
        {
          applicantName: newName.trim(),
          email: newEmail.trim(),
          handle: newHandle.trim(),
          preferredTeamId: newTeamId || orderedTeams[0]?.id || "",
          secondaryTeamId: newSecTeamId || null,
          roleType: newRole,
          skills: newSkills
            .split(/[,、/]/)
            .map((s) => s.trim())
            .filter(Boolean),
          availability: newAvail,
          experience: newExp.trim(),
          dietaryOrShirt: newShirt.trim(),
        },
      );
      onSnapshot(next);
      setAddOpen(false);
      setNewName("");
      setNewEmail("");
      setNewHandle("");
      setNewSkills("");
      setNewExp("");
      notify("已新增招工回覆紀錄");
    } catch (err) {
      notify(err instanceof Error ? err.message : "新增回覆失敗");
    }
  }

  async function submitCsvImport(e: React.FormEvent) {
    e.preventDefault();
    if (!activeForm || !csvText.trim()) return;
    try {
      const res = await apiWrite<{ importedCount: number; snapshot: CampaignSnapshot }>(
        `/api/campaigns/${snapshot.campaign.id}/forms/${activeForm.id}/import-csv`,
        "POST",
        { csvText },
      );
      onSnapshot(res.snapshot);
      setCsvOpen(false);
      setCsvText("");
      notify(`成功匯入 ${res.importedCount} 筆招工表單回覆`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "CSV 匯入失敗");
    }
  }

  function toggleShift(slot: string) {
    setNewAvail((prev) => (prev.includes(slot) ? prev.filter((s) => s !== slot) : [...prev, slot]));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* ── Form Overview Banner ─────────────────────────────────────────── */}
      <section className="card" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 240, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className={activeForm?.status === "closed" ? "pill" : "pill pill-ok"}>
                {activeForm?.status === "closed" ? "招募已截止" : "招募開放中"}
              </span>
              <span className="pill pill-campaign tabular">
                總錄取 {totalAccepted} / {totalTarget} 人
              </span>
              {statusCounts.pending > 0 && (
                <span className="pill pill-warn tabular">待審核 {statusCounts.pending} 筆</span>
              )}
            </div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: "-0.015em" }}>
              {activeForm?.title ?? "籌備團隊與志工招工表單"}
            </h2>
            {activeForm?.description && (
              <p style={{ margin: 0, fontSize: 13.5, color: "var(--text-2)" }}>{activeForm.description}</p>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {activeForm?.sourceUrl && /^https?:\/\//i.test(activeForm.sourceUrl) && (
              <a
                href={activeForm.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="btn"
                title="開啟外部 Google Forms 表單"
              >
                <ExternalLink size={14} />
                <span>開啟表單連結</span>
              </a>
            )}
            {activeForm && (
              <button type="button" className="btn" onClick={openFormSettings}>
                <Settings2 size={14} />
                <span>表單與同步設定</span>
              </button>
            )}
            <button type="button" className="btn" onClick={() => setCsvOpen(true)}>
              <FileSpreadsheet size={14} />
              <span>匯入 CSV</span>
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>
              <Plus size={14} />
              <span>新增回覆</span>
            </button>
          </div>
        </div>

        {/* Google Sheet Deduplicated Sync Strip */}
        {activeForm && (
          <div
            style={{
              padding: "9px 12px",
              borderRadius: "var(--radius-sm)",
              background: "var(--panel)",
              border: "1px solid var(--line)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              flexWrap: "wrap",
              fontSize: 12.5,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", color: "var(--text-2)" }}>
              <FileSpreadsheet size={14} style={{ color: "var(--campaign-text)", flexShrink: 0 }} />
              {activeForm.sheetSyncUrl ? (
                <>
                  <span>
                    已綁定招工回覆試算表（自動過濾重複報名）
                    {activeForm.lastSyncedAt
                      ? ` · 上次同步 ${new Date(activeForm.lastSyncedAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}`
                      : ""}
                  </span>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer", color: "var(--text-3)" }}>
                    <input
                      type="checkbox"
                      checked={autoRefreshSheet}
                      onChange={(e) => setAutoRefreshSheet(e.target.checked)}
                    />
                    <span>停留本頁時每 60 秒自動拉取</span>
                  </label>
                </>
              ) : (
                <span>
                  CSV 為手動匯入；若綁定 Google 表單連結的回覆試算表，即可一鍵拉取最新報名並自動去重。
                </span>
              )}
            </div>

            <div style={{ display: "flex", gap: 6 }}>
              {activeForm.sheetSyncUrl ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={syncingSheet}
                  onClick={() => void syncFromGoogleSheet(false)}
                >
                  <RefreshCw size={12} />
                  <span>{syncingSheet ? "同步中…" : "立即同步最新回覆"}</span>
                </button>
              ) : (
                <button type="button" className="btn btn-sm" onClick={openFormSettings}>
                  <span>連結回覆試算表</span>
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── Per-Team Headcount Fulfillment & Gap Radar ───────────────────── */}
      <section aria-label="各組別人力編制與缺口雷達">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
            <Users size={15} style={{ color: "var(--campaign-text)" }} />
            <span>各組別人力編制與缺口（點擊卡片篩選組別）</span>
          </div>
          {teamFilter !== "all" && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTeamFilter("all")}>
              顯示全部組別
            </button>
          )}
        </div>

        <div className="radar-grid">
          {teamStats.map(({ team, accepted, pending, gap, fillPct }) => {
            const active = teamFilter === team.id;
            return (
              <div
                key={team.id}
                className="kpi-card"
                role="button"
                tabIndex={0}
                onClick={() => setTeamFilter(active ? "all" : team.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setTeamFilter(active ? "all" : team.id);
                  }
                }}
                style={{
                  cursor: "pointer",
                  borderColor: active ? "var(--campaign)" : undefined,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span className={`team-dot team-dot-${team.color}`} />
                    <strong style={{ fontSize: 14 }}>{team.name}</strong>
                  </div>
                  {gap > 0 ? (
                    <span className="pill pill-warn tabular">尚缺 {gap} 人</span>
                  ) : (
                    <span className="pill pill-ok">已滿額</span>
                  )}
                </div>

                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 2 }}>
                  <span className="kpi-value tabular">
                    {accepted}{" "}
                    <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text-3)" }}>
                      / {team.targetHeadcount} 人
                    </span>
                  </span>
                  <span className="tabular" style={{ fontSize: 12.5, color: "var(--text-3)" }}>
                    候選審核中 {pending} 人
                  </span>
                </div>

                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${fillPct}%` }} />
                </div>

                <div style={{ fontSize: 12, color: "var(--text-3)" }}>組長：{team.lead || "未指定"}</div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Shift Availability Coverage Strip ────────────────────────────── */}
      <section className="card" style={{ padding: "12px 16px" }} aria-label="關鍵時段出勤覆蓋度">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
            gap: 12,
          }}
        >
          {shiftCoverage.map((sc) => (
            <div
              key={sc.slot}
              style={{
                padding: "8px 12px",
                borderRadius: "var(--radius-sm)",
                background: "var(--panel)",
                border: "1px solid var(--line)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{sc.slot}</div>
                <div style={{ fontSize: 12, color: "var(--text-3)" }}>出勤時段覆蓋</div>
              </div>
              <div style={{ textAlign: "right" }} className="tabular">
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--campaign-text)" }}>
                  {sc.accepted} 位已錄取
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>+{sc.candidate} 位候選可支援</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Filter Bar & Applicant Cards ─────────────────────────────────── */}
      <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div
          className="card"
          style={{
            padding: "10px 14px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {(
              [
                { id: "all", label: "全部" },
                { id: "pending", label: "待審核" },
                { id: "interview", label: "面談中" },
                { id: "accepted", label: "已錄取" },
                { id: "waitlist", label: "備取" },
                { id: "declined", label: "婉拒" },
              ] as const
            ).map((tab) => {
              const active = statusFilter === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={active ? "btn btn-primary btn-sm" : "btn btn-sm"}
                  onClick={() => setStatusFilter(tab.id)}
                >
                  <span>{tab.label}</span>
                  <span className="tabular" style={{ opacity: 0.85 }}>
                    {statusCounts[tab.id]}
                  </span>
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flex: "1 1 260px", justifyContent: "flex-end" }}>
            <select
              aria-label="篩選志願組別"
              className="select"
              style={{ width: 156, height: 30, padding: "0 8px", fontSize: 13 }}
              value={teamFilter}
              onChange={(e) => setTeamFilter(e.target.value)}
            >
              <option value="all">所有志願組別</option>
              {orderedTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>

            <div style={{ position: "relative", width: 220, maxWidth: "100%" }}>
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
                style={{ height: 30, paddingLeft: 28, fontSize: 13 }}
                placeholder="搜尋姓名、專長、經驗…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
        </div>

        {filteredResponses.length === 0 ? (
          <div className="card" style={{ padding: 36, textAlign: "center", color: "var(--text-3)" }}>
            <ClipboardList size={26} style={{ marginBottom: 8, opacity: 0.6 }} />
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-2)" }}>沒有符合篩選條件的招工回覆</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>可切換上方狀態標籤，或點選「匯入表單 CSV」載入最新回覆。</div>
          </div>
        ) : (
          <div className="applicant-grid">
            {filteredResponses.map((item) => {
              const prefTeam = teamMap.get(item.preferredTeamId);
              const secTeam = item.secondaryTeamId ? teamMap.get(item.secondaryTeamId) : undefined;
              const st = STATUS_META[item.status];
              return (
                <article
                  key={item.id}
                  className="applicant-card"
                  onClick={() => openReview(item)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openReview(item);
                    }
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                        <strong style={{ fontSize: 15 }}>{item.applicantName}</strong>
                        <span className="pill" style={{ height: 20, fontSize: 11.5 }}>
                          {ROLE_LABELS[item.roleType]}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>
                        {[item.handle, item.email].filter(Boolean).join(" · ") || "未填聯絡代號"}
                      </div>
                    </div>
                    <span className={st.pillClass}>{st.label}</span>
                  </div>

                  {/* Preferred & Secondary Team */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5 }}>
                    {prefTeam && (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          fontWeight: 600,
                          color: "var(--text)",
                        }}
                      >
                        <span className={`team-dot team-dot-${prefTeam.color}`} />
                        <span>第一志願：{prefTeam.name}</span>
                      </span>
                    )}
                    {secTeam && (
                      <span style={{ color: "var(--text-3)" }}>· 第二志願：{secTeam.name}</span>
                    )}
                  </div>

                  {/* Experience */}
                  {item.experience && (
                    <p
                      style={{
                        margin: 0,
                        fontSize: 13,
                        lineHeight: 1.55,
                        color: "var(--text-2)",
                      }}
                    >
                      {item.experience}
                    </p>
                  )}

                  {/* Skills */}
                  {item.skills.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                      {item.skills.map((sk) => (
                        <span
                          key={sk}
                          className="pill pill-campaign"
                          style={{ height: 21, fontSize: 11.5, padding: "0 7px" }}
                        >
                          {sk}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Availability & Shirt/Diet */}
                  <div
                    style={{
                      marginTop: "auto",
                      paddingTop: 8,
                      borderTop: "1px solid var(--line)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      flexWrap: "wrap",
                      fontSize: 12,
                      color: "var(--text-3)",
                    }}
                  >
                    <span>
                      可出勤：{item.availability.length > 0 ? item.availability.join("、") : "待確認"}
                    </span>
                    {item.dietaryOrShirt && <span>{item.dietaryOrShirt}</span>}
                  </div>

                  {item.reviewerNote && (
                    <div
                      style={{
                        padding: "6px 9px",
                        borderRadius: "var(--radius-xs)",
                        background: "var(--panel)",
                        border: "1px solid var(--line)",
                        fontSize: 12,
                        color: "var(--text-2)",
                      }}
                    >
                      審核備註：{item.reviewerNote}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Applicant Review Dialog ──────────────────────────────────────── */}
      <Dialog.Root open={Boolean(reviewing)} onOpenChange={(open) => !open && setReviewing(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            {reviewing && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <Dialog.Title style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
                      審核應徵者 · {reviewing.applicantName}
                    </Dialog.Title>
                    <Dialog.Description style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-3)" }}>
                      {[ROLE_LABELS[reviewing.roleType], reviewing.handle, reviewing.email, reviewing.dietaryOrShirt]
                        .filter(Boolean)
                        .join(" · ")}
                    </Dialog.Description>
                  </div>
                  <Dialog.Close asChild>
                    <button type="button" className="icon-btn" aria-label="關閉">
                      <X size={15} />
                    </button>
                  </Dialog.Close>
                </div>

                <div
                  style={{
                    padding: "12px 14px",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--panel)",
                    border: "1px solid var(--line)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    fontSize: 13.5,
                  }}
                >
                  <div>
                    <strong>過往經驗與動機：</strong>
                    <div style={{ marginTop: 3, color: "var(--text-2)" }}>
                      {reviewing.experience || "（未填寫）"}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    <strong>專長標籤：</strong>
                    {reviewing.skills.length > 0
                      ? reviewing.skills.map((s) => (
                          <span key={s} className="pill pill-campaign">
                            {s}
                          </span>
                        ))
                      : "無"}
                  </div>
                  <div>
                    <strong>可配合時段：</strong>{" "}
                    <span style={{ color: "var(--text-2)" }}>
                      {reviewing.availability.join(" · ") || "未勾選"}
                    </span>
                  </div>
                </div>

                {/* Quick Status Buttons */}
                <div>
                  <label className="field-label">審核狀態（點選可直接切換）</label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {APPLICANT_STATUSES.map((st) => {
                      const active = revStatus === st;
                      return (
                        <button
                          key={st}
                          type="button"
                          className={active ? "btn btn-primary btn-sm" : "btn btn-sm"}
                          onClick={() => setRevStatus(st)}
                        >
                          {active && <Check size={13} />}
                          <span>{STATUS_META[st].label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="field-label" htmlFor="rev-team-select">
                    分發組別（可依各組缺口調度）
                  </label>
                  <select
                    id="rev-team-select"
                    className="select"
                    value={revTeamId}
                    onChange={(e) => setRevTeamId(e.target.value)}
                  >
                    {orderedTeams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="field-label" htmlFor="rev-note">
                    總召／組長審核備註
                  </label>
                  <textarea
                    id="rev-note"
                    rows={3}
                    className="textarea"
                    placeholder="記錄面談印象、預計安排的桌次或職務分工…"
                    value={revNote}
                    onChange={(e) => setRevNote(e.target.value)}
                  />
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    paddingTop: 6,
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <SuiteHandoffMenu
                      links={suiteLinks}
                      title={`志工審核：${reviewing.applicantName}`}
                      text={[
                        `寄發志工${STATUS_META[revStatus].label}通知給 ${reviewing.applicantName}（${reviewing.email || reviewing.handle || "無聯絡方式"}）`,
                        `分發組別：${teamMap.get(revTeamId)?.name ?? "待分發"} · 職務：${ROLE_LABELS[reviewing.roleType]}`,
                        reviewing.skills.length > 0 ? `專長：${reviewing.skills.join("、")}` : "",
                        reviewing.availability.length > 0 ? `時段：${reviewing.availability.join(" · ")}` : "",
                        revNote.trim() ? `審核備註：${revNote.trim()}` : "",
                      ]
                        .filter(Boolean)
                        .join("\n")}
                      back="#/forms"
                    />
                  </div>

                  <div style={{ display: "flex", gap: 8 }}>
                    {reviewing.status !== "accepted" && (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void saveReview("accepted")}
                      >
                        <UserCheck size={14} />
                        <span>一鍵錄取分發</span>
                      </button>
                    )}
                    <button type="button" className="btn btn-primary" onClick={() => void saveReview()}>
                      儲存審核結果
                    </button>
                  </div>
                </div>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── Manual Add Response Dialog ───────────────────────────────────── */}
      <Dialog.Root open={addOpen} onOpenChange={setAddOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <form onSubmit={submitNewApplicant} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Dialog.Title style={{ margin: 0, fontSize: 16.5, fontWeight: 700 }}>新增招工表單回覆</Dialog.Title>
                <Dialog.Close asChild>
                  <button type="button" className="icon-btn" aria-label="關閉">
                    <X size={15} />
                  </button>
                </Dialog.Close>
              </div>
              <Dialog.Description style={{ margin: 0, fontSize: 13, color: "var(--text-3)" }}>
                手動補登夥伴報名資訊，送出後會立即更新各組人力雷達。
              </Dialog.Description>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label className="field-label">姓名 *</label>
                  <input
                    required
                    className="input"
                    placeholder="例如：王宥辰"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label">社群代號（Discord / Telegram）</label>
                  <input
                    className="input"
                    placeholder="@yc_wang"
                    value={newHandle}
                    onChange={(e) => setNewHandle(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label className="field-label">Email</label>
                  <input
                    type="email"
                    className="input"
                    placeholder="name@example.com"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label">報名角色</label>
                  <select
                    className="select"
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as ApplicantRole)}
                  >
                    {APPLICANT_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label className="field-label">第一志願組別</label>
                  <select className="select" value={newTeamId} onChange={(e) => setNewTeamId(e.target.value)}>
                    {orderedTeams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label">第二志願組別（選填）</label>
                  <select className="select" value={newSecTeamId} onChange={(e) => setNewSecTeamId(e.target.value)}>
                    <option value="">無</option>
                    {orderedTeams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="field-label">可配合出勤時段</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {SHIFT_SLOTS.map((slot) => {
                    const checked = newAvail.includes(slot);
                    return (
                      <button
                        key={slot}
                        type="button"
                        className={checked ? "btn btn-primary btn-sm" : "btn btn-sm"}
                        onClick={() => toggleShift(slot)}
                      >
                        {checked && <Check size={12} />}
                        <span>{slot}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
                <div>
                  <label className="field-label">專長標籤（以逗號分隔）</label>
                  <input
                    className="input"
                    placeholder="攝影側拍, 報到分流, Figma"
                    value={newSkills}
                    onChange={(e) => setNewSkills(e.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label">衣服尺寸與飲食</label>
                  <input
                    className="input"
                    placeholder="L · 葷食"
                    value={newShirt}
                    onChange={(e) => setNewShirt(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className="field-label">相關籌備經驗與自我介紹</label>
                <textarea
                  rows={3}
                  className="textarea"
                  placeholder="簡述曾參與過的活動或想嘗試的任務…"
                  value={newExp}
                  onChange={(e) => setNewExp(e.target.value)}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                <button type="button" className="btn" onClick={() => setAddOpen(false)}>
                  取消
                </button>
                <button type="submit" className="btn btn-primary">
                  新增回覆
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── CSV Import Dialog ────────────────────────────────────────────── */}
      <Dialog.Root open={csvOpen} onOpenChange={setCsvOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <form onSubmit={submitCsvImport} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Dialog.Title style={{ margin: 0, fontSize: 16.5, fontWeight: 700 }}>
                  匯入 Google 表單招工回覆 CSV
                </Dialog.Title>
                <Dialog.Close asChild>
                  <button type="button" className="icon-btn" aria-label="關閉">
                    <X size={15} />
                  </button>
                </Dialog.Close>
              </div>
              <Dialog.Description style={{ margin: 0, fontSize: 13, color: "var(--text-3)" }}>
                從 Google 表單連結的試算表複製或匯出 CSV 貼上，系統會自動對應「姓名、Email、志願組別、專長、可配合時段、經驗、飲食尺寸」欄位。
              </Dialog.Description>

              <textarea
                rows={8}
                className="textarea"
                style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}
                placeholder={`姓名,Email,Discord,第一志願,角色,專長,可配合時段,相關經驗,飲食尺寸\n林哲宇,cheyu@example.com,@cheyu,場務與志工組,當日志工,"QR 報到, 機動支援","8/04 場佈, 8/05 全日",曾任校園研討會報到志工,L · 葷食`}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
              />

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    setCsvText(
                      `姓名,Email,Discord,第一志願,角色,專長,可配合時段,相關經驗,飲食尺寸\n林哲宇,cheyu@example.com,@cheyu,場務與志工組,當日志工,"QR 報到, 機動支援","8/04 場佈, 8/05 全日, 撤場",曾任兩屆研討會前台驗票與動線引導,L · 葷食\n溫予柔,yurou@example.com,@yurou_ux,世界咖啡館,組員,"桌長引導, 視覺筆記","會前每週籌備, 8/05 全日",擅長引導跨領域討論與心智圖收斂,S · 蛋奶素`,
                    )
                  }
                >
                  填入範例 CSV
                </button>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="btn" onClick={() => setCsvOpen(false)}>
                    取消
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={!csvText.trim()}>
                    開始匯入
                  </button>
                </div>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── Form Settings Dialog ─────────────────────────────────────────── */}
      <Dialog.Root open={formEditOpen} onOpenChange={setFormEditOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <form onSubmit={saveFormSettings} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Dialog.Title style={{ margin: 0, fontSize: 16.5, fontWeight: 700 }}>招工表單設定</Dialog.Title>
                <Dialog.Close asChild>
                  <button type="button" className="icon-btn" aria-label="關閉">
                    <X size={15} />
                  </button>
                </Dialog.Close>
              </div>
              <Dialog.Description style={{ margin: 0, fontSize: 13, color: "var(--text-3)" }}>
                連結外部 Google Forms 網址並管理招募開放狀態。
              </Dialog.Description>

              <div>
                <label className="field-label">表單名稱</label>
                <input className="input" value={formTitle} onChange={(e) => setFormTitle(e.target.value)} required />
              </div>

              <div>
                <label className="field-label">外部表單網址（Google Forms / Tally）</label>
                <input
                  className="input"
                  placeholder="https://docs.google.com/forms/..."
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                />
              </div>

              <div>
                <label className="field-label">
                  連結招工回覆 Google 試算表網址（選填，開啟「知道連結的任何人可檢視」即可一鍵同步新回覆並去重）
                </label>
                <input
                  className="input"
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  value={formSheetSyncUrl}
                  onChange={(e) => setFormSheetSyncUrl(e.target.value)}
                />
              </div>

              <div>
                <label className="field-label">招募說明</label>
                <textarea
                  rows={2}
                  className="textarea"
                  value={formDesc}
                  onChange={(e) => setFormDesc(e.target.value)}
                />
              </div>

              <div>
                <label className="field-label">招募狀態</label>
                <select
                  className="select"
                  value={formStatus}
                  onChange={(e) => setFormStatus(e.target.value as "open" | "closed")}
                >
                  <option value="open">招募開放中</option>
                  <option value="closed">招募已截止</option>
                </select>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="btn" onClick={() => setFormEditOpen(false)}>
                  取消
                </button>
                <button type="submit" className="btn btn-primary">
                  儲存設定
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
