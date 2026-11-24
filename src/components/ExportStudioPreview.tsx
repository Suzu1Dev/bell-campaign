import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CampaignSnapshot, TeamColor } from "../../shared/types";
import { buildStyledSheetModel, type BorderWeight, type DeckSlide } from "../../shared/exporters";

export function ScaledDeckStage({
  fitViewport = false,
  children,
}: {
  fitViewport?: boolean;
  children: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(fitViewport ? 0.92 : 0.74);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      if (fitViewport && rect.height > 0) {
        setScale(Math.min(rect.width / 1280, rect.height / 720));
      } else {
        setScale(rect.width / 1280);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitViewport]);

  if (fitViewport) {
    const scaledW = Math.round(1280 * scale);
    const scaledH = Math.round(720 * scale);
    return (
      <div
        ref={hostRef}
        style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <div style={{ width: scaledW, height: scaledH, position: "relative", overflow: "hidden" }}>
          <div style={{ width: 1280, height: 720, transform: `scale(${scale})`, transformOrigin: "top left" }}>
            {children}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={hostRef} style={{ width: "100%", height: Math.round(720 * scale), position: "relative", overflow: "hidden" }}>
      <div style={{ width: 1280, height: 720, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        {children}
      </div>
    </div>
  );
}

const DECK_TEAM_ACCENT: Record<TeamColor, string> = {
  rose: "var(--dk-team-rose)",
  violet: "var(--dk-team-violet)",
  mint: "var(--dk-team-mint)",
  amber: "var(--dk-team-amber)",
  sky: "var(--dk-team-sky)",
  terracotta: "var(--dk-team-terracotta)",
};

export function DeckSlideView({
  slide,
  campaignName,
  totalSlides,
}: {
  slide: DeckSlide;
  campaignName: string;
  totalSlides: number;
}) {
  const footer = (
    <footer className="dk-foot">
      <span>{campaignName} · BELL Campaign Project Briefing</span>
      <span className="dk-mono">
        SLIDE {slide.indexLabel} / {String(totalSlides).padStart(2, "0")}
      </span>
    </footer>
  );

  if (slide.kind === "cover") {
    return (
      <section className="dk-slide">
        <div className="dk-cover-grid">
          <div className="dk-cover-main">
            <div>
              <span className="dk-kicker">{slide.kicker}</span>
              <h3 className="dk-hero-title">{slide.title}</h3>
              <p className="dk-hero-sub">{slide.subtitle}</p>
            </div>
            <div className="dk-narrative-box">
              <div className="dk-box-label">專案定位</div>
              <p>{slide.narrative}</p>
            </div>
            <div className="dk-meta-strip">
              <div className="dk-meta-pill">
                <span>舉辦時間</span>
                <strong title={slide.dateLabel}>{slide.dateLabel}</strong>
              </div>
              <div className="dk-meta-pill">
                <span>排程節奏</span>
                <strong>{slide.pacingLabel}</strong>
              </div>
              <div className="dk-meta-pill">
                <span>當前週次</span>
                <strong>
                  {slide.focusWeekLabel} {slide.focusWeekRange}
                </strong>
              </div>
            </div>
          </div>
          <div className="dk-bento-2x2">
            {slide.kpis.map((k) => (
              <div key={k.label} className={`dk-kpi dk-kpi-${k.tone}`}>
                <div className="dk-kpi-label">{k.label}</div>
                <div className="dk-kpi-val">{k.value}</div>
                <div className="dk-kpi-sub">{k.sub}</div>
              </div>
            ))}
          </div>
        </div>
        {footer}
      </section>
    );
  }

  if (slide.kind === "roadmap") {
    const totalW = Math.max(1, slide.stageSpans.reduce((s, x) => s + x.weeks, 0));
    const cols = Math.min(6, Math.max(2, slide.months.length));
    return (
      <section className="dk-slide">
        <header className="dk-head">
          <span className="dk-kicker">{slide.kicker}</span>
          <h2>{slide.title}</h2>
          <p>{slide.subtitle}</p>
        </header>
        <div className="dk-ribbon">
          {slide.stageSpans.map((sp, i) => (
            <div
              key={`${sp.stage}-${i}`}
              className="dk-ribbon-seg"
              style={{
                width: `${((sp.weeks / totalW) * 100).toFixed(2)}%`,
                borderTop: `4px solid ${sp.hex}`,
              }}
            >
              <div className="dk-ribbon-stage" style={{ color: sp.hex }}>
                {sp.stage}
              </div>
              <div className="dk-ribbon-meta">
                {sp.weeks} 週 · {sp.range}
              </div>
            </div>
          ))}
        </div>
        <div
          className="dk-grid"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, flex: 1 }}
        >
          {slide.months.map((m, idx) => (
            <div key={m.month} className="dk-card">
              <div className="dk-card-top">
                <span className="dk-step-num">0{idx + 1}</span>
                <strong>{m.month}</strong>
                <span className="dk-pill-muted">
                  {m.weekCount} 週 · {m.todoCount} 項
                </span>
              </div>
              <p className="dk-month-goal">{m.goal}</p>
              {m.highlights.length > 0 && (
                <ul className="dk-mini-list">
                  {m.highlights.map((h, hi) => (
                    <li key={hi}>{h}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
        {footer}
      </section>
    );
  }

  if (slide.kind === "radar") {
    return (
      <section className="dk-slide">
        <header className="dk-head">
          <span className="dk-kicker">{slide.kicker}</span>
          <h2>{slide.title}</h2>
          <p>{slide.subtitle}</p>
        </header>
        <div className="dk-two-col" style={{ flex: 1 }}>
          <div className="dk-card">
            <div className="dk-section-label">重要死線</div>
            <div className="dk-rail-list">
              {slide.milestones.length > 0 ? (
                slide.milestones.map((m, i) => (
                  <div key={i} className="dk-rail-item">
                    <div className="dk-rail-tag">
                      {m.countdown}
                      <span>{m.dateRange}</span>
                    </div>
                    <div className="dk-rail-body">
                      <strong>{m.title}</strong>
                      <span>{m.memo}</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="dk-empty">尚無里程碑</div>
              )}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="dk-card" style={{ flex: 1 }}>
              <div className="dk-section-label">撞期避開（考期／連假／大賽）</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {slide.conflicts.length > 0 ? (
                  slide.conflicts.map((c, i) => (
                    <div key={i} className="dk-conflict-card">
                      <div className="dk-warn-badge">
                        撞期 · {c.countdown}（{c.dateRange}）
                      </div>
                      <strong>{c.title}</strong>
                      <span>{c.mitigation}</span>
                    </div>
                  ))
                ) : (
                  <div className="dk-empty">目前無撞期</div>
                )}
              </div>
            </div>
            <div className="dk-card">
              <div className="dk-section-label">每週負載節奏（橘色＝撞期降載）</div>
              <div className="dk-bars">
                {slide.loadBars.map((b, i) => (
                  <div key={i} className="dk-bar-col">
                    <div className="dk-bar-well">
                      <div
                        className="dk-bar-fill"
                        style={{
                          height: `${b.score}%`,
                          background: b.isEvent
                            ? "var(--dk-brand)"
                            : b.hasConflict
                              ? "var(--dk-warn)"
                              : "var(--dk-bar)",
                        }}
                      />
                    </div>
                    <span>{b.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        {footer}
      </section>
    );
  }

  if (slide.kind === "teams") {
    return (
      <section className="dk-slide">
        <header className="dk-head">
          <span className="dk-kicker">{slide.kicker}</span>
          <h2>{slide.title}</h2>
          <p>{slide.subtitle}</p>
        </header>
        <div className="dk-bento-teams" style={{ flex: 1 }}>
          {slide.teams.map((t) => {
            const accent = DECK_TEAM_ACCENT[t.color] ?? "var(--dk-brand)";
            return (
              <div key={t.id} className="dk-card dk-team-card" style={{ borderTop: `3px solid ${accent}` }}>
                <div className="dk-team-top">
                  <div>
                    <strong>{t.name}</strong>
                    <span className="dk-team-meta">
                      組長：{t.lead} · {t.headcount} 人
                    </span>
                  </div>
                  <span className="dk-pill-muted">
                    {t.done}/{t.total} · {t.percent}%
                  </span>
                </div>
                <div className="dk-prog-track">
                  <div
                    className="dk-prog-fill"
                    style={{ width: `${Math.max(4, t.percent)}%`, background: accent }}
                  />
                </div>
                <ul className="dk-todo-list">
                  {t.keyTodos.map((td, idx) => (
                    <li key={idx}>
                      <span className="dk-wk-chip">{td.weekLabel}</span>
                      <span>{td.title}</span>
                    </li>
                  ))}
                </ul>
                {t.crossNotes[0] && <div className="dk-cross-note">↔ 跨部：{t.crossNotes[0]}</div>}
              </div>
            );
          })}
        </div>
        {footer}
      </section>
    );
  }

  if (slide.kind === "ecosystem") {
    return (
      <section className="dk-slide">
        <header className="dk-head">
          <span className="dk-kicker">{slide.kicker}</span>
          <h2>{slide.title}</h2>
          <p>{slide.subtitle}</p>
        </header>
        <div className="dk-two-col" style={{ flex: 1 }}>
          <div className="dk-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {slide.partnerGroups.length > 0 ? (
              slide.partnerGroups.map((g) => (
                <div key={g.category} className="dk-partner-group">
                  <div className="dk-section-label">{g.category}</div>
                  <div className="dk-partner-items">
                    {g.items.map((it, idx) => (
                      <div key={idx} className="dk-partner-row">
                        <div>
                          <strong>{it.name}</strong>
                          <span>{it.role || it.org}</span>
                        </div>
                        <em className="dk-pill-muted">{it.status}</em>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="dk-empty">尚無合作名單</div>
            )}
          </div>
          <div className="dk-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <div className="dk-section-label">近期議程 · {slide.meetingDate}</div>
              <strong style={{ fontSize: 14.5, display: "block", marginBottom: 8 }}>
                {slide.meetingTitle}
              </strong>
              <ul className="dk-agenda-list">
                {slide.agendaItems.map((a, i) => (
                  <li key={i}>
                    <strong>0{i + 1}</strong>
                    <span>{a}</span>
                  </li>
                ))}
              </ul>
            </div>
            {slide.precautionItems.length > 0 && (
              <div className="dk-precaution-box">
                <div className="dk-section-label">注意＆防踩坑</div>
                <ul className="dk-mini-list">
                  {slide.precautionItems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
        {footer}
      </section>
    );
  }

  return (
    <section className="dk-slide">
      <header className="dk-head">
        <span className="dk-kicker">{slide.kicker}</span>
        <h2>{slide.title}</h2>
        <p>{slide.subtitle}</p>
      </header>
      <div className="dk-mx-wrap" style={{ flex: 1 }}>
        <table className="dk-mx-table">
          <thead>
            <tr>
              <th>組別 ／ 月份</th>
              {slide.monthColumns.map((m) => (
                <th key={m}>{m}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slide.rows.map((r) => {
              const accent = DECK_TEAM_ACCENT[r.color] ?? "var(--dk-brand)";
              return (
                <tr key={r.teamName}>
                  <td>
                    <div className="dk-mx-team">
                      <span className="dk-dot" style={{ background: accent }} />
                      <div style={{ minWidth: 0 }}>
                        <strong>{r.teamName}</strong>
                        <span>{r.lead}</span>
                      </div>
                    </div>
                  </td>
                  {r.cells.map((c, ci) => (
                    <td key={ci}>
                      <div className="dk-mx-focus">{c.focus}</div>
                      {c.count > 0 && (
                        <span className="dk-mx-count">
                          {c.done}/{c.count} 項
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer}
    </section>
  );
}

function previewBorderCss(w: BorderWeight | undefined): string {
  const bw = w ?? "grid";
  if (bw === "none") return "none";
  if (bw === "box_strong") return "1.5px solid #000000";
  if (bw === "box") return "1px solid #000000";
  return "1px solid #E2E5EC";
}

/**
 * Compact visual preview of the formatted Google Sheet model (showing exact colors, black box borders,
 * bold hierarchy, merged headers, and vertical team blocks) inside the Export Studio modal.
 */
export function StyledSheetMiniPreview({ snapshot }: { snapshot: CampaignSnapshot }) {
  const model = useMemo(() => buildStyledSheetModel(snapshot), [snapshot]);

  const totalRows = model.cells.length;
  const totalCols = model.cells[0]?.length ?? 0;

  const { covered, spans } = useMemo(() => {
    const cov = new Set<string>();
    const sp = new Map<string, { rowSpan: number; colSpan: number; fullEndRow: number; fullEndCol: number }>();
    for (const m of model.merges) {
      if (m.startRow >= totalRows || m.startCol >= totalCols) continue;
      const endR = Math.min(m.endRow, totalRows - 1);
      const endC = Math.min(m.endCol, totalCols - 1);
      const rSpan = endR - m.startRow + 1;
      const cSpan = endC - m.startCol + 1;
      sp.set(`${m.startRow}:${m.startCol}`, {
        rowSpan: rSpan,
        colSpan: cSpan,
        fullEndRow: m.endRow,
        fullEndCol: m.endCol,
      });
      for (let r = m.startRow; r <= endR; r++) {
        for (let c = m.startCol; c <= endC; c++) {
          if (r === m.startRow && c === m.startCol) continue;
          cov.add(`${r}:${c}`);
        }
      }
    }
    return { covered: cov, spans: sp };
  }, [model, totalRows, totalCols]);

  return (
    <div className="sheet-preview-box">
      <div className="sheet-preview-caption">
        <span>匯出試算表即時預覽 · 僅匯出時自動加上黑框匡線、粗體階層與儲存格合併</span>
        <span className="tabular" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
          即時同步 {snapshot.teams.length} 組別 · {snapshot.weeks.length} 週（{totalRows} 列 × {totalCols} 欄）
        </span>
      </div>
      <div className="sheet-preview-scroll">
        <table className="sheet-preview-table">
          <tbody>
            {model.cells.map((row, rIdx) => (
              <tr key={rIdx}>
                {row.map((cell, cIdx) => {
                  const key = `${rIdx}:${cIdx}`;
                  if (covered.has(key)) return null;
                  const span = spans.get(key);
                  const bTop = cell.style.borders?.top;
                  const bLeft = cell.style.borders?.left;
                  const bBottom = span
                    ? model.cells[span.fullEndRow]?.[cIdx]?.style.borders?.bottom
                    : cell.style.borders?.bottom;
                  const bRight = span
                    ? model.cells[rIdx]?.[span.fullEndCol]?.style.borders?.right
                    : cell.style.borders?.right;
                  return (
                    <td
                      key={cIdx}
                      rowSpan={span && span.rowSpan > 1 ? span.rowSpan : undefined}
                      colSpan={span && span.colSpan > 1 ? span.colSpan : undefined}
                      style={{
                        backgroundColor: `#${cell.style.bg}`,
                        color: `#${cell.style.fg}`,
                        fontWeight: cell.style.bold ? 700 : 400,
                        textAlign: cell.style.align,
                        verticalAlign: cell.style.valign,
                        borderTop: previewBorderCss(bTop),
                        borderRight: previewBorderCss(bRight),
                        borderBottom: previewBorderCss(bBottom),
                        borderLeft: previewBorderCss(bLeft),
                        minWidth: cIdx === 0 ? 112 : cIdx === 1 ? 76 : 152,
                        maxWidth: cIdx >= 2 ? 196 : undefined,
                      }}
                    >
                      {cell.value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
