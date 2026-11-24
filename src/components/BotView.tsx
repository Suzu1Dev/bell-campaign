import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bot,
  Check,
  Compass,
  Cpu,
  Send,
  Sparkles,
  Zap,
} from "lucide-react";
import {
  AI_PROVIDERS,
  DEFAULT_PONYTAIL_MODE,
  DEFAULT_THINKING_EFFORT,
  PACING_META,
  THINKING_EFFORTS,
  type AiProvider,
  type CampaignSnapshot,
  type PonytailMode,
  type ProviderSettings,
  type ThinkingEffort,
} from "../../shared/types";
import { computeCampaignMetrics } from "../../shared/sheets";
import { apiWrite } from "../lib/api";
import {
  PROVIDER_MODEL_PRESETS,
  resolveModelOnProviderSwitch,
  stripEffortSuffix,
} from "../lib/uiPrefs";

const PROVIDER_LABELS: Record<AiProvider, string> = {
  builtin: "內建規則引擎（免金鑰・即時回應）",
  codex: "Codex CLI",
  claude: "Claude CLI",
  antigravity: "Antigravity CLI",
  api: "OpenAI 相容 API",
};

const PROVIDER_SHORT: Record<AiProvider, string> = {
  builtin: "內建引擎",
  codex: "Codex CLI",
  claude: "Claude CLI",
  antigravity: "Antigravity CLI",
  api: "外部 API",
};

const DEPTH_META: Record<
  ThinkingEffort,
  {
    level: number;
    shortLabel: string;
    enLabel: string;
    title: string;
    speedTag: string;
    sceneTag: string;
    desc: string;
  }
> = {
  low: {
    level: 1,
    shortLabel: "速答",
    enLabel: "Low",
    title: "速答直覺 · 秒級執行",
    speedTag: "最快 · 最省額度",
    sceneTag: "單一指令",
    desc: "省略多層推演，適合新增單筆待辦、勾選完成、快速記筆記等明確操作。",
  },
  medium: {
    level: 2,
    shortLabel: "均衡",
    enLabel: "Med",
    title: "均衡推演 · 日常協作預設",
    speedTag: "快 · 平衡",
    sceneTag: "拆組／改時程",
    desc: "先核對目前組別與週次再執行，兼顧回應速度與邏輯完整度，適合大多數籌備對話。",
  },
  high: {
    level: 3,
    shortLabel: "深入",
    enLabel: "High",
    title: "深入推演 · 跨組相依檢查",
    speedTag: "中速 · 深入",
    sceneTag: "跨組重組",
    desc: "主動比對跨組交接、撞期週次與人力缺口，適合拆分組別、批次移轉待辦與調緊湊度。",
  },
  xhigh: {
    level: 4,
    shortLabel: "縝密",
    enLabel: "XHigh",
    title: "縝密全盤 · 依賴鏈與瓶頸盤點",
    speedTag: "較慢 · 高推理",
    sceneTag: "長程規劃",
    desc: "逐週檢驗前後置依賴與驗收緩衝，適合多月份倒數排程與大型活動分工健檢。",
  },
  max: {
    level: 5,
    shortLabel: "極限",
    enLabel: "Max",
    title: "極限推演 · 全專案深度決策",
    speedTag: "最深 · 耗時較長",
    sceneTag: "賽制／全盤重排",
    desc: "投入最高推理深度審視賽制、多校資源衝突與風險邊界，一次產出完整連動變更。",
  },
};

const PONYTAIL_SELECT_ORDER: readonly PonytailMode[] = ["ultra", "full", "lite", "off"];

const PONYTAIL_SHORT: Record<PonytailMode, string> = {
  ultra: "Ultra",
  full: "Full",
  lite: "Lite",
  off: "Off",
};

const PONYTAIL_BADGES: Record<PonytailMode, string> = {
  ultra: "Ponytail · Ultra",
  full: "Ponytail · Full",
  lite: "Ponytail · Lite",
  off: "Ponytail · Off",
};

const PONYTAIL_HINTS: Record<PonytailMode, string> = {
  ultra: "預設啟用：主動點破過密排程與冗餘分工，砍除客套鋪陳並附精簡取捨提醒。",
  full: "以最少必要行動解決問題，回覆精簡口語專業並附略過項與風險備註。",
  lite: "保留完整建議，省去客套開場與冗長背景鋪陳。",
  off: "不套用精簡限制，保留完整展開說明與指令範例。",
};

const QUICK_PROMPTS = [
  {
    label: "獨立／拆分組別並移轉待辦",
    prompt: "幫我檢視目前有沒有複合組別可以拆開獨立運作，或直接幫我新增組別並把相關待辦移轉過去。",
  },
  {
    label: "對焦專案性質與靈感借鏡",
    prompt: "我們這次專案預計舉辦跨校新手資安競賽，請幫我精煉專案定位並更新靈感借鏡案例。",
  },
  {
    label: "從本週展開跨月長程倒數週數",
    prompt: "幫我把會前籌備時程從今天起算展開完整跨月倒數週數，若日期尚未定案先標記日期待定。",
  },
  {
    label: "微調時程緊湊度",
    prompt: "幫我把整體排程調整成穩健緩衝節奏，避開撞期大活動並保留兩週驗收緩衝。",
  },
  {
    label: "生成講者／工作人員手冊",
    prompt: "請幫我自動生成一份給籌備幹部與志工的行前懶人包手冊並歸檔。",
  },
  {
    label: "擬定下次週會大綱",
    prompt: "請幫我建立下次籌備週會的會前大綱、議程安排與注意事項。",
  },
] as const;

function renderFormattedText(content: string) {
  const parts = content.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={idx}>{part}</Fragment>;
  });
}

export default function BotView({
  snapshot,
  onSnapshot,
  onNavigateForms,
  notify,
}: {
  snapshot: CampaignSnapshot;
  onSnapshot: (next: CampaignSnapshot) => void;
  onNavigateForms?: () => void;
  notify: (msg: string) => void;
}) {
  const metrics = useMemo(() => computeCampaignMetrics(snapshot), [snapshot]);
  const pacingLabel =
    PACING_META.find((p) => p.id === snapshot.campaign.pacing)?.label ?? "均衡適中";
  const pendingFormCount = useMemo(
    () => snapshot.formResponses.filter((r) => r.status === "pending" || r.status === "interview").length,
    [snapshot.formResponses],
  );

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState(snapshot.settings.model);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setModelDraft(snapshot.settings.model);
  }, [snapshot.settings.model]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [snapshot.botMessages.length]);

  async function sendPrompt(rawText: string) {
    const text = rawText.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/campaigns/${snapshot.campaign.id}/bot/chat`,
        "POST",
        { message: text },
      );
      onSnapshot(next);
    } catch (err) {
      setInput(text);
      notify(err instanceof Error ? err.message : "Campaign Bot 回覆失敗");
    } finally {
      setSending(false);
    }
  }

  async function applyProposal(messageId: string, proposalId: string) {
    if (applyingId) return;
    setApplyingId(proposalId);
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/campaigns/${snapshot.campaign.id}/bot/apply`,
        "POST",
        { messageId, proposalId },
      );
      onSnapshot(next);
      notify("已套用 Campaign Bot 操作至專案");
    } catch (err) {
      notify(err instanceof Error ? err.message : "套用操作失敗");
    } finally {
      setApplyingId(null);
    }
  }

  async function updateProvider(patch: Partial<ProviderSettings>) {
    try {
      const nextSettings = await apiWrite<ProviderSettings>("/api/settings", "PATCH", patch);
      onSnapshot({ ...snapshot, settings: nextSettings });
      notify("已更新 AI 助理引擎設定");
    } catch (err) {
      notify(err instanceof Error ? err.message : "儲存設定失敗");
    }
  }

  return (
    <div className="bot-layout">
      {/* ── Main Conversational Console ──────────────────────────────────── */}
      <section className="bot-chat-card" aria-label="Campaign Bot 對話操作台">
        <header
          style={{
            padding: "12px 18px",
            borderBottom: "1px solid var(--line)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="brand-tile" style={{ width: 28, height: 28 }}>
              <Bot size={16} />
            </span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Campaign Bot · 專案全控助理</div>
              <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                聽完需求即主動完成拆組／建組、移轉待辦、調排程節奏、生成手冊、建會議與管理合作名單
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {(() => {
              const mode = snapshot.settings.ponytailMode ?? DEFAULT_PONYTAIL_MODE;
              const effort = snapshot.settings.thinkingEffort ?? DEFAULT_THINKING_EFFORT;
              const autoExec = snapshot.settings.botAutoApply !== false;
              return (
                <>
                  {autoExec && (
                    <span className="pill pill-ok" title="聽完需求後自動執行非刪除類變更">
                      <Check size={11} />
                      <span>主動執行中</span>
                    </span>
                  )}
                  <span className="pill" title={DEPTH_META[effort].title}>
                    <span>思考 · {DEPTH_META[effort].shortLabel}</span>
                  </span>
                  <span className={mode === "off" ? "pill" : "pill pill-campaign"}>
                    <Zap size={11} />
                    <span>{PONYTAIL_BADGES[mode]}</span>
                  </span>
                  <span className="pill">{PROVIDER_SHORT[snapshot.settings.provider]}</span>
                </>
              );
            })()}
          </div>
        </header>

        <div ref={scrollRef} className="bot-messages">
          {snapshot.botMessages.map((msg) => (
            <div
              key={msg.id}
              className={`bot-bubble ${msg.role === "user" ? "is-user" : "is-assistant"}`}
            >
              <div>{renderFormattedText(msg.content)}</div>

              {msg.proposals.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                  {msg.proposals.map((prop) => {
                    const busy = applyingId === prop.id;
                    return (
                      <div key={prop.id} className={`proposal-card ${prop.applied ? "is-applied" : ""}`}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                            {prop.summary}
                          </div>
                          {prop.detail && (
                            <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>
                              {prop.detail}
                            </div>
                          )}
                        </div>
                        {prop.applied ? (
                          <span className="pill pill-ok">
                            <Check size={12} />
                            <span>已完成</span>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={busy}
                            onClick={() => void applyProposal(msg.id, prop.id)}
                          >
                            <Zap size={12} />
                            <span>{busy ? "執行中…" : "確認執行"}</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}

          {sending && (
            <div className="bot-bubble is-assistant" style={{ color: "var(--text-3)" }}>
              正在檢視專案時程與各組進度…
            </div>
          )}
        </div>

        <form
          className="bot-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void sendPrompt(input);
          }}
        >
          <textarea
            rows={2}
            className="textarea"
            placeholder="輸入指令給 Campaign Bot（Enter 送出，Shift+Enter 換行）…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void sendPrompt(input);
              }
            }}
          />
          <button
            type="submit"
            className="btn btn-primary"
            style={{ height: 42, padding: "0 16px" }}
            disabled={sending || !input.trim()}
          >
            <Send size={14} />
            <span>送出</span>
          </button>
        </form>
      </section>

      {/* ── Right Control Rail: Live Pulse, Quick Prompts & Engine ───────── */}
      <aside style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700 }}>
            <Compass size={15} style={{ color: "var(--campaign-text)" }} />
            <span>即時專案脈搏</span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
            }}
          >
            <div
              style={{
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                background: "var(--panel)",
                border: "1px solid var(--line)",
              }}
            >
              <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>整體進度</div>
              <div className="tabular" style={{ fontSize: 17, fontWeight: 700 }}>
                {metrics.overallPercent}%
              </div>
            </div>
            <div
              style={{
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                background: "var(--panel)",
                border: "1px solid var(--line)",
              }}
            >
              <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>排程節奏</div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--campaign-text)", marginTop: 2 }}>
                {pacingLabel}
              </div>
            </div>
            <div
              style={{
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                background: "var(--panel)",
                border: "1px solid var(--line)",
              }}
            >
              <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>撞期警示週</div>
              <div className="tabular" style={{ fontSize: 16, fontWeight: 700 }}>
                {metrics.conflictWeekCount} 週
              </div>
            </div>
            <button
              type="button"
              className={`bot-pulse-btn ${pendingFormCount > 0 ? "is-attention" : ""}`}
              onClick={() => (onNavigateForms ? onNavigateForms() : (window.location.hash = "#/forms"))}
              title="前往招工表單審核報名名單"
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11.5, color: "var(--text-3)" }}>
                <span>待審招工</span>
                <ArrowUpRight size={12} style={{ color: pendingFormCount > 0 ? "var(--campaign-text)" : "var(--text-3)" }} />
              </div>
              <div className="tabular" style={{ fontSize: 16, fontWeight: 700, color: pendingFormCount > 0 ? "var(--campaign-text)" : "var(--text)" }}>
                {pendingFormCount} 筆
              </div>
            </button>
          </div>
        </div>

        <div className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700 }}>
            <Sparkles size={15} style={{ color: "var(--campaign-text)" }} />
            <span>常用一鍵操作指令</span>
          </div>
          {QUICK_PROMPTS.map((item) => (
            <button
              key={item.label}
              type="button"
              className="btn"
              style={{
                height: "auto",
                padding: "8px 10px",
                justifyContent: "flex-start",
                textAlign: "left",
                whiteSpace: "normal",
                lineHeight: 1.4,
              }}
              disabled={sending}
              onClick={() => void sendPrompt(item.prompt)}
            >
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        <div className="card ai-studio-card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13.5, fontWeight: 700 }}>
              <Cpu size={15} style={{ color: "var(--campaign-text)" }} />
              <span>AI 決策與思考設定</span>
            </div>
            <span className="ai-section-meta">
              {PROVIDER_SHORT[snapshot.settings.provider]}
            </span>
          </div>

          {/* 1. Proactive Task Auto-Execution Switch */}
          {(() => {
            const autoExec = snapshot.settings.botAutoApply !== false;
            return (
              <button
                type="button"
                role="switch"
                aria-checked={autoExec}
                className={`auto-exec-toggle ${autoExec ? "is-on" : ""}`}
                onClick={() => void updateProvider({ botAutoApply: !autoExec })}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>
                    聽完需求主動完成任務
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.42, marginTop: 2 }}>
                    {autoExec
                      ? "開啟中：拆組、建組、移轉待辦與調時程直接生效（刪除仍需確認）"
                      : "僅提出建議卡片，需逐張手動點擊執行才會變更專案"}
                  </div>
                </div>
                <span className={`switch-track ${autoExec ? "is-on" : ""}`}>
                  <span className="switch-thumb" />
                </span>
              </button>
            );
          })()}

          {/* 2. Tactile 5-Level Thinking Depth Dial */}
          {(() => {
            const activeEffort = snapshot.settings.thinkingEffort ?? DEFAULT_THINKING_EFFORT;
            const meta = DEPTH_META[activeEffort];
            return (
              <div className="ai-studio-section">
                <div className="ai-section-head">
                  <span className="ai-section-title">模型思考深度</span>
                  <span className="ai-section-meta">
                    {meta.enLabel.toUpperCase()} · {meta.level}/5
                  </span>
                </div>
                <div className="depth-dial" role="radiogroup" aria-label="模型思考深度">
                  {THINKING_EFFORTS.map((eff) => {
                    const item = DEPTH_META[eff];
                    const isActive = eff === activeEffort;
                    return (
                      <button
                        key={eff}
                        type="button"
                        role="radio"
                        aria-checked={isActive}
                        className={`depth-stop ${isActive ? "is-active" : ""}`}
                        onClick={() => void updateProvider({ thinkingEffort: eff })}
                      >
                        <span className="depth-bars" aria-hidden="true">
                          {[1, 2, 3, 4, 5].map((barIdx) => (
                            <span
                              key={barIdx}
                              className={`depth-bar ${barIdx <= item.level ? "is-lit" : ""}`}
                              style={{ height: 3 + barIdx * 1.8 }}
                            />
                          ))}
                        </span>
                        <span className="depth-stop-label">{item.shortLabel}</span>
                        <span className="depth-stop-en">{item.enLabel}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="depth-readout">
                  <div className="depth-readout-top">
                    <span className="depth-readout-title">{meta.title}</span>
                    <div className="depth-readout-tags">
                      <span className="depth-tag">{meta.speedTag}</span>
                      <span className="depth-tag">{meta.sceneTag}</span>
                    </div>
                  </div>
                  <div className="depth-readout-desc">{meta.desc}</div>
                </div>
              </div>
            );
          })()}

          {/* 3. Provider & One-Click Model Selector */}
          <div className="ai-studio-section">
            <label className="field-label" htmlFor="bot-provider-select" style={{ marginBottom: 2 }}>
              推論引擎與模型
            </label>
            <select
              id="bot-provider-select"
              className="select"
              value={snapshot.settings.provider}
              onChange={(e) => {
                const nextProvider = e.target.value as AiProvider;
                const nextModel = resolveModelOnProviderSwitch(snapshot.settings.model, nextProvider);
                setModelDraft(nextModel);
                void updateProvider(
                  nextModel !== snapshot.settings.model
                    ? { provider: nextProvider, model: nextModel }
                    : { provider: nextProvider },
                );
              }}
            >
              {AI_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
            {snapshot.settings.provider === "builtin" ? (
              <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.48 }}>
                本地結構化規則引擎，免金鑰即刻執行組別拆分、時程與手冊；切換上方外部供應商可啟用大模型深度推演。
              </div>
            ) : (
              <>
                <div className="model-chip-row" aria-label="推薦模型快速切換">
                  {PROVIDER_MODEL_PRESETS[snapshot.settings.provider].map((preset) => {
                    const cleanCurrent = stripEffortSuffix(snapshot.settings.model);
                    const isSelected = cleanCurrent === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className={`model-chip ${isSelected ? "is-active" : ""}`}
                        onClick={() => {
                          setModelDraft(preset.id);
                          void updateProvider({ model: preset.id });
                        }}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
                <form
                  style={{ display: "flex", gap: 6, marginTop: 4 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const trimmed = modelDraft.trim();
                    setModelDraft(trimmed);
                    void updateProvider({ model: trimmed });
                  }}
                >
                  <input
                    className="input"
                    aria-label="自訂模型 ID"
                    placeholder="或輸入自訂模型 ID（留空用預設）"
                    value={modelDraft}
                    onChange={(e) => setModelDraft(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="btn"
                    disabled={modelDraft.trim() === snapshot.settings.model}
                  >
                    儲存
                  </button>
                  {snapshot.settings.model && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setModelDraft("");
                        void updateProvider({ model: "" });
                      }}
                    >
                      恢復預設
                    </button>
                  )}
                </form>
              </>
            )}
          </div>

          {/* 4. Ponytail Efficiency 4-Stop Control */}
          {(() => {
            const activeMode = snapshot.settings.ponytailMode ?? DEFAULT_PONYTAIL_MODE;
            return (
              <div className="ai-studio-section">
                <div className="ai-section-head">
                  <span className="ai-section-title">Ponytail 效率模式</span>
                  <span className="ai-section-meta">
                    {activeMode === "ultra" ? "預設 · 主動精簡" : PONYTAIL_SHORT[activeMode]}
                  </span>
                </div>
                <div className="ponytail-seg-grid" role="radiogroup" aria-label="Ponytail 效率模式">
                  {PONYTAIL_SELECT_ORDER.map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={m === activeMode}
                      className={`ponytail-seg-btn ${m === activeMode ? "is-active" : ""}`}
                      onClick={() => void updateProvider({ ponytailMode: m })}
                    >
                      {PONYTAIL_SHORT[m]}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.48 }}>
                  {PONYTAIL_HINTS[activeMode]}
                </div>
              </div>
            );
          })()}
        </div>
      </aside>
    </div>
  );
}
