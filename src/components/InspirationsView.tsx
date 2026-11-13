import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Clock,
  Compass,
  Globe2,
  Lightbulb,
  NotebookPen,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import type { CampaignInspiration, CampaignSnapshot } from "../../shared/types";
import { apiWrite } from "../lib/api";

export default function InspirationsView({
  snapshot,
  onSnapshot,
  onNavigateBot,
  notify,
}: {
  snapshot: CampaignSnapshot;
  onSnapshot: (next: CampaignSnapshot) => void;
  onNavigateBot: () => void;
  notify: (msg: string) => void;
}) {
  const [regionFilter, setRegionFilter] = useState<"all" | "國內" | "國際">("all");
  const [briefDraft, setBriefDraft] = useState(
    snapshot.campaign.brief || snapshot.campaign.mainGoal || snapshot.campaign.subtitle,
  );
  const [focusHint, setFocusHint] = useState("");
  const [curating, setCurating] = useState(false);
  const [editingBrief, setEditingBrief] = useState(false);

  useEffect(() => {
    setBriefDraft(snapshot.campaign.brief || snapshot.campaign.mainGoal || snapshot.campaign.subtitle);
  }, [snapshot.campaign.id, snapshot.campaign.brief, snapshot.campaign.mainGoal, snapshot.campaign.subtitle]);

  const counts = useMemo(() => {
    return {
      all: snapshot.inspirations.length,
      domestic: snapshot.inspirations.filter((i) => i.region === "國內").length,
      global: snapshot.inspirations.filter((i) => i.region === "國際").length,
    };
  }, [snapshot.inspirations]);

  const filtered = useMemo(() => {
    if (regionFilter === "all") return snapshot.inspirations;
    return snapshot.inspirations.filter((i) => i.region === regionFilter);
  }, [snapshot.inspirations, regionFilter]);

  async function handleRecurate(e?: React.FormEvent) {
    e?.preventDefault();
    setCurating(true);
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/campaigns/${snapshot.campaign.id}/inspirations/curate`,
        "POST",
        {
          brief: briefDraft.trim(),
          focusHint: focusHint.trim() || undefined,
        },
      );
      onSnapshot(next);
      setEditingBrief(false);
      notify("已依專案性質重新分析國內外相似活動與避坑指南");
    } catch (err) {
      notify(err instanceof Error ? err.message : "策展靈感失敗");
    } finally {
      setCurating(false);
    }
  }

  async function saveIdeaToNote(item: CampaignInspiration, idea: string) {
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/campaigns/${snapshot.campaign.id}/notes`,
        "POST",
        {
          title: `借鏡 ${item.title}：${idea.slice(0, 26)}…`,
          body: `參考活動：${item.title}（${item.region} · ${item.category}）\n相似分析：${item.whySimilar}\n\n可落地的活動亮點：\n${idea}\n\n時程參考：\n${item.timelinePattern}`,
          tags: ["靈感借鏡", item.region],
          pinned: true,
        },
      );
      onSnapshot(next);
      notify("已將活動點子收入個人筆記");
    } catch (err) {
      notify(err instanceof Error ? err.message : "儲存筆記失敗");
    }
  }

  async function addPitfallGuardTodo(pitfall: string) {
    const targetTeam =
      snapshot.teams.find((t) => /場務|志工|機動|總召/.test(t.name)) ?? snapshot.teams[0];
    if (!targetTeam) return;
    const cleanTitle = `【避坑防呆】${pitfall.split(/[—–，。]/)[0]?.slice(0, 68) || pitfall.slice(0, 68)}`;
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/campaigns/${snapshot.campaign.id}/todos`,
        "POST",
        {
          teamId: targetTeam.id,
          title: cleanTitle,
          priority: "high",
        },
      );
      onSnapshot(next);
      notify(`已加入「${targetTeam.name}」高優先防呆待辦`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "加入待辦失敗");
    }
  }

  const activePositioning =
    snapshot.campaign.brief || snapshot.campaign.mainGoal || snapshot.campaign.subtitle || "尚未填寫專案性質說明";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* ── Project DNA & Campaign Bot Onboarding Banner ─────────────────── */}
      <section className="card" style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 360px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="pill pill-campaign">
                <Compass size={12} />
                <span>目前專案性質定位</span>
              </span>
              {snapshot.teams.map((t) => (
                <span key={t.id} className="pill" style={{ height: 21, fontSize: 11.5 }}>
                  <span className={`team-dot team-dot-${t.color}`} />
                  <span>{t.name}</span>
                </span>
              ))}
            </div>
            <div style={{ fontSize: 14.5, lineHeight: 1.6, color: "var(--text)" }}>
              {activePositioning}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn" onClick={() => setEditingBrief((v) => !v)}>
              <Sparkles size={14} style={{ color: "var(--campaign-text)" }} />
              <span>{editingBrief ? "收合定位調整" : "調整定位／重新策展"}</span>
            </button>
            <button type="button" className="btn btn-primary" onClick={onNavigateBot}>
              <Bot size={14} />
              <span>與 Campaign Bot 聊聊專案性質</span>
            </button>
          </div>
        </div>

        {editingBrief && (
          <form
            onSubmit={handleRecurate}
            style={{
              paddingTop: 12,
              borderTop: "1px solid var(--line)",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div>
              <label className="field-label">專案主要想做什麼（形式、預估人數、受眾與核心體驗）</label>
              <textarea
                rows={2}
                className="textarea"
                value={briefDraft}
                onChange={(e) => setBriefDraft(e.target.value)}
                placeholder="例如：預計 150 人的跨領域設計與開發年會，上午 Panel 與談、下午世界咖啡館圓桌交流…"
              />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                className="input"
                style={{ flex: "1 1 260px" }}
                value={focusHint}
                onChange={(e) => setFocusHint(e.target.value)}
                placeholder="選填特別想參考的方向（例如：市集電力動線、講者接待、學生志工交接…）"
              />
              <button type="submit" className="btn btn-primary" disabled={curating}>
                <RefreshCw size={13} />
                <span>{curating ? "分析相似活動中…" : "重新策展靈感與避坑指南"}</span>
              </button>
            </div>
          </form>
        )}
      </section>

      {/* ── Region Filter Strip ──────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div className="partner-tabs" role="tablist" aria-label="活動案例地區篩選">
          <button
            type="button"
            role="tab"
            aria-selected={regionFilter === "all"}
            className={`partner-tab-btn ${regionFilter === "all" ? "is-active" : ""}`}
            onClick={() => setRegionFilter("all")}
          >
            <span>全部參照活動</span>
            <span className="tabular" style={{ opacity: 0.75 }}>({counts.all})</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={regionFilter === "國內"}
            className={`partner-tab-btn ${regionFilter === "國內" ? "is-active" : ""}`}
            onClick={() => setRegionFilter("國內")}
          >
            <span>國內標竿活動</span>
            <span className="tabular" style={{ opacity: 0.75 }}>({counts.domestic})</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={regionFilter === "國際"}
            className={`partner-tab-btn ${regionFilter === "國際" ? "is-active" : ""}`}
            onClick={() => setRegionFilter("國際")}
          >
            <Globe2 size={13} />
            <span>國際代表案例</span>
            <span className="tabular" style={{ opacity: 0.75 }}>({counts.global})</span>
          </button>
        </div>

        <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>
          看到適合的企劃點子可一鍵存為筆記，看到踩坑警示可直接轉為團隊防呆待辦
        </span>
      </div>

      {/* ── Comparable Event Case Study Cards ────────────────────────────── */}
      <section className="inspiration-grid" aria-label="相似活動靈感借鏡卡片">
        {filtered.map((item) => (
          <article key={item.id} className="inspiration-card">
            {/* Header */}
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                  <span className="pill">{item.region}</span>
                  <span className="pill">{item.category}</span>
                </div>
                <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, letterSpacing: "-0.015em" }}>
                  {item.title}
                </h3>
              </div>
              <span className="pill pill-campaign tabular">相似度 {item.similarityScore}%</span>
            </div>

            {/* Similarity Analysis */}
            <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--text-2)" }}>
              <strong style={{ color: "var(--text)" }}>與本專案相似處：</strong>
              {item.whySimilar}
            </div>

            {/* Timeline Scheduling Pattern */}
            <div
              style={{
                padding: "10px 12px",
                borderRadius: "var(--radius-sm)",
                background: "var(--panel)",
                border: "1px solid var(--line)",
                fontSize: 13,
                lineHeight: 1.55,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: "var(--campaign-text)", marginBottom: 3 }}>
                <Clock size={13} />
                <span>時程安排巧思</span>
              </div>
              <div style={{ color: "var(--text-2)" }}>{item.timelinePattern}</div>
            </div>

            {/* Special Event Ideas */}
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
                <Lightbulb size={14} style={{ color: "var(--campaign-text)" }} />
                <span>可借鏡的特別活動與體驗點子</span>
              </div>
              {item.specialIdeas.map((idea, idx) => (
                <div key={idx} className="idea-row">
                  <span style={{ flex: 1, color: "var(--text-2)" }}>{idea}</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ flexShrink: 0, height: 26, fontSize: 12 }}
                    onClick={() => void saveIdeaToNote(item, idea)}
                    title="將此企劃點子存入個人筆記"
                  >
                    <NotebookPen size={11} />
                    <span>存筆記</span>
                  </button>
                </div>
              ))}
            </div>

            {/* Pitfalls & Lessons Learned */}
            <div className="pitfall-box">
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, color: "var(--warn)" }}>
                <ShieldAlert size={14} />
                <span>前人踩過的坑 · 必避風險借鏡</span>
              </div>
              {item.pitfalls.map((pitfall, idx) => (
                <div
                  key={idx}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 10,
                    fontSize: 13,
                    lineHeight: 1.5,
                    color: "var(--text)",
                  }}
                >
                  <span style={{ display: "flex", alignItems: "flex-start", gap: 6, flex: 1 }}>
                    <AlertTriangle size={13} style={{ color: "var(--warn)", marginTop: 3, flexShrink: 0 }} />
                    <span>{pitfall}</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ flexShrink: 0, height: 26, fontSize: 12 }}
                    onClick={() => void addPitfallGuardTodo(pitfall)}
                    title="將此避坑檢查點直接加入組別高優先待辦"
                  >
                    <Plus size={11} />
                    <span>防呆待辦</span>
                  </button>
                </div>
              ))}
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
