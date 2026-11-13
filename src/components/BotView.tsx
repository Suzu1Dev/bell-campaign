import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
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
  PACING_META,
  type AiProvider,
  type CampaignSnapshot,
  type ProviderSettings,
} from "../../shared/types";
import { computeCampaignMetrics } from "../../shared/sheets";
import { apiWrite } from "../lib/api";

const PROVIDER_LABELS: Record<AiProvider, string> = {
  builtin: "內建規則引擎（免金鑰・即時回應）",
  codex: "Codex CLI",
  claude: "Claude CLI",
  antigravity: "Antigravity CLI",
  api: "OpenAI 相容 API",
};

const QUICK_PROMPTS = [
  {
    label: "對焦專案性質與靈感借鏡",
    prompt: "我們這次專案預計舉辦 160 人的跨域社群交流活動，包含主題與談與圓桌互動，請幫我規劃專案性質定位並更新靈感借鏡案例。",
  },
  {
    label: "微調時程緊湊度",
    prompt: "幫我把整體排程調整成穩健緩衝節奏，避開撞期大活動並保留兩週驗收緩衝。",
  },
  {
    label: "盤點招工表單缺口",
    prompt: "幫我盤點目前招工表單各組缺口，並推薦優先錄取的候選志工。",
  },
  {
    label: "生成講者行前手冊",
    prompt: "請幫我自動生成一份給與談講者的行前手冊並歸檔。",
  },
  {
    label: "擬定下次週會大綱",
    prompt: "請幫我建立本週籌備週會的會前大綱、議程安排與注意事項。",
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
  notify,
}: {
  snapshot: CampaignSnapshot;
  onSnapshot: (next: CampaignSnapshot) => void;
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
                可直接對話請它調整時程節奏、新增待辦、生成講者／籌備手冊、撰寫會議大綱或審核招工表單
              </div>
            </div>
          </div>
          <span className="pill pill-campaign">{PROVIDER_LABELS[snapshot.settings.provider]}</span>
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
                      <div key={prop.id} className="proposal-card">
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
                            <span>已套用</span>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={busy}
                            onClick={() => void applyProposal(msg.id, prop.id)}
                          >
                            <Zap size={12} />
                            <span>{busy ? "套用中…" : "套用變更"}</span>
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
            <div
              style={{
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                background: "var(--panel)",
                border: "1px solid var(--line)",
              }}
            >
              <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>待審招工</div>
              <div className="tabular" style={{ fontSize: 16, fontWeight: 700 }}>
                {pendingFormCount} 筆
              </div>
            </div>
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

        <div className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700 }}>
            <Cpu size={15} style={{ color: "var(--campaign-text)" }} />
            <span>AI 引擎供應商</span>
          </div>
          <div>
            <label className="field-label" htmlFor="bot-provider-select">
              推論模式
            </label>
            <select
              id="bot-provider-select"
              className="select"
              value={snapshot.settings.provider}
              onChange={(e) => void updateProvider({ provider: e.target.value as AiProvider })}
            >
              {AI_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.5, marginTop: 6 }}>
              {snapshot.settings.provider === "builtin"
                ? "預設採用本地端結構化排程與規則引擎，免設定 API 金鑰、無外部網路等待即可操作時程、手冊與名單；亦可切換為外部大模型。"
                : "將透過外部 CLI 或 API 大語言模型生成回覆，若外部服務連線逾時會自動回退至內建引擎保底。"}
            </div>
          </div>
          {snapshot.settings.provider !== "builtin" && (
            <div style={{ display: "flex", gap: 6 }}>
              <input
                className="input"
                placeholder="選填模型名稱"
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
              />
              <button
                type="button"
                className="btn"
                onClick={() => void updateProvider({ model: modelDraft })}
              >
                儲存
              </button>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
