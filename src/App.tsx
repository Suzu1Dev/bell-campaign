import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  Bot,
  Briefcase,
  CalendarRange,
  CheckSquare,
  ChevronsUpDown,
  ClipboardList,
  FolderArchive,
  Lightbulb,
  Menu,
  Moon,
  NotebookPen,
  PanelLeft,
  Plus,
  Sparkles,
  Sun,
  Users,
  X,
} from "lucide-react";
import type { CampaignSnapshot } from "../shared/types";
import {
  isCampaignHandoffAttempt,
  parseCampaignHandoff,
  type CampaignHandoffDraft,
  type SuiteLinks,
  type SuiteManifest,
} from "../shared/suite";
import { computeCampaignMetrics } from "../shared/sheets";
import { apiGet, apiWrite } from "./lib/api";
import SuiteSwitcher from "./components/SuiteSwitcher";
import ScheduleView from "./components/ScheduleView";
import { MeetingsView, NotesView, TasksView } from "./components/TasksNotesMeetingsView";
import FilesHandbookView from "./components/FilesHandbookView";
import FormsView from "./components/FormsView";
import PartnersView from "./components/PartnersView";
import InspirationsView from "./components/InspirationsView";
import BotView from "./components/BotView";

type RouteKey =
  | "schedule"
  | "tasks"
  | "partners"
  | "forms"
  | "inspirations"
  | "files"
  | "meetings"
  | "notes"
  | "bot"
  | "handoff";

const HANDOFF_STORAGE_KEY = "bell.suite.handoff.campaign";

function resolveRouteFromHash(hash: string): RouteKey {
  const path = hash.replace(/^#/, "").split("?")[0] || "/";
  if (path === "/tasks") return "tasks";
  if (path === "/partners") return "partners";
  if (path === "/forms") return "forms";
  if (path === "/inspirations") return "inspirations";
  if (path === "/files") return "files";
  if (path === "/meetings") return "meetings";
  if (path === "/notes") return "notes";
  if (path === "/bot") return "bot";
  if (path === "/handoff") return "handoff";
  return "schedule";
}

function getInitialTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem("bell.theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // ignore storage errors
  }
  return "light";
}

const ROUTE_TITLES: Record<RouteKey, { title: string; subtitle: string }> = {
  schedule: { title: "每週倒數時程總表", subtitle: "對齊 Google 試算表結構 · 連續階段橫條與撞期避開" },
  tasks: { title: "待辦事項與各組進度", subtitle: "追蹤各大組別專案進度與待辦完成率" },
  partners: { title: "合作名單與臨時工編制", subtitle: "分類管理特邀講者、合作廠商接洽與臨時工任務完成狀況" },
  forms: { title: "招工表單與人力雷達", subtitle: "視覺化審核志工回覆、試算表同步與各組缺口" },
  inspirations: { title: "靈感借鏡", subtitle: "從國內外相似活動剖析專案相似處、時程巧思與前人避坑指南" },
  files: { title: "文件歸檔與行前手冊生成", subtitle: "儲存社群圖片、廠商檔案並自動生成講者／籌備手冊" },
  meetings: { title: "會議記錄與雲端雙向共筆", subtitle: "支援 Google 文件與 HackMD 雙向匯入匯出、大綱與決議管理" },
  notes: { title: "個人筆記", subtitle: "記錄總召與個人的靈感、決策脈絡與備忘" },
  bot: { title: "Campaign Bot", subtitle: "開案專案定位對焦、對話式操作時程、手冊與名單" },
  handoff: { title: "跨工具草稿接收", subtitle: "確認後才會寫入 BELL Campaign 專案資料庫" },
};

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(getInitialTheme);
  const [route, setRoute] = useState<RouteKey>(() => resolveRouteFromHash(window.location.hash));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const [snapshot, setSnapshot] = useState<CampaignSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [suiteLinks, setSuiteLinks] = useState<SuiteLinks>({});
  const [manifestLoaded, setManifestLoaded] = useState(false);
  const [manifestError, setManifestError] = useState(false);

  const pendingHandoffHashRef = useRef<string | null>(
    isCampaignHandoffAttempt(window.location.hash) ? window.location.hash : null,
  );
  const [handoffDraft, setHandoffDraft] = useState<CampaignHandoffDraft | null>(() => {
    try {
      const raw = sessionStorage.getItem(HANDOFF_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as CampaignHandoffDraft) : null;
    } catch {
      return null;
    }
  });
  const [handoffRejected, setHandoffRejected] = useState<string | null>(null);
  const [handoffTitle, setHandoffTitle] = useState("");
  const [handoffBody, setHandoffBody] = useState("");
  const [handoffTeamId, setHandoffTeamId] = useState("");

  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  // Create campaign modal
  const [newCampOpen, setNewCampOpen] = useState(false);
  const [newCampName, setNewCampName] = useState("");
  const [newCampSub, setNewCampSub] = useState("");
  const [newCampBrief, setNewCampBrief] = useState("");
  const [newCampDate, setNewCampDate] = useState("2026-09-19");
  const [newCampPostWeeks, setNewCampPostWeeks] = useState(2);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3400);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("bell.theme", theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const loadManifest = useCallback(async () => {
    try {
      const m = await apiGet<SuiteManifest>("/api/suite/manifest");
      setSuiteLinks(m.links ?? {});
      setManifestError(false);
    } catch {
      setManifestError(true);
    } finally {
      setManifestLoaded(true);
    }
  }, []);

  const loadSnapshot = useCallback(async (campaignId?: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const query = campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : "";
      const snap = await apiGet<CampaignSnapshot>(`/api/snapshot${query}`);
      setSnapshot(snap);
      setHandoffTeamId((prev) => prev || snap.teams[0]?.id || "");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "無法載入活動專案資料");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadManifest();
    void loadSnapshot();
  }, [loadManifest, loadSnapshot]);

  useEffect(() => {
    const onHashChange = () => {
      const raw = window.location.hash;
      if (isCampaignHandoffAttempt(raw)) {
        pendingHandoffHashRef.current = raw;
      }
      setRoute(resolveRouteFromHash(raw));
      setMobileNavOpen(false);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Process incoming Suite handoff once suiteLinks are loaded (0 DB writes!)
  useEffect(() => {
    if (!manifestLoaded) return;
    const rawHash = pendingHandoffHashRef.current;
    if (!rawHash) return;
    pendingHandoffHashRef.current = null;
    const parsed = parseCampaignHandoff(rawHash, suiteLinks);
    window.history.replaceState(null, "", "#/handoff");
    setRoute("handoff");
    if (!parsed.present) return;
    if (parsed.rejected || !parsed.draft) {
      setHandoffRejected("無法驗證跨產品草稿來源或內容為空，因此未載入草稿。");
      setHandoffDraft(null);
      sessionStorage.removeItem(HANDOFF_STORAGE_KEY);
      return;
    }
    setHandoffRejected(null);
    setHandoffDraft(parsed.draft);
    setHandoffTitle(parsed.draft.title || parsed.draft.text.split("\n")[0].slice(0, 60));
    setHandoffBody(parsed.draft.text);
    try {
      sessionStorage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(parsed.draft));
    } catch {
      // ignore
    }
  }, [manifestLoaded, suiteLinks]);

  useEffect(() => {
    if (handoffDraft && !handoffBody) {
      setHandoffTitle(handoffDraft.title || handoffDraft.text.split("\n")[0].slice(0, 60));
      setHandoffBody(handoffDraft.text);
    }
  }, [handoffDraft, handoffBody]);

  function navigate(next: RouteKey) {
    const targetHash = next === "schedule" ? "#/schedule" : `#/${next}`;
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    } else {
      setRoute(next);
    }
    setMobileNavOpen(false);
  }

  function clearHandoff() {
    setHandoffDraft(null);
    setHandoffRejected(null);
    sessionStorage.removeItem(HANDOFF_STORAGE_KEY);
    navigate("schedule");
  }

  async function saveHandoffAsTodo() {
    if (!snapshot || !handoffTitle.trim()) return;
    const teamId = handoffTeamId || snapshot.teams[0]?.id;
    if (!teamId) return;
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/campaigns/${snapshot.campaign.id}/todos`,
        "POST",
        {
          teamId,
          title: handoffTitle.trim(),
          priority: "high",
        },
      );
      setSnapshot(next);
      sessionStorage.removeItem(HANDOFF_STORAGE_KEY);
      setHandoffDraft(null);
      notify("已將跨工具草稿加入籌備待辦");
      navigate("tasks");
    } catch (err) {
      notify(err instanceof Error ? err.message : "儲存失敗");
    }
  }

  async function saveHandoffAsNote() {
    if (!snapshot || !handoffTitle.trim()) return;
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/campaigns/${snapshot.campaign.id}/notes`,
        "POST",
        {
          title: handoffTitle.trim(),
          body: handoffBody,
          tags: ["Suite 傳入"],
          pinned: true,
        },
      );
      setSnapshot(next);
      sessionStorage.removeItem(HANDOFF_STORAGE_KEY);
      setHandoffDraft(null);
      notify("已將跨工具草稿存為個人筆記");
      navigate("notes");
    } catch (err) {
      notify(err instanceof Error ? err.message : "儲存失敗");
    }
  }

  async function createCampaignFlow(targetRoute: RouteKey) {
    if (!newCampName.trim()) return;
    try {
      const next = await apiWrite<CampaignSnapshot>("/api/campaigns", "POST", {
        name: newCampName.trim(),
        subtitle: newCampSub.trim() || undefined,
        brief: newCampBrief.trim() || undefined,
        eventDate: newCampDate,
        postWeeks: newCampPostWeeks,
      });
      setSnapshot(next);
      setNewCampOpen(false);
      setNewCampName("");
      setNewCampSub("");
      setNewCampBrief("");
      navigate(targetRoute);
      notify(
        targetRoute === "bot"
          ? `已建立「${next.campaign.name}」，先跟 Campaign Bot 聊聊活動性質與靈感規劃吧！`
          : `已建立新活動專案「${next.campaign.name}」`,
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : "建立專案失敗");
    }
  }

  async function handleCreateCampaign(e: React.FormEvent) {
    e.preventDefault();
    await createCampaignFlow("bot");
  }

  const counts = useMemo(() => {
    if (!snapshot) return { openTodos: 0, partners: 0, pendingForms: 0, files: 0, overallPercent: 0 };
    const metrics = computeCampaignMetrics(snapshot);
    return {
      openTodos: snapshot.todos.filter((t) => !t.done).length,
      partners: snapshot.partners.length,
      pendingForms: snapshot.formResponses.filter((r) => r.status === "pending" || r.status === "interview").length,
      files: snapshot.files.length,
      overallPercent: metrics.overallPercent,
    };
  }, [snapshot]);

  const navItems: Array<{
    key: RouteKey;
    label: string;
    icon: typeof CalendarRange;
    badge?: number;
    alert?: boolean;
  }> = [
    { key: "schedule", label: "時程總表", icon: CalendarRange },
    { key: "tasks", label: "待辦與進度", icon: CheckSquare, badge: counts.openTodos },
    { key: "partners", label: "合作名單", icon: Briefcase, badge: counts.partners },
    { key: "forms", label: "招工表單", icon: ClipboardList, badge: counts.pendingForms, alert: counts.pendingForms > 0 },
    { key: "inspirations", label: "靈感借鏡", icon: Lightbulb },
    { key: "files", label: "文件與手冊", icon: FolderArchive, badge: counts.files },
    { key: "meetings", label: "會議記錄", icon: Users },
    { key: "notes", label: "個人筆記", icon: NotebookPen },
    { key: "bot", label: "Campaign Bot", icon: Bot },
  ];

  const headerMeta = ROUTE_TITLES[route];

  return (
    <div
      className={[
        "app-shell",
        sidebarCollapsed ? "is-collapsed" : "",
        mobileNavOpen ? "is-mobile-open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="sidebar-backdrop" onClick={() => setMobileNavOpen(false)} aria-hidden="true" />

      {/* ── Left Navigation Sidebar ──────────────────────────────────────── */}
      <aside className="app-sidebar" aria-label="BELL Campaign 主導覽列">
        <div className="sidebar-head">
          <button
            type="button"
            className="suite-brand-btn"
            onClick={() => setSwitcherOpen(true)}
            title="切換 BELL Suite 產品（⌘K）"
          >
            <span className="brand-tile" aria-hidden="true">
              <CalendarRange size={14} />
            </span>
            <span className="brand-wordmark">BELL Campaign</span>
            <ChevronsUpDown size={13} style={{ marginLeft: "auto", color: "var(--text-3)", flexShrink: 0 }} />
          </button>
        </div>

        <div className="sidebar-scroll">
          {snapshot && (
            <div className="campaign-picker-box">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11.5, color: "var(--text-3)" }}>
                <span>活動專案</span>
                <span className="tabular" style={{ color: "var(--campaign-text)", fontWeight: 600 }}>
                  進度 {counts.overallPercent}%
                </span>
              </div>
              <select
                aria-label="切換活動專案"
                className="campaign-select"
                value={snapshot.campaign.id}
                onChange={(e) => void loadSnapshot(e.target.value)}
              >
                {snapshot.campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11.5, color: "var(--text-3)" }}>
                <span className="tabular">活動日 {snapshot.campaign.eventDate}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ height: 22, padding: "0 6px", fontSize: 11.5 }}
                  onClick={() => setNewCampOpen(true)}
                >
                  <Plus size={12} />
                  <span>新增</span>
                </button>
              </div>
            </div>
          )}

          <nav className="sidebar-nav" aria-label="功能分頁">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = route === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`nav-item ${active ? "is-active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => navigate(item.key)}
                >
                  <Icon size={16} className="nav-icon" aria-hidden="true" />
                  <span>{item.label}</span>
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className={`nav-badge ${item.alert ? "is-alert" : ""}`}>{item.badge}</span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="sidebar-footer">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setSwitcherOpen(true)}
            style={{ padding: "0 8px" }}
          >
            <span>切換工具</span>
            <kbd className="p-kbd">⌘K</kbd>
          </button>

          <button
            type="button"
            className="icon-btn"
            aria-label={theme === "dark" ? "切換為淺色模式" : "切換為深色模式"}
            title={theme === "dark" ? "切換為淺色模式" : "切換為深色模式"}
            onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </aside>

      {/* ── Main Content Stage ───────────────────────────────────────────── */}
      <div className="app-main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="icon-btn"
              aria-label="開啟選單"
              onClick={() => {
                if (window.innerWidth <= 900) {
                  setMobileNavOpen((v) => !v);
                } else {
                  setSidebarCollapsed((v) => !v);
                }
              }}
            >
              {window.innerWidth <= 900 ? <Menu size={15} /> : <PanelLeft size={15} />}
            </button>
            <div style={{ minWidth: 0 }}>
              <div className="topbar-title">{headerMeta.title}</div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-3)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {snapshot ? `${snapshot.campaign.name} · ${headerMeta.subtitle}` : headerMeta.subtitle}
              </div>
            </div>
          </div>

          <div className="topbar-actions">
            {route !== "bot" && (
              <button type="button" className="btn btn-sm" onClick={() => navigate("bot")}>
                <Sparkles size={13} style={{ color: "var(--campaign-text)" }} />
                <span>請 Bot 協助操作</span>
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              aria-label={theme === "dark" ? "切換為淺色模式" : "切換為深色模式"}
              onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>
        </header>

        <main className="page-body">
          {loading && !snapshot ? (
            <div className="card" style={{ padding: 32, textAlign: "center", color: "var(--text-3)" }}>
              正在載入活動專案時程…
            </div>
          ) : loadError || !snapshot ? (
            <div className="card" style={{ padding: 32, textAlign: "center" }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "var(--danger)" }}>
                {loadError || "無法載入資料"}
              </div>
              <button
                type="button"
                className="btn btn-primary"
                style={{ marginTop: 12 }}
                onClick={() => void loadSnapshot()}
              >
                重新載入
              </button>
            </div>
          ) : route === "handoff" ? (
            <section className="card" style={{ padding: 22, maxWidth: 720, display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span className="pill pill-campaign">BELL Suite 跨工具草稿接收</span>
                {handoffDraft?.backUrl && (
                  <a href={handoffDraft.backUrl} className="btn btn-sm">
                    <ArrowLeft size={13} />
                    <span>返回來源工具</span>
                  </a>
                )}
              </div>

              {handoffRejected || !handoffDraft ? (
                <div style={{ color: "var(--text-2)", fontSize: 14 }}>
                  <p style={{ margin: "0 0 12px" }}>{handoffRejected ?? "目前沒有待處理的跨工具傳入草稿。"}</p>
                  <button type="button" className="btn" onClick={() => navigate("schedule")}>
                    回到時程總表
                  </button>
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 13, color: "var(--text-3)" }}>
                    來自 <strong>BELL {handoffDraft.from.toUpperCase()}</strong>
                    {handoffDraft.truncated ? "（內容超過上限已自動截斷）" : ""} · 在你點擊下方按鈕確認前不會寫入資料庫。
                  </div>

                  <div>
                    <label className="field-label">標題</label>
                    <input
                      className="input"
                      value={handoffTitle}
                      onChange={(e) => setHandoffTitle(e.target.value)}
                    />
                  </div>

                  <div>
                    <label className="field-label">內容</label>
                    <textarea
                      rows={5}
                      className="textarea"
                      value={handoffBody}
                      onChange={(e) => setHandoffBody(e.target.value)}
                    />
                  </div>

                  <div>
                    <label className="field-label">若轉為待辦，指派給組別</label>
                    <select
                      className="select"
                      value={handoffTeamId}
                      onChange={(e) => setHandoffTeamId(e.target.value)}
                    >
                      {snapshot.teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" className="btn" onClick={clearHandoff}>
                      捨棄草稿
                    </button>
                    <button type="button" className="btn" onClick={() => void saveHandoffAsNote()}>
                      存為個人筆記
                    </button>
                    <button type="button" className="btn btn-primary" onClick={() => void saveHandoffAsTodo()}>
                      加入籌備待辦
                    </button>
                  </div>
                </>
              )}
            </section>
          ) : route === "tasks" ? (
            <TasksView
              snapshot={snapshot}
              suiteLinks={suiteLinks}
              onSnapshot={setSnapshot}
              notify={notify}
            />
          ) : route === "partners" ? (
            <PartnersView
              snapshot={snapshot}
              onSnapshot={setSnapshot}
              onNavigateFiles={() => navigate("files")}
              notify={notify}
            />
          ) : route === "forms" ? (
            <FormsView
              snapshot={snapshot}
              suiteLinks={suiteLinks}
              onSnapshot={setSnapshot}
              notify={notify}
            />
          ) : route === "inspirations" ? (
            <InspirationsView
              snapshot={snapshot}
              onSnapshot={setSnapshot}
              onNavigateBot={() => navigate("bot")}
              notify={notify}
            />
          ) : route === "files" ? (
            <FilesHandbookView
              snapshot={snapshot}
              onSnapshot={setSnapshot}
              notify={notify}
            />
          ) : route === "meetings" ? (
            <MeetingsView
              snapshot={snapshot}
              onSnapshot={setSnapshot}
              notify={notify}
            />
          ) : route === "notes" ? (
            <NotesView
              snapshot={snapshot}
              suiteLinks={suiteLinks}
              onSnapshot={setSnapshot}
              notify={notify}
            />
          ) : route === "bot" ? (
            <BotView snapshot={snapshot} onSnapshot={setSnapshot} notify={notify} />
          ) : (
            <ScheduleView snapshot={snapshot} onSnapshot={setSnapshot} notify={notify} />
          )}
        </main>
      </div>

      {/* ── Suite Switcher (`⌘K` & `⌃1–5`) ───────────────────────────────── */}
      <SuiteSwitcher
        links={suiteLinks}
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        manifestError={manifestError}
        onRetry={() => void loadManifest()}
      />

      {/* ── Create New Campaign Dialog ───────────────────────────────────── */}
      <Dialog.Root open={newCampOpen} onOpenChange={setNewCampOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <form onSubmit={handleCreateCampaign} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Dialog.Title style={{ margin: 0, fontSize: 16.5, fontWeight: 700 }}>建立新活動專案</Dialog.Title>
                <Dialog.Close asChild>
                  <button type="button" className="icon-btn" aria-label="關閉">
                    <X size={15} />
                  </button>
                </Dialog.Close>
              </div>
              <Dialog.Description style={{ margin: 0, fontSize: 13, color: "var(--text-3)" }}>
                開案後可先與 Campaign Bot 聊聊活動形式與規模，由它協助規劃專案性質、每週時程與國內外「靈感借鏡」案例。
              </Dialog.Description>

              <div>
                <label className="field-label">活動專案名稱 *</label>
                <input
                  required
                  className="input"
                  placeholder="例如：2026 秋季開發者工作坊"
                  value={newCampName}
                  onChange={(e) => setNewCampName(e.target.value)}
                />
              </div>

              <div>
                <label className="field-label">副標題／核心形式</label>
                <input
                  className="input"
                  placeholder="例如：主題演講 · 實作體驗 · 招工協作"
                  value={newCampSub}
                  onChange={(e) => setNewCampSub(e.target.value)}
                />
              </div>

              <div>
                <label className="field-label">專案初步想做什麼（選填，建立後也可跟 Bot 聊）</label>
                <textarea
                  rows={2}
                  className="textarea"
                  placeholder="例如：預計 120 人參與的產品設計與前端交流活動，包含講者與談、攤位體驗與會後復盤…"
                  value={newCampBrief}
                  onChange={(e) => setNewCampBrief(e.target.value)}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label className="field-label">正式活動日期 *</label>
                  <input
                    required
                    type="date"
                    className="input"
                    value={newCampDate}
                    onChange={(e) => setNewCampDate(e.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label">活動後延伸復盤週數</label>
                  <select
                    className="select"
                    value={newCampPostWeeks}
                    onChange={(e) => setNewCampPostWeeks(Number(e.target.value))}
                  >
                    <option value={1}>活動後 1 週</option>
                    <option value={2}>活動後 2 週（推薦）</option>
                  </select>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                <button type="button" className="btn" onClick={() => setNewCampOpen(false)}>
                  取消
                </button>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={!newCampName.trim()}
                    onClick={() => void createCampaignFlow("schedule")}
                  >
                    直接進入時程表
                  </button>
                  <button type="submit" className="btn btn-primary">
                    <Bot size={14} />
                    <span>建立並與 Bot 聊聊規劃性質</span>
                  </button>
                </div>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── Toast Notification ───────────────────────────────────────────── */}
      {toast && (
        <div className="toast-banner" role="status" aria-live="polite">
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}
