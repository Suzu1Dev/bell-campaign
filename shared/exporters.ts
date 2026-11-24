import {
  PACING_META,
  type CampaignSnapshot,
  type CellStage,
  type TeamColor,
} from "./types.js";
import { computeCampaignMetrics, formatCampaignDateLabel } from "./sheets.js";

// ── 1. Reference-Grade Styled Spreadsheet Model (Google Sheets & .xlsx) ─────

export type BorderWeight = "none" | "grid" | "box" | "box_strong";

export interface SheetCellBorders {
  top?: BorderWeight;
  right?: BorderWeight;
  bottom?: BorderWeight;
  left?: BorderWeight;
}

export interface SheetCellStyle {
  bg: string; // 6-hex without '#', e.g. "434343"
  fg: string; // 6-hex without '#', e.g. "FFFFFF"
  bold: boolean;
  align: "left" | "center";
  valign: "middle" | "top";
  fontSize?: number;
  borders?: SheetCellBorders;
}

export interface SheetMergeRange {
  startRow: number; // 0-based inclusive
  startCol: number; // 0-based inclusive
  endRow: number;   // 0-based inclusive
  endCol: number;   // 0-based inclusive
}

export interface StyledSheetModel {
  sheetName: string;
  colWidthsPx: number[];
  rowHeightsPt: number[];
  cells: Array<Array<{ value: string; style: SheetCellStyle }>>;
  merges: SheetMergeRange[];
  frozenRows: number;
  frozenCols: number;
}

const SHEET_TEAM_HEX: Record<TeamColor, string> = {
  rose: "E06666",
  sky: "6D9EEB",
  violet: "8E7CC3",
  mint: "57A773",
  amber: "E69138",
  terracotta: "DD7E6B",
};

function stageHex(stage: CellStage): { bg: string; fg: string } {
  switch (stage) {
    case "活動":
      return { bg: "9E2B5C", fg: "FFFFFF" };
    case "Debug":
    case "RC":
      return { bg: "C27828", fg: "FFFFFF" };
    case "進度100%":
      return { bg: "3D8B6E", fg: "FFFFFF" };
    case "進度60%":
    case "進度75%":
    case "進度80%":
      return { bg: "4A6FA5", fg: "FFFFFF" };
    case "復盤":
      return { bg: "6B5CA5", fg: "FFFFFF" };
    case "待排":
      return { bg: "8A8F99", fg: "FFFFFF" };
    default:
      return { bg: "666666", fg: "FFFFFF" };
  }
}

function estimateWrappedLines(text: string, charsPerLine: number): number {
  if (!text) return 1;
  return text
    .split("\n")
    .reduce((sum, seg) => {
      const visualUnits = [...seg].reduce((u, ch) => u + (ch.charCodeAt(0) > 255 ? 1.85 : 1), 0);
      return sum + Math.max(1, Math.ceil(visualUnits / Math.max(8, charsPerLine)));
    }, 0);
}

const BORDER_RANK: Record<BorderWeight, number> = {
  none: 0,
  grid: 1,
  box: 2,
  box_strong: 3,
};

function strongerBorder(a: BorderWeight | undefined, b: BorderWeight): BorderWeight {
  const cur = a ?? "grid";
  return BORDER_RANK[b] >= BORDER_RANK[cur] ? b : cur;
}

function borderWeightCss(w: BorderWeight | undefined, strongPx = "1.5pt"): string {
  switch (w) {
    case "box_strong":
      return `${strongPx} solid #000000`;
    case "box":
      return "1pt solid #000000";
    case "none":
      return "none";
    default:
      return "1px solid #E2E5EC";
  }
}

/**
 * Builds a complete formatted schedule spreadsheet model matching the reference Google Sheet
 * (`籌備時程規劃-2026`): black structural box borders (`#000000` 方框匡線), bold hierarchy, clean white empty cells,
 * reference pastel fills, generous column widths, and automatic cell merges.
 */
export function buildStyledSheetModel(snapshot: CampaignSnapshot): StyledSheetModel {
  const orderedWeeks = [...snapshot.weeks].sort((a, b) => a.orderIndex - b.orderIndex);
  const orderedTeams = [...snapshot.teams].sort((a, b) => a.orderIndex - b.orderIndex);
  const cellMap = new Map(snapshot.cells.map((c) => [`${c.weekId}:${c.teamId}`, c]));

  const numWeeks = orderedWeeks.length;
  const totalCols = 2 + numWeeks;

  const cells: Array<Array<{ value: string; style: SheetCellStyle }>> = [];
  const merges: SheetMergeRange[] = [];
  const monthEndCols = new Set<number>();
  const eventCols = new Set<number>();
  const teamBlocks: Array<{ startRow: number; crossRow: number; endRow: number }> = [];

  const makeRow = (defaultStyle: SheetCellStyle) =>
    Array.from({ length: totalCols }, () => ({ value: "", style: { ...defaultStyle } }));

  const darkHead: SheetCellStyle = { bg: "434343", fg: "FFFFFF", bold: true, align: "center", valign: "middle", fontSize: 10 };
  const slateHead: SheetCellStyle = { bg: "666666", fg: "FFFFFF", bold: true, align: "center", valign: "middle", fontSize: 10 };
  const lightBand: SheetCellStyle = { bg: "EAEAEA", fg: "1C1C1C", bold: true, align: "center", valign: "middle", fontSize: 10 };
  const subBand: SheetCellStyle = { bg: "EFEFEF", fg: "222222", bold: false, align: "center", valign: "middle", fontSize: 10 };
  const whiteEmpty: SheetCellStyle = { bg: "FFFFFF", fg: "222222", bold: false, align: "center", valign: "middle", fontSize: 10 };

  // Row 0: 月 (with A1:A2 vertical merge + consecutive month horizontal merges)
  const rMonth = makeRow(lightBand);
  rMonth[0] = { value: snapshot.campaign.name, style: { ...darkHead, fontSize: 11 } };
  rMonth[1] = { value: "月", style: darkHead };
  let mRunStart = 0;
  while (mRunStart < numWeeks) {
    const label = orderedWeeks[mRunStart].monthLabel;
    let mRunEnd = mRunStart;
    while (mRunEnd + 1 < numWeeks && orderedWeeks[mRunEnd + 1].monthLabel === label) {
      mRunEnd += 1;
    }
    for (let k = mRunStart; k <= mRunEnd; k++) {
      rMonth[2 + k] = { value: k === mRunStart ? label : "", style: { ...lightBand, fontSize: 12 } };
    }
    monthEndCols.add(2 + mRunEnd);
    if (mRunEnd > mRunStart) {
      merges.push({ startRow: 0, startCol: 2 + mRunStart, endRow: 0, endCol: 2 + mRunEnd });
    }
    mRunStart = mRunEnd + 1;
  }
  cells.push(rMonth);

  // Row 1: 日期 (regular weight on week dates so bold headers & content stand out)
  const rDate = makeRow(lightBand);
  rDate[0] = { value: "", style: darkHead };
  rDate[1] = { value: "日期", style: darkHead };
  orderedWeeks.forEach((w, idx) => {
    rDate[2 + idx] = { value: w.dateRange, style: { ...lightBand, bold: false } };
  });
  cells.push(rDate);
  merges.push({ startRow: 0, startCol: 0, endRow: 1, endCol: 0 }); // A1:A2

  // Row 2: 倒數週數 (A3:B3 merged; bold only on event week)
  const rCountdown = makeRow(subBand);
  rCountdown[0] = { value: "倒數週數", style: slateHead };
  rCountdown[1] = { value: "", style: slateHead };
  merges.push({ startRow: 2, startCol: 0, endRow: 2, endCol: 1 });
  orderedWeeks.forEach((w, idx) => {
    const isEvent = w.phase === "event";
    if (isEvent) eventCols.add(2 + idx);
    rCountdown[2 + idx] = {
      value: w.countdownLabel,
      style: isEvent
        ? { bg: "F4CCCC", fg: "7A1C3E", bold: true, align: "center", valign: "middle", fontSize: 10 }
        : subBand,
    };
  });
  cells.push(rCountdown);

  // Row 3: 整體進度 (A4:B4 merged + consecutive identical stage horizontal merges)
  const rOverall = makeRow(slateHead);
  rOverall[0] = { value: "整體進度", style: slateHead };
  rOverall[1] = { value: "", style: slateHead };
  merges.push({ startRow: 3, startCol: 0, endRow: 3, endCol: 1 });
  let sRunStart = 0;
  while (sRunStart < numWeeks) {
    const st = orderedWeeks[sRunStart].stage;
    let sRunEnd = sRunStart;
    while (sRunEnd + 1 < numWeeks && orderedWeeks[sRunEnd + 1].stage === st) {
      sRunEnd += 1;
    }
    const sc = stageHex(st);
    for (let k = sRunStart; k <= sRunEnd; k++) {
      rOverall[2 + k] = {
        value: k === sRunStart ? st : "",
        style: { bg: sc.bg, fg: sc.fg, bold: true, align: "center", valign: "middle", fontSize: 10 },
      };
    }
    if (sRunEnd > sRunStart) {
      merges.push({ startRow: 3, startCol: 2 + sRunStart, endRow: 3, endCol: 2 + sRunEnd });
    }
    sRunStart = sRunEnd + 1;
  }
  cells.push(rOverall);

  // Row 4: 主要排程 (A5:B5 merged; sage #D9EAD3 for milestones, peach #FCE5CD for conflicts, clean white when empty)
  const rMajor = makeRow(whiteEmpty);
  rMajor[0] = { value: "主要排程", style: darkHead };
  rMajor[1] = { value: "", style: darkHead };
  merges.push({ startRow: 4, startCol: 0, endRow: 4, endCol: 1 });
  orderedWeeks.forEach((w, idx) => {
    if (w.majorEvents.length === 0) return;
    const hasConflict = w.majorEvents.some((e) => e.kind === "conflict");
    const text = w.majorEvents.map((e) => e.title).join("\n");
    rMajor[2 + idx] = {
      value: text,
      style: hasConflict
        ? { bg: "FCE5CD", fg: "222222", bold: true, align: "center", valign: "middle", fontSize: 10 }
        : { bg: "D9EAD3", fg: "222222", bold: true, align: "center", valign: "middle", fontSize: 10 },
    };
  });
  cells.push(rMajor);

  // Row 5: 備註 (A6:B6 merged; rose #F4CCCC when populated, clean white when empty)
  const rMemo = makeRow(whiteEmpty);
  rMemo[0] = { value: "備註", style: darkHead };
  rMemo[1] = { value: "", style: darkHead };
  merges.push({ startRow: 5, startCol: 0, endRow: 5, endCol: 1 });
  orderedWeeks.forEach((w, idx) => {
    if (!w.memo.trim()) return;
    rMemo[2 + idx] = {
      value: w.memo.trim(),
      style: { bg: "F4CCCC", fg: "222222", bold: true, align: "center", valign: "middle", fontSize: 10 },
    };
  });
  cells.push(rMemo);

  // Team Multi-Row Blocks (matching reference sheet: Team col vertically merged, 本週進度, N rows 待辦事項, 跨部合作)
  for (const team of orderedTeams) {
    const teamHex = SHEET_TEAM_HEX[team.color] ?? "6D9EEB";
    const teamColStyle: SheetCellStyle = {
      bg: teamHex,
      fg: "FFFFFF",
      bold: true,
      align: "center",
      valign: "middle",
      fontSize: 11,
    };

    const todosByWeek = orderedWeeks.map((w) =>
      snapshot.todos.filter((t) => t.teamId === team.id && t.weekId === w.id),
    );
    const maxTodoRows = Math.max(1, ...todosByWeek.map((list) => list.length));
    const teamStartRow = cells.length;

    // 1) 本週進度 row (merge consecutive identical non-empty focus spans horizontally)
    const rFocus = makeRow(whiteEmpty);
    rFocus[0] = { value: team.name, style: teamColStyle };
    rFocus[1] = {
      value: "本週進度",
      style: { bg: "F4CCCC", fg: "595959", bold: true, align: "center", valign: "middle", fontSize: 10 },
    };
    let fStart = 0;
    while (fStart < numWeeks) {
      const focusVal = (cellMap.get(`${orderedWeeks[fStart].id}:${team.id}`)?.weeklyFocus ?? "").trim();
      if (!focusVal) {
        fStart += 1;
        continue;
      }
      let fEnd = fStart;
      while (
        fEnd + 1 < numWeeks &&
        (cellMap.get(`${orderedWeeks[fEnd + 1].id}:${team.id}`)?.weeklyFocus ?? "").trim() === focusVal
      ) {
        fEnd += 1;
      }
      for (let k = fStart; k <= fEnd; k++) {
        rFocus[2 + k] = {
          value: k === fStart ? focusVal : "",
          style: { bg: "F4CCCC", fg: "222222", bold: true, align: "center", valign: "middle", fontSize: 10 },
        };
      }
      if (fEnd > fStart) {
        merges.push({ startRow: cells.length, startCol: 2 + fStart, endRow: cells.length, endCol: 2 + fEnd });
      }
      fStart = fEnd + 1;
    }
    cells.push(rFocus);

    // 2) 待辦事項 rows (1 todo per sub-row, bold & centered just like reference sheet, Col B vertically merged)
    const todoStartRow = cells.length;
    for (let tr = 0; tr < maxTodoRows; tr++) {
      const rTodo = makeRow(whiteEmpty);
      rTodo[0] = { value: "", style: teamColStyle };
      rTodo[1] = {
        value: tr === 0 ? "待辦事項" : "",
        style: { bg: "FFF2CC", fg: "595959", bold: true, align: "center", valign: "middle", fontSize: 10 },
      };
      orderedWeeks.forEach((_, wIdx) => {
        const item = todosByWeek[wIdx][tr];
        if (!item) return;
        rTodo[2 + wIdx] = {
          value: item.done ? `✓ ${item.title}` : item.title,
          style: item.done
            ? { bg: "D9EAD3", fg: "274E13", bold: true, align: "center", valign: "middle", fontSize: 10 }
            : { bg: "FFF2CC", fg: "222222", bold: true, align: "center", valign: "middle", fontSize: 10 },
        };
      });
      cells.push(rTodo);
    }
    if (maxTodoRows > 1) {
      merges.push({ startRow: todoStartRow, startCol: 1, endRow: todoStartRow + maxTodoRows - 1, endCol: 1 });
    }

    // 3) 跨部合作 row
    const crossRow = cells.length;
    const rCross = makeRow(whiteEmpty);
    rCross[0] = { value: "", style: teamColStyle };
    rCross[1] = {
      value: "跨部合作",
      style: { bg: "CFE2F3", fg: "595959", bold: true, align: "center", valign: "middle", fontSize: 10 },
    };
    orderedWeeks.forEach((w, wIdx) => {
      const cross = (cellMap.get(`${w.id}:${team.id}`)?.crossTeam ?? "").trim();
      if (!cross) return;
      rCross[2 + wIdx] = {
        value: cross,
        style: { bg: "CFE2F3", fg: "1D3B58", bold: true, align: "center", valign: "middle", fontSize: 10 },
      };
    });
    cells.push(rCross);

    const teamEndRow = cells.length - 1;
    merges.push({ startRow: teamStartRow, startCol: 0, endRow: teamEndRow, endCol: 0 });
    teamBlocks.push({ startRow: teamStartRow, crossRow, endRow: teamEndRow });
  }

  // Apply structural black box borders ("方框匡線", #000000) matching the reference spreadsheet
  const totalRows = cells.length;
  const setEdge = (r: number, c: number, side: keyof SheetCellBorders, w: BorderWeight) => {
    const cell = cells[r]?.[c];
    if (!cell) return;
    cell.style.borders = cell.style.borders ?? { top: "grid", right: "grid", bottom: "grid", left: "grid" };
    cell.style.borders[side] = strongerBorder(cell.style.borders[side], w);
  };

  for (let r = 0; r < totalRows; r++) {
    for (let c = 0; c < totalCols; c++) {
      cells[r][c].style.borders = { top: "grid", right: "grid", bottom: "grid", left: "grid" };
      if (r === 0) setEdge(r, c, "top", "box_strong");
      if (r === totalRows - 1) setEdge(r, c, "bottom", "box_strong");
      if (c === 0) {
        setEdge(r, c, "left", "box_strong");
        setEdge(r, c, "right", "box");
      }
      if (c === 1) {
        setEdge(r, c, "left", "box");
        setEdge(r, c, "right", "box_strong");
      }
      if (c === totalCols - 1) setEdge(r, c, "right", "box_strong");
      if (monthEndCols.has(c)) {
        setEdge(r, c, "right", "box");
        if (c + 1 < totalCols) setEdge(r, c + 1, "left", "box");
      }
      if (eventCols.has(c)) {
        setEdge(r, c, "left", "box");
        setEdge(r, c, "right", "box");
        if (c - 1 >= 0) setEdge(r, c - 1, "right", "box");
        if (c + 1 < totalCols) setEdge(r, c + 1, "left", "box");
      }
    }
  }

  // Header bands (Rows 0..5): crisp black box grid on Rows 0..3; horizontal dividers on Rows 4..5
  for (let r = 0; r <= 5; r++) {
    const w: BorderWeight = r === 5 ? "box_strong" : "box";
    for (let c = 0; c < totalCols; c++) {
      setEdge(r, c, "bottom", w);
      if (r + 1 < totalRows) setEdge(r + 1, c, "top", w);
      if (r <= 3) {
        setEdge(r, c, "left", "box");
        setEdge(r, c, "right", "box");
      }
    }
  }

  // Team block outer box frames + Col B sub-row dividers
  for (const tb of teamBlocks) {
    for (let c = 0; c < totalCols; c++) {
      setEdge(tb.startRow, c, "top", "box_strong");
      if (tb.startRow - 1 >= 0) setEdge(tb.startRow - 1, c, "bottom", "box_strong");
      setEdge(tb.endRow, c, "bottom", "box_strong");
      if (tb.endRow + 1 < totalRows) setEdge(tb.endRow + 1, c, "top", "box_strong");
    }
    setEdge(tb.startRow, 1, "bottom", "box");
    if (tb.startRow + 1 <= tb.endRow) setEdge(tb.startRow + 1, 1, "top", "box");
    setEdge(tb.crossRow, 1, "top", "box");
    if (tb.crossRow - 1 >= tb.startRow) setEdge(tb.crossRow - 1, 1, "bottom", "box");
  }

  // Frame every populated colored cell (Rows 4..end, Cols 2..end) with crisp #000000 box borders
  for (let r = 4; r < totalRows; r++) {
    for (let c = 2; c < totalCols; c++) {
      const bg = cells[r]?.[c]?.style.bg;
      if (bg && bg !== "FFFFFF") {
        setEdge(r, c, "left", "box");
        if (c - 1 >= 2) setEdge(r, c - 1, "right", "box");
        setEdge(r, c, "right", "box");
        if (c + 1 < totalCols) setEdge(r, c + 1, "left", "box");
        // If stacked yellow todo rows, frame top of first and bottom of last
        const aboveSameTodo = bg === "FFF2CC" && cells[r - 1]?.[c]?.style.bg === "FFF2CC";
        const belowSameTodo = bg === "FFF2CC" && cells[r + 1]?.[c]?.style.bg === "FFF2CC";
        if (!aboveSameTodo) {
          setEdge(r, c, "top", "box");
          if (r - 1 >= 0) setEdge(r - 1, c, "bottom", "box");
        }
        if (!belowSameTodo) {
          setEdge(r, c, "bottom", "box");
          if (r + 1 < totalRows) setEdge(r + 1, c, "top", "box");
        }
      }
    }
  }

  // Clear interior seams inside merged ranges so merged boxes render with clean perimeters
  for (const m of merges) {
    for (let r = m.startRow; r <= m.endRow; r++) {
      for (let c = m.startCol; c <= m.endCol; c++) {
        if (r < m.endRow && cells[r]?.[c]?.style.borders) cells[r][c].style.borders!.bottom = "none";
        if (r > m.startRow && cells[r]?.[c]?.style.borders) cells[r][c].style.borders!.top = "none";
        if (c < m.endCol && cells[r]?.[c]?.style.borders) cells[r][c].style.borders!.right = "none";
        if (c > m.startCol && cells[r]?.[c]?.style.borders) cells[r][c].style.borders!.left = "none";
      }
    }
  }

  // Compute balanced column widths (px): crisp proportions like the reference sheet while never eating text
  const colWidthsPx: number[] = [138, 96];
  for (let wIdx = 0; wIdx < numWeeks; wIdx++) {
    let maxLen = 10;
    for (let r = 0; r < cells.length; r++) {
      const v = cells[r][2 + wIdx]?.value ?? "";
      for (const seg of v.split("\n")) {
        if (seg.length > maxLen) maxLen = seg.length;
      }
    }
    colWidthsPx.push(maxLen > 24 ? 220 : maxLen > 14 ? 186 : 162);
  }

  // Compute row heights (pt) accounting for wrapped lines (skip horizontally merged spans when estimating single-col wrap)
  const mergedStartSpan = new Map<string, number>();
  for (const m of merges) {
    if (m.endCol > m.startCol) {
      mergedStartSpan.set(`${m.startRow}:${m.startCol}`, m.endCol - m.startCol + 1);
    }
  }

  const rowHeightsPt = cells.map((row, rIdx) => {
    if (rIdx <= 3) return 24;
    let maxLines = 1;
    for (let c = 1; c < row.length; c++) {
      const val = row[c].value;
      if (!val) continue;
      const spanCols = mergedStartSpan.get(`${rIdx}:${c}`) ?? 1;
      const colPx = colWidthsPx[c] * spanCols;
      const charsPerLine = Math.max(10, Math.floor((colPx - 16) / 7.5));
      maxLines = Math.max(maxLines, estimateWrappedLines(val, charsPerLine));
    }
    return Math.min(110, Math.max(24, maxLines * 15 + 9));
  });

  return {
    sheetName:
      Array.from(snapshot.campaign.name.replace(/[\\/?*[\]:]/g, "-"))
        .slice(0, 28)
        .join("")
        .replace(/^'+|'+$/g, "") || "籌備時程規劃",
    colWidthsPx,
    rowHeightsPt,
    cells,
    merges,
    frozenRows: 4,
    frozenCols: 2,
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Generates Rich Clipboard HTML (`text/html`) so pressing `⌘V` / `Ctrl+V` inside Google Sheets or Excel
 * pastes colors, bold weights, borders, auto line-wrap, and all merged (`colspan`/`rowspan`) cells automatically.
 */
export function buildStyledSheetClipboardHtml(snapshot: CampaignSnapshot): string {
  const model = buildStyledSheetModel(snapshot);
  const covered = new Set<string>();
  const mergeLookup = new Map<string, { rowSpan: number; colSpan: number }>();

  for (const m of model.merges) {
    const rSpan = m.endRow - m.startRow + 1;
    const cSpan = m.endCol - m.startCol + 1;
    mergeLookup.set(`${m.startRow}:${m.startCol}`, { rowSpan: rSpan, colSpan: cSpan });
    for (let r = m.startRow; r <= m.endRow; r++) {
      for (let c = m.startCol; c <= m.endCol; c++) {
        if (r === m.startRow && c === m.startCol) continue;
        covered.add(`${r}:${c}`);
      }
    }
  }

  const colGroup = model.colWidthsPx.map((px) => `<col width="${px}" style="width:${px}px;" />`).join("");
  const trs = model.cells
    .map((row, rIdx) => {
      const tds = row
        .map((cell, cIdx) => {
          const key = `${rIdx}:${cIdx}`;
          if (covered.has(key)) return "";
          const span = mergeLookup.get(key);
          const spanAttrs = [
            span && span.rowSpan > 1 ? `rowspan="${span.rowSpan}"` : "",
            span && span.colSpan > 1 ? `colspan="${span.colSpan}"` : "",
          ]
            .filter(Boolean)
            .join(" ");
          const s = cell.style;
          const htmlText = escapeHtml(cell.value).replace(
            /\n/g,
            '<br style="mso-data-placement:same-cell;" />',
          );
          const endR = span ? rIdx + span.rowSpan - 1 : rIdx;
          const endC = span ? cIdx + span.colSpan - 1 : cIdx;
          const bTop = borderWeightCss(s.borders?.top);
          const bLeft = borderWeightCss(s.borders?.left);
          const bBottom = borderWeightCss(model.cells[endR]?.[cIdx]?.style.borders?.bottom);
          const bRight = borderWeightCss(model.cells[rIdx]?.[endC]?.style.borders?.right);
          const inlineCss = [
            `background-color:#${s.bg}`,
            `color:#${s.fg}`,
            `font-weight:${s.bold ? "700" : "400"}`,
            `font-size:${s.fontSize ?? 10}pt`,
            `font-family:'Noto Sans TC','PingFang TC',Arial,sans-serif`,
            `text-align:${s.align}`,
            `vertical-align:${s.valign}`,
            `white-space:pre-wrap`,
            `word-break:break-word`,
            `border-top:${bTop}`,
            `border-right:${bRight}`,
            `border-bottom:${bBottom}`,
            `border-left:${bLeft}`,
            `padding:6px 8px`,
            `width:${model.colWidthsPx[cIdx]}px`,
          ].join(";");
          return `<td ${spanAttrs} style="${inlineCss}">${htmlText}</td>`;
        })
        .join("");
      return `<tr style="height:${Math.round(model.rowHeightsPt[rIdx] * 1.33)}px;">${tds}</tr>`;
    })
    .join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8" /></head><body><table cellspacing="0" cellpadding="0" style="border-collapse:collapse;table-layout:fixed;">${colGroup}<tbody>${trs}</tbody></table></body></html>`;
}

/**
 * Generates a fast batch Google Apps Script (`syncBellCampaign`) that writes the entire schedule
 * to Google Sheets with exact column widths, row heights, reference color blocks, wrap, frozen panes, and cell merges.
 */
export function buildFormattedAppsScriptCode(snapshot: CampaignSnapshot): string {
  const model = buildStyledSheetModel(snapshot);
  const values = model.cells.map((r) => r.map((c) => c.value));
  const bgs = model.cells.map((r) => r.map((c) => `#${c.style.bg}`));
  const fgs = model.cells.map((r) => r.map((c) => `#${c.style.fg}`));
  const weights = model.cells.map((r) => r.map((c) => (c.style.bold ? "bold" : "normal")));
  const hAligns = model.cells.map((r) => r.map((c) => c.style.align));
  const vAligns = model.cells.map((r) => r.map((c) => c.style.valign));

  const orderedWeeks = [...snapshot.weeks].sort((a, b) => a.orderIndex - b.orderIndex);
  const monthEndOneBased: number[] = [];
  const eventColOneBased: number[] = [];
  for (let i = 0; i < orderedWeeks.length; i++) {
    if (i === orderedWeeks.length - 1 || orderedWeeks[i + 1].monthLabel !== orderedWeeks[i].monthLabel) {
      monthEndOneBased.push(3 + i);
    }
    if (orderedWeeks[i].phase === "event") eventColOneBased.push(3 + i);
  }
  const teamStartRowsOneBased: Array<{ start: number; end: number }> = [];
  for (const m of model.merges) {
    if (m.startCol === 0 && m.endCol === 0 && m.startRow >= 6) {
      teamStartRowsOneBased.push({ start: m.startRow + 1, end: m.endRow + 1 });
    }
  }

  return `/**
 * BELL Campaign → Google 試算表 完整格式一鍵建表腳本（含黑框匡線、粗體、色塊、欄寬與合併儲存格）
 * 使用方式：開啟目標 Google 試算表 →「擴充功能」→「Apps Script」貼上並執行 syncBellCampaign()
 */
function syncBellCampaign() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = ${JSON.stringify(model.sheetName)};
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  sheet.clear();
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();

  const values = ${JSON.stringify(values)};
  const bgs = ${JSON.stringify(bgs)};
  const fgs = ${JSON.stringify(fgs)};
  const weights = ${JSON.stringify(weights)};
  const hAligns = ${JSON.stringify(hAligns)};
  const vAligns = ${JSON.stringify(vAligns)};
  const colWidths = ${JSON.stringify(model.colWidthsPx)};
  const rowHeights = ${JSON.stringify(model.rowHeightsPt.map((pt) => Math.round(pt * 1.35)))};
  const merges = ${JSON.stringify(model.merges)};
  const monthEndCols = ${JSON.stringify(monthEndOneBased)};
  const eventCols = ${JSON.stringify(eventColOneBased)};
  const teamBlocks = ${JSON.stringify(teamStartRowsOneBased)};

  const numRows = values.length;
  const numCols = values[0].length;
  const range = sheet.getRange(1, 1, numRows, numCols);

  range.setValues(values);
  range.setBackgrounds(bgs);
  range.setFontColors(fgs);
  range.setFontWeights(weights);
  range.setHorizontalAlignments(hAligns);
  range.setVerticalAlignments(vAligns);
  range.setFontFamily("Noto Sans TC");
  range.setFontSize(10);
  range.setWrap(true);
  range.setBorder(true, true, true, true, true, true, "#E2E5EC", SpreadsheetApp.BorderStyle.SOLID);

  for (let r = 1; r <= 5; r++) {
    sheet.getRange(r, 1, 1, numCols).setBorder(null, null, true, null, null, null, "#000000", SpreadsheetApp.BorderStyle.SOLID);
  }
  sheet.getRange(6, 1, 1, numCols).setBorder(null, null, true, null, null, null, "#000000", SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sheet.getRange(1, 1, numRows, 1).setBorder(null, null, null, true, null, null, "#000000", SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange(1, 2, numRows, 1).setBorder(null, null, null, true, null, null, "#000000", SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  for (const mc of monthEndCols) {
    sheet.getRange(1, mc, numRows, 1).setBorder(null, null, null, true, null, null, "#000000", SpreadsheetApp.BorderStyle.SOLID);
  }
  for (const ec of eventCols) {
    sheet.getRange(1, ec, numRows, 1).setBorder(null, true, null, true, null, null, "#000000", SpreadsheetApp.BorderStyle.SOLID);
  }
  for (const tb of teamBlocks) {
    sheet.getRange(tb.start, 1, tb.end - tb.start + 1, numCols).setBorder(true, true, true, true, null, null, "#000000", SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  }
  range.setBorder(true, true, true, true, null, null, "#000000", SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  for (let c = 0; c < colWidths.length; c++) {
    sheet.setColumnWidth(c + 1, colWidths[c]);
  }
  for (let r = 0; r < rowHeights.length; r++) {
    sheet.setRowHeight(r + 1, rowHeights[r]);
  }
  for (const m of merges) {
    sheet.getRange(m.startRow + 1, m.startCol + 1, m.endRow - m.startRow + 1, m.endCol - m.startCol + 1).merge();
  }

  sheet.setFrozenRows(${model.frozenRows});
  sheet.setFrozenColumns(${model.frozenCols});
}`;
}

// ── 2. Editorial Visual Presentation Deck Model & Exporters ─────────────────

export interface DeckTeamCard {
  id: string;
  name: string;
  lead: string;
  color: TeamColor;
  headcount: number;
  done: number;
  total: number;
  percent: number;
  focusSummary: string;
  keyTodos: Array<{ weekLabel: string; title: string; done: boolean; priority: "normal" | "high" }>;
  crossNotes: string[];
}

export interface DeckMonthSlice {
  month: string;
  weekCount: number;
  dateSpan: string;
  goal: string;
  todoCount: number;
  highlights: string[];
}

export type DeckSlide =
  | {
      kind: "cover";
      indexLabel: string;
      tabLabel: string;
      kicker: string;
      title: string;
      subtitle: string;
      narrative: string;
      dateLabel: string;
      dateTentative: boolean;
      pacingLabel: string;
      pacingSummary: string;
      focusWeekLabel: string;
      focusWeekRange: string;
      kpis: Array<{ label: string; value: string; sub: string; tone: "brand" | "neutral" | "ok" | "warn" }>;
    }
  | {
      kind: "roadmap";
      indexLabel: string;
      tabLabel: string;
      kicker: string;
      title: string;
      subtitle: string;
      stageSpans: Array<{ stage: CellStage; weeks: number; range: string; hex: string }>;
      months: DeckMonthSlice[];
    }
  | {
      kind: "radar";
      indexLabel: string;
      tabLabel: string;
      kicker: string;
      title: string;
      subtitle: string;
      milestones: Array<{ countdown: string; dateRange: string; title: string; memo: string }>;
      conflicts: Array<{ countdown: string; dateRange: string; title: string; mitigation: string }>;
      loadBars: Array<{ label: string; score: number; hasConflict: boolean; isEvent: boolean }>;
    }
  | {
      kind: "teams";
      indexLabel: string;
      tabLabel: string;
      kicker: string;
      title: string;
      subtitle: string;
      pageInfo: string;
      teams: DeckTeamCard[];
    }
  | {
      kind: "ecosystem";
      indexLabel: string;
      tabLabel: string;
      kicker: string;
      title: string;
      subtitle: string;
      partnerGroups: Array<{ category: string; items: Array<{ name: string; org: string; role: string; status: string }> }>;
      meetingTitle: string;
      meetingDate: string;
      agendaItems: string[];
      precautionItems: string[];
    }
  | {
      kind: "matrix";
      indexLabel: string;
      tabLabel: string;
      kicker: string;
      title: string;
      subtitle: string;
      monthColumns: string[];
      rows: Array<{
        teamName: string;
        lead: string;
        color: TeamColor;
        cells: Array<{ focus: string; count: number; done: number }>;
      }>;
    };

export function buildSlidesDeckModel(snapshot: CampaignSnapshot): DeckSlide[] {
  const metrics = computeCampaignMetrics(snapshot);
  const orderedWeeks = [...snapshot.weeks].sort((a, b) => a.orderIndex - b.orderIndex);
  const orderedTeams = [...snapshot.teams].sort((a, b) => a.orderIndex - b.orderIndex);
  const weekMap = new Map(orderedWeeks.map((w) => [w.id, w]));
  const cellMap = new Map(snapshot.cells.map((c) => [`${c.weekId}:${c.teamId}`, c]));

  const prepWeeks = orderedWeeks.filter((w) => w.phase === "prep");
  const pacingMeta = PACING_META.find((p) => p.id === snapshot.campaign.pacing) ?? PACING_META[1];
  const activeWeek =
    orderedWeeks.find((w) => (metrics.weekProgress[w.id]?.percent ?? 0) < 100 && w.phase === "prep") ??
    orderedWeeks[0];

  const totalHeadcount = orderedTeams.reduce((s, t) => s + (t.targetHeadcount || 0), 0);
  const rawSlides: DeckSlide[] = [];

  // Slide 1: Cover & Positioning
  rawSlides.push({
    kind: "cover",
    indexLabel: "01",
    tabLabel: "專案總覽",
    kicker: "籌備簡報 · BRIEFING",
    title: snapshot.campaign.name,
    subtitle: snapshot.campaign.subtitle || "時程與各組分工總覽",
    narrative:
      snapshot.campaign.brief ||
      snapshot.campaign.mainGoal ||
      "對齊每週進度、避開撞期並鎖定驗收節點。",
    dateLabel: formatCampaignDateLabel(snapshot.campaign),
    dateTentative: snapshot.campaign.dateTentative,
    pacingLabel: pacingMeta.label,
    pacingSummary: pacingMeta.summary,
    focusWeekLabel: activeWeek?.countdownLabel ?? "籌備啟動",
    focusWeekRange: activeWeek?.dateRange ?? "",
    kpis: [
      {
        label: "待辦進度",
        value: `${metrics.overallPercent}%`,
        sub: `完成 ${metrics.completedTodos} / ${metrics.totalTodos} 項`,
        tone: "brand",
      },
      {
        label: "籌備週期",
        value: `${orderedWeeks.length} 週`,
        sub: `會前 ${prepWeeks.length} 週 · ${orderedWeeks[0]?.dateRange.split("~")[0] ?? ""} 起`,
        tone: "neutral",
      },
      {
        label: "團隊編制",
        value: `${orderedTeams.length} 組`,
        sub: `約 ${totalHeadcount} 人${snapshot.partners.length ? ` · ${snapshot.partners.length} 個合作單位` : ""}`,
        tone: "ok",
      },
      {
        label: "撞期時段",
        value: `${metrics.conflictWeekCount} 處`,
        sub: metrics.conflictWeekCount > 0 ? "已標記並避開重頭死線" : "無外部撞期",
        tone: metrics.conflictWeekCount > 0 ? "warn" : "ok",
      },
    ],
  });

  // Slide 2: Monthly Roadmap & Visual Phase Ribbon
  const stageSpans: Array<{ stage: CellStage; weeks: number; range: string; hex: string }> = [];
  let sIdx = 0;
  while (sIdx < orderedWeeks.length) {
    const st = orderedWeeks[sIdx].stage;
    let eIdx = sIdx;
    while (eIdx + 1 < orderedWeeks.length && orderedWeeks[eIdx + 1].stage === st) eIdx += 1;
    const startPart = orderedWeeks[sIdx].dateRange.split("~")[0] ?? orderedWeeks[sIdx].dateRange;
    const endPart = orderedWeeks[eIdx].dateRange.split("~")[1] ?? orderedWeeks[eIdx].dateRange;
    stageSpans.push({
      stage: st,
      weeks: eIdx - sIdx + 1,
      range: `${startPart}~${endPart}`,
      hex: `#${stageHex(st).bg}`,
    });
    sIdx = eIdx + 1;
  }

  const distinctMonths: string[] = [];
  for (const w of orderedWeeks) {
    if (!distinctMonths.includes(w.monthLabel)) distinctMonths.push(w.monthLabel);
  }
  const months: DeckMonthSlice[] = distinctMonths.slice(0, 6).map((mLabel, idx) => {
    const mWeeks = orderedWeeks.filter((w) => w.monthLabel === mLabel);
    const mWeekIds = new Set(mWeeks.map((w) => w.id));
    const mTodos = snapshot.todos.filter((t) => t.weekId && mWeekIds.has(t.weekId));
    const matchedGoal =
      snapshot.campaign.monthlyGoals.find(
        (g) => g.month === mLabel || mLabel.includes(g.month) || g.month.includes(mLabel),
      ) ?? snapshot.campaign.monthlyGoals[idx];
    const sDate = mWeeks[0]?.dateRange.split("~")[0] ?? "";
    const eDate = mWeeks.at(-1)?.dateRange.split("~")[1] ?? "";
    return {
      month: mLabel,
      weekCount: mWeeks.length,
      dateSpan: sDate && eDate ? `${sDate}~${eDate}` : "",
      goal: matchedGoal?.goal || mTodos[0]?.title || "推進當月交付",
      todoCount: mTodos.length,
      highlights: mTodos.slice(0, 3).map((t) => t.title),
    };
  });

  rawSlides.push({
    kind: "roadmap",
    indexLabel: "02",
    tabLabel: "跨月時程",
    kicker: "跨月時程 · ROADMAP",
    title: "各月重點與整體進度軸",
    subtitle: snapshot.campaign.mainGoal || "前段定規格、中段收交付、後段留驗收緩衝",
    stageSpans,
    months,
  });

  // Slide 3: Key Milestones, Collision Radar & Weekly Load Rhythm
  const milestones = orderedWeeks
    .flatMap((w) =>
      w.majorEvents
        .filter((e) => e.kind === "milestone")
        .map((e) => ({
          countdown: w.countdownLabel,
          dateRange: w.dateRange,
          title: e.title,
          memo: w.memo || `${w.monthLabel}檢核點`,
        })),
    )
    .slice(0, 6);

  const conflicts = orderedWeeks
    .flatMap((w) =>
      w.majorEvents
        .filter((e) => e.kind === "conflict")
        .map((e) => ({
          countdown: w.countdownLabel,
          dateRange: w.dateRange,
          title: e.title,
          mitigation: w.memo || "當週不排硬死線，重頭項目提前收齊",
        })),
    )
    .slice(0, 5);

  const loadBars = orderedWeeks.map((w) => {
    const count = snapshot.todos.filter((t) => t.weekId === w.id).length;
    const hasConflict = w.majorEvents.some((e) => e.kind === "conflict");
    const isEvent = w.phase === "event";
    const score = isEvent ? 88 : w.phase === "post" ? Math.max(28, count * 22) : Math.min(94, 18 + count * 15);
    return {
      label: w.countdownLabel.replace("倒數 ", "W-").replace(" 周", "").replace("暫定活動當周", "D-Day").replace("活動當周", "D-Day").replace("活動後 ", "W+"),
      score: hasConflict && !isEvent ? Math.min(44, score) : score,
      hasConflict,
      isEvent,
    };
  });

  rawSlides.push({
    kind: "radar",
    indexLabel: "03",
    tabLabel: "死線與撞期",
    kicker: "死線與撞期 · MILESTONES",
    title: "關鍵死線、撞期避開與每週負載",
    subtitle: "考週、連假與大型活動先標出來，重頭進度提前交",
    milestones,
    conflicts,
    loadBars,
  });

  // Slide 4..N: Paginated Team Breakdown (4 teams per slide for maximum legibility)
  const teamCards: DeckTeamCard[] = orderedTeams.map((team) => {
    const tp = metrics.teamProgress[team.id] ?? { done: 0, total: 0, percent: 0, latestStage: "待排" };
    const tTodos = snapshot.todos.filter((t) => t.teamId === team.id);
    const tCells = snapshot.cells.filter((c) => c.teamId === team.id);
    const distinctFocuses: string[] = [];
    for (const c of tCells) {
      const f = c.weeklyFocus.trim();
      if (f && !distinctFocuses.includes(f) && !f.includes("依排程推進")) distinctFocuses.push(f);
    }
    const crossNotes: string[] = [];
    for (const c of tCells) {
      const cr = c.crossTeam.trim();
      if (cr && !crossNotes.includes(cr)) crossNotes.push(cr);
    }
    return {
      id: team.id,
      name: team.name,
      lead: team.lead || "待定",
      color: team.color,
      headcount: team.targetHeadcount || 4,
      done: tp.done,
      total: tp.total,
      percent: tp.percent,
      focusSummary: distinctFocuses.slice(0, 2).join(" → ") || "各週待辦推進",
      keyTodos: tTodos.slice(0, 4).map((td) => ({
        weekLabel: (td.weekId && weekMap.get(td.weekId)?.countdownLabel) || "機動",
        title: td.title,
        done: td.done,
        priority: td.priority,
      })),
      crossNotes: crossNotes.slice(0, 2),
    };
  });

  const pageSize = 4;
  const totalTeamPages = Math.max(1, Math.ceil(teamCards.length / pageSize));
  for (let p = 0; p < totalTeamPages; p++) {
    const chunk = teamCards.slice(p * pageSize, (p + 1) * pageSize);
    rawSlides.push({
      kind: "teams",
      indexLabel: "",
      tabLabel: totalTeamPages > 1 ? `組別分工 (${p + 1}/${totalTeamPages})` : "組別分工",
      kicker: `組別分工 · TEAMS${totalTeamPages > 1 ? ` (${p + 1}/${totalTeamPages})` : ""}`,
      title: totalTeamPages > 1 ? `各組重點與跨組配合（${p + 1} / ${totalTeamPages}）` : "各組重點與跨組配合",
      subtitle: "負責人、關鍵待辦與跨組對接事項",
      pageInfo: `${p + 1} / ${totalTeamPages}`,
      teams: chunk,
    });
  }

  // Optional Ecosystem & Meeting Focus Slide (when partners or meetings exist)
  if (snapshot.partners.length > 0 || snapshot.meetings.length > 0) {
    const statusLabel: Record<string, string> = {
      prospect: "待接洽",
      contacting: "接洽中",
      confirmed: "已確認",
      briefed: "已對齊",
      completed: "已結案",
      declined: "婉拒",
    };
    const speakers = snapshot.partners.filter((p) => p.kind === "speaker");
    const vendors = snapshot.partners.filter((p) => p.kind === "vendor");
    const staffOrClubs = snapshot.partners.filter((p) => p.kind === "temp_staff");
    const partnerGroups = [
      ...(vendors.length
        ? [
            {
              category: `合作廠商（${vendors.length}）`,
              items: vendors.slice(0, 3).map((v) => ({
                name: v.name,
                org: v.organization,
                role: v.roleOrTopic,
                status: statusLabel[v.status] ?? v.status,
              })),
            },
          ]
        : []),
      ...(speakers.length
        ? [
            {
              category: `講師＆賽評（${speakers.length}）`,
              items: speakers.slice(0, 3).map((s) => ({
                name: s.name,
                org: s.organization,
                role: s.roleOrTopic,
                status: statusLabel[s.status] ?? s.status,
              })),
            },
          ]
        : []),
      ...(staffOrClubs.length
        ? [
            {
              category: `籌備社團＆支援（${staffOrClubs.length}）`,
              items: staffOrClubs.slice(0, 4).map((st) => ({
                name: st.name,
                org: st.organization,
                role: st.roleOrTopic,
                status: statusLabel[st.status] ?? st.status,
              })),
            },
          ]
        : []),
    ];

    const latestMeeting = snapshot.meetings[0];
    const splitClean = (raw: string | undefined, max: number) =>
      (raw ?? "")
        .split(/\n+/)
        .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
        .filter(Boolean)
        .slice(0, max);

    rawSlides.push({
      kind: "ecosystem",
      indexLabel: "",
      tabLabel: "合作與會議",
      kicker: "合作與會議 · ALIGNMENT",
      title: "合作名單與近期會議重點",
      subtitle: latestMeeting
        ? `最新會議：${latestMeeting.title}（${latestMeeting.meetingDate}）`
        : "合作單位、各校支援與待拍板事項",
      partnerGroups,
      meetingTitle: latestMeeting?.title ?? "近期會議重點",
      meetingDate: latestMeeting?.meetingDate ?? "",
      agendaItems: splitClean(latestMeeting?.agenda, 5),
      precautionItems: splitClean(latestMeeting?.precautions, 4),
    });
  }

  // Final Slide: Master Month × Team Bird's-Eye Matrix
  const monthColumns = distinctMonths.slice(0, 6);
  const matrixRows = orderedTeams.map((team) => {
    const rowCells = monthColumns.map((mLabel) => {
      const mWeeks = orderedWeeks.filter((w) => w.monthLabel === mLabel);
      const mWeekIds = new Set(mWeeks.map((w) => w.id));
      const mTodos = snapshot.todos.filter((t) => t.teamId === team.id && t.weekId && mWeekIds.has(t.weekId));
      const firstTodo = mTodos[0]?.title;
      const cellFocuses = mWeeks
        .map((w) => (cellMap.get(`${w.id}:${team.id}`)?.weeklyFocus ?? "").trim())
        .filter((f) => f && !f.includes("依排程推進"));
      const uniqueFocuses = [...new Set(cellFocuses)];
      const rawFocus = uniqueFocuses.length > 0 ? uniqueFocuses.slice(0, 2).join(" · ") : firstTodo || "—";
      const cleanFocus = rawFocus.length > 26 ? `${rawFocus.slice(0, 25)}…` : rawFocus;
      return {
        focus: cleanFocus,
        count: mTodos.length,
        done: mTodos.filter((t) => t.done).length,
      };
    });
    return {
      teamName: team.name,
      lead: team.lead || "待定",
      color: team.color,
      cells: rowCells,
    };
  });

  rawSlides.push({
    kind: "matrix",
    indexLabel: "",
    tabLabel: "跨月總表",
    kicker: "全期總覽 · MATRIX",
    title: "各組跨月交付一覽",
    subtitle: "一頁對齊各組每個月的重點產出",
    monthColumns,
    rows: matrixRows,
  });

  return rawSlides.map((s, idx) => ({
    ...s,
    indexLabel: String(idx + 1).padStart(2, "0"),
  }));
}

const DECK_TEAM_ACCENT: Record<TeamColor, string> = {
  rose: "#C93B6B",
  violet: "#6D5BD0",
  mint: "#2B8A66",
  amber: "#C87A19",
  sky: "#2E74B5",
  terracotta: "#C85A3B",
};

function renderSlideBodyHtml(slide: DeckSlide, campaignName: string, totalSlides: number): string {
  const footer = `<footer class="dk-foot">
    <span>${escapeHtml(campaignName)} · BELL Campaign Project Briefing</span>
    <span class="dk-mono">SLIDE ${escapeHtml(slide.indexLabel)} / ${String(totalSlides).padStart(2, "0")}</span>
  </footer>`;

  if (slide.kind === "cover") {
    const kpiHtml = slide.kpis
      .map(
        (k) => `<div class="dk-kpi dk-kpi-${k.tone}">
          <div class="dk-kpi-label">${escapeHtml(k.label)}</div>
          <div class="dk-kpi-val">${escapeHtml(k.value)}</div>
          <div class="dk-kpi-sub">${escapeHtml(k.sub)}</div>
        </div>`,
      )
      .join("");
    return `<section class="dk-slide">
      <div class="dk-cover-grid">
        <div class="dk-cover-main">
          <div>
            <span class="dk-kicker">${escapeHtml(slide.kicker)}</span>
            <h1 class="dk-hero-title">${escapeHtml(slide.title)}</h1>
            <p class="dk-hero-sub">${escapeHtml(slide.subtitle)}</p>
          </div>
          <div class="dk-narrative-box">
            <div class="dk-box-label">專案定位</div>
            <p>${escapeHtml(slide.narrative)}</p>
          </div>
          <div class="dk-meta-strip">
            <div class="dk-meta-pill">
              <span>舉辦時間</span>
              <strong>${escapeHtml(slide.dateLabel)}</strong>
            </div>
            <div class="dk-meta-pill">
              <span>排程節奏</span>
              <strong>${escapeHtml(slide.pacingLabel)}</strong>
            </div>
            <div class="dk-meta-pill">
              <span>當前週次</span>
              <strong>${escapeHtml(slide.focusWeekLabel)} ${escapeHtml(slide.focusWeekRange)}</strong>
            </div>
          </div>
        </div>
        <div class="dk-bento-2x2">${kpiHtml}</div>
      </div>
      ${footer}
    </section>`;
  }

  if (slide.kind === "roadmap") {
    const totalW = Math.max(1, slide.stageSpans.reduce((s, x) => s + x.weeks, 0));
    const ribbonSegs = slide.stageSpans
      .map((sp) => {
        const pct = ((sp.weeks / totalW) * 100).toFixed(2);
        return `<div class="dk-ribbon-seg" style="width:${pct}%;border-top:4px solid ${sp.hex};">
          <div class="dk-ribbon-stage" style="color:${sp.hex};">${escapeHtml(sp.stage)}</div>
          <div class="dk-ribbon-meta">${sp.weeks} 週 · ${escapeHtml(sp.range)}</div>
        </div>`;
      })
      .join("");
    const cols = Math.min(6, Math.max(2, slide.months.length));
    const monthCards = slide.months
      .map(
        (m, idx) => `<div class="dk-card">
          <div class="dk-card-top">
            <span class="dk-step-num">0${idx + 1}</span>
            <strong>${escapeHtml(m.month)}</strong>
            <span class="dk-pill-muted">${m.weekCount} 週 · ${m.todoCount} 項</span>
          </div>
          <p class="dk-month-goal">${escapeHtml(m.goal)}</p>
          ${
            m.highlights.length
              ? `<ul class="dk-mini-list">${m.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join("")}</ul>`
              : ""
          }
        </div>`,
      )
      .join("");
    return `<section class="dk-slide">
      <header class="dk-head">
        <span class="dk-kicker">${escapeHtml(slide.kicker)}</span>
        <h2>${escapeHtml(slide.title)}</h2>
        <p>${escapeHtml(slide.subtitle)}</p>
      </header>
      <div class="dk-ribbon">${ribbonSegs}</div>
      <div class="dk-grid" style="grid-template-columns:repeat(${cols},minmax(0,1fr));flex:1;">${monthCards}</div>
      ${footer}
    </section>`;
  }

  if (slide.kind === "radar") {
    const msHtml = slide.milestones.length
      ? slide.milestones
          .map(
            (m) => `<div class="dk-rail-item">
              <div class="dk-rail-tag">${escapeHtml(m.countdown)}<span>${escapeHtml(m.dateRange)}</span></div>
              <div class="dk-rail-body">
                <strong>${escapeHtml(m.title)}</strong>
                <span>${escapeHtml(m.memo)}</span>
              </div>
            </div>`,
          )
          .join("")
      : `<div class="dk-empty">尚無里程碑</div>`;

    const cfHtml = slide.conflicts.length
      ? slide.conflicts
          .map(
            (c) => `<div class="dk-conflict-card">
              <div class="dk-conflict-top">
                <span class="dk-warn-badge">撞期 · ${escapeHtml(c.countdown)}（${escapeHtml(c.dateRange)}）</span>
              </div>
              <strong>${escapeHtml(c.title)}</strong>
              <span>${escapeHtml(c.mitigation)}</span>
            </div>`,
          )
          .join("")
      : `<div class="dk-empty">目前無撞期</div>`;

    const barsHtml = slide.loadBars
      .map((b) => {
        const color = b.isEvent ? "var(--dk-brand)" : b.hasConflict ? "var(--dk-warn)" : "var(--dk-bar)";
        return `<div class="dk-bar-col">
          <div class="dk-bar-well"><div class="dk-bar-fill" style="height:${b.score}%;background:${color};"></div></div>
          <span>${escapeHtml(b.label)}</span>
        </div>`;
      })
      .join("");

    return `<section class="dk-slide">
      <header class="dk-head">
        <span class="dk-kicker">${escapeHtml(slide.kicker)}</span>
        <h2>${escapeHtml(slide.title)}</h2>
        <p>${escapeHtml(slide.subtitle)}</p>
      </header>
      <div class="dk-two-col" style="flex:1;">
        <div class="dk-card">
          <div class="dk-section-label">重要死線</div>
          <div class="dk-rail-list">${msHtml}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div class="dk-card" style="flex:1;">
            <div class="dk-section-label">撞期避開（考期／連假／大賽）</div>
            <div style="display:flex;flex-direction:column;gap:8px;">${cfHtml}</div>
          </div>
          <div class="dk-card">
            <div class="dk-section-label">每週負載節奏（橘色＝撞期降載）</div>
            <div class="dk-bars">${barsHtml}</div>
          </div>
        </div>
      </div>
      ${footer}
    </section>`;
  }

  if (slide.kind === "teams") {
    const cards = slide.teams
      .map((t) => {
        const accent = DECK_TEAM_ACCENT[t.color] ?? "#9E2B5C";
        const todos = t.keyTodos
          .map(
            (td) => `<li><span class="dk-wk-chip">${escapeHtml(td.weekLabel)}</span><span>${escapeHtml(td.title)}</span></li>`,
          )
          .join("");
        return `<div class="dk-card dk-team-card" style="border-top:3px solid ${accent};">
          <div class="dk-team-top">
            <div>
              <strong>${escapeHtml(t.name)}</strong>
              <span class="dk-team-meta">組長：${escapeHtml(t.lead)} · ${t.headcount} 人</span>
            </div>
            <span class="dk-pill-muted">${t.done}/${t.total} · ${t.percent}%</span>
          </div>
          <div class="dk-prog-track"><div class="dk-prog-fill" style="width:${Math.max(4, t.percent)}%;background:${accent};"></div></div>
          <ul class="dk-todo-list">${todos}</ul>
          ${
            t.crossNotes[0]
              ? `<div class="dk-cross-note">↔ 跨部：${escapeHtml(t.crossNotes[0])}</div>`
              : ""
          }
        </div>`;
      })
      .join("");
    return `<section class="dk-slide">
      <header class="dk-head">
        <span class="dk-kicker">${escapeHtml(slide.kicker)}</span>
        <h2>${escapeHtml(slide.title)}</h2>
        <p>${escapeHtml(slide.subtitle)}</p>
      </header>
      <div class="dk-bento-teams" style="flex:1;">${cards}</div>
      ${footer}
    </section>`;
  }

  if (slide.kind === "ecosystem") {
    const groupsHtml = slide.partnerGroups
      .map(
        (g) => `<div class="dk-partner-group">
          <div class="dk-section-label">${escapeHtml(g.category)}</div>
          <div class="dk-partner-items">
            ${g.items
              .map(
                (it) => `<div class="dk-partner-row">
                  <div>
                    <strong>${escapeHtml(it.name)}</strong>
                    <span>${escapeHtml(it.role || it.org)}</span>
                  </div>
                  <em class="dk-pill-muted">${escapeHtml(it.status)}</em>
                </div>`,
              )
              .join("")}
          </div>
        </div>`,
      )
      .join("");
    const agHtml = slide.agendaItems.map((a, i) => `<li><strong>0${i + 1}</strong><span>${escapeHtml(a)}</span></li>`).join("");
    const prHtml = slide.precautionItems.map((p) => `<li>${escapeHtml(p)}</li>`).join("");
    return `<section class="dk-slide">
      <header class="dk-head">
        <span class="dk-kicker">${escapeHtml(slide.kicker)}</span>
        <h2>${escapeHtml(slide.title)}</h2>
        <p>${escapeHtml(slide.subtitle)}</p>
      </header>
      <div class="dk-two-col" style="flex:1;">
        <div class="dk-card" style="display:flex;flex-direction:column;gap:12px;">
          ${groupsHtml || `<div class="dk-empty">尚無合作名單</div>`}
        </div>
        <div class="dk-card" style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <div class="dk-section-label">近期議程 · ${escapeHtml(slide.meetingDate)}</div>
            <strong style="font-size:15px;display:block;margin-bottom:8px;">${escapeHtml(slide.meetingTitle)}</strong>
            <ul class="dk-agenda-list">${agHtml}</ul>
          </div>
          ${
            prHtml
              ? `<div class="dk-precaution-box">
                  <div class="dk-section-label">注意＆防踩坑</div>
                  <ul class="dk-mini-list">${prHtml}</ul>
                </div>`
              : ""
          }
        </div>
      </div>
      ${footer}
    </section>`;
  }

  // Matrix slide
  const ths = slide.monthColumns.map((m) => `<th>${escapeHtml(m)}</th>`).join("");
  const trs = slide.rows
    .map((r) => {
      const accent = DECK_TEAM_ACCENT[r.color] ?? "#9E2B5C";
      const tds = r.cells
        .map(
          (c) => `<td>
            <div class="dk-mx-focus">${escapeHtml(c.focus)}</div>
            ${c.count > 0 ? `<span class="dk-mx-count">${c.done}/${c.count} 項</span>` : ""}
          </td>`,
        )
        .join("");
      return `<tr>
        <td><div class="dk-mx-team"><span class="dk-dot" style="background:${accent};"></span><div style="min-width:0;"><strong>${escapeHtml(r.teamName)}</strong><span>${escapeHtml(r.lead)}</span></div></div></td>
        ${tds}
      </tr>`;
    })
    .join("");

  return `<section class="dk-slide">
    <header class="dk-head">
      <span class="dk-kicker">${escapeHtml(slide.kicker)}</span>
      <h2>${escapeHtml(slide.title)}</h2>
      <p>${escapeHtml(slide.subtitle)}</p>
    </header>
    <div class="dk-mx-wrap" style="flex:1;">
      <table class="dk-mx-table">
        <thead><tr><th>組別 ／ 月份</th>${ths}</tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>
    ${footer}
  </section>`;
}

export const DECK_SHARED_CSS = `
.dk-root {
  --dk-paper: #FAF9F6;
  --dk-card: #FFFFFF;
  --dk-well: #F2F0EA;
  --dk-line: #E4E1D9;
  --dk-text-1: #14161B;
  --dk-text-2: #494E59;
  --dk-text-3: #5F6572;
  --dk-brand: #9E2B5C;
  --dk-brand-soft: #F9ECF1;
  --dk-brand-line: #E6BDCE;
  --dk-warn: #8A5200;
  --dk-warn-soft: #FDF3E4;
  --dk-ok: #26785A;
  --dk-bar: #9E2B5C;
  color: var(--dk-text-1);
  font-family: "Plus Jakarta Sans", "PingFang TC", "Noto Sans TC", "Hiragino Sans CNS", "Microsoft JhengHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.dk-root[data-deck-theme="dark"] {
  --dk-paper: #111318;
  --dk-card: #17191E;
  --dk-well: #14161B;
  --dk-line: #272B34;
  --dk-text-1: #F3F4F8;
  --dk-text-2: #B8BECC;
  --dk-text-3: #8A8F9A;
  --dk-brand: #E25B91;
  --dk-brand-soft: #2C1923;
  --dk-brand-line: rgba(242, 139, 180, .30);
  --dk-warn: #F5B851;
  --dk-warn-soft: #2D2314;
  --dk-ok: #46D992;
  --dk-bar: #E25B91;
}
.dk-slide {
  background: var(--dk-paper);
  border: 1px solid var(--dk-line);
  border-radius: 14px;
  padding: 28px 34px 20px;
  aspect-ratio: 16 / 9;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 16px;
  box-sizing: border-box;
  overflow: hidden;
}
.dk-kicker {
  display: inline-block;
  font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--dk-brand);
  background: var(--dk-brand-soft);
  border: 1px solid var(--dk-brand-line);
  padding: 3px 10px;
  border-radius: 999px;
}
.dk-head h2 { margin: 8px 0 3px; font-size: 22px; font-weight: 700; letter-spacing: -0.015em; line-height: 1.25; }
.dk-head p { margin: 0; font-size: 13px; color: var(--dk-text-2); }
.dk-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 10px;
  border-top: 1px solid var(--dk-line);
  font-size: 11px;
  color: var(--dk-text-3);
}
.dk-mono { font-family: "JetBrains Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; }
.dk-cover-grid { display: grid; grid-template-columns: 1.35fr 1fr; gap: 22px; flex: 1; align-items: stretch; }
.dk-cover-main { display: flex; flex-direction: column; justify-content: space-between; gap: 14px; }
.dk-hero-title { margin: 12px 0 6px; font-size: 34px; font-weight: 800; letter-spacing: -0.025em; line-height: 1.15; }
.dk-hero-sub { margin: 0; font-size: 15.5px; color: var(--dk-text-2); font-weight: 500; }
.dk-narrative-box {
  background: var(--dk-card);
  border: 1px solid var(--dk-line);
  border-left: 3px solid var(--dk-brand);
  border-radius: 10px;
  padding: 14px 16px;
}
.dk-box-label, .dk-section-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--dk-text-3);
  margin-bottom: 6px;
  text-transform: uppercase;
}
.dk-narrative-box p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dk-text-1); }
.dk-meta-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.dk-meta-pill { background: var(--dk-well); border: 1px solid var(--dk-line); border-radius: 9px; padding: 9px 12px; min-width: 0; }
.dk-meta-pill span { display: block; font-size: 11px; color: var(--dk-text-3); margin-bottom: 2px; }
.dk-meta-pill strong { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12.5px; font-weight: 700; line-height: 1.32; }
.dk-bento-2x2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.dk-kpi {
  background: var(--dk-card);
  border: 1px solid var(--dk-line);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.dk-kpi-brand { background: var(--dk-brand-soft); border-color: var(--dk-brand-line); }
.dk-kpi-warn { background: var(--dk-warn-soft); }
.dk-kpi-label { font-size: 12px; font-weight: 600; color: var(--dk-text-2); }
.dk-kpi-val { font-size: 30px; font-weight: 800; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; margin: 6px 0; }
.dk-kpi-brand .dk-kpi-val { color: var(--dk-brand); }
.dk-kpi-warn .dk-kpi-val { color: var(--dk-warn); }
.dk-kpi-sub { font-size: 11.5px; color: var(--dk-text-2); line-height: 1.4; }
.dk-ribbon {
  display: flex;
  gap: 6px;
  background: var(--dk-card);
  border: 1px solid var(--dk-line);
  border-radius: 10px;
  padding: 10px 12px;
}
.dk-ribbon-seg { min-width: 64px; padding-top: 6px; }
.dk-ribbon-stage { font-size: 12px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dk-ribbon-meta { font-size: 10.5px; color: var(--dk-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dk-grid { display: grid; gap: 12px; }
.dk-card {
  background: var(--dk-card);
  border: 1px solid var(--dk-line);
  border-radius: 11px;
  padding: 13px 15px;
  min-width: 0;
}
.dk-card-top { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.dk-step-num {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 11px;
  font-weight: 700;
  color: var(--dk-brand);
  background: var(--dk-brand-soft);
  padding: 2px 7px;
  border-radius: 6px;
}
.dk-pill-muted {
  margin-left: auto;
  font-size: 11px;
  font-style: normal;
  color: var(--dk-text-2);
  background: var(--dk-well);
  border: 1px solid var(--dk-line);
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}
.dk-month-goal { margin: 0 0 8px; font-size: 12.5px; font-weight: 600; line-height: 1.5; color: var(--dk-text-1); }
.dk-mini-list { margin: 0; padding-left: 15px; font-size: 11.5px; color: var(--dk-text-2); line-height: 1.5; display: flex; flex-direction: column; gap: 3px; }
.dk-two-col { display: grid; grid-template-columns: 1.05fr 1fr; gap: 14px; min-height: 0; }
.dk-rail-list { display: flex; flex-direction: column; gap: 8px; }
.dk-rail-item { display: grid; grid-template-columns: 98px 1fr; gap: 10px; align-items: start; padding-bottom: 7px; border-bottom: 1px dashed var(--dk-line); }
.dk-rail-item:last-child { border-bottom: none; padding-bottom: 0; }
.dk-rail-tag { font-size: 11.5px; font-weight: 700; color: var(--dk-brand); }
.dk-rail-tag span { display: block; font-size: 10.5px; font-weight: 500; color: var(--dk-text-3); font-variant-numeric: tabular-nums; }
.dk-rail-body strong { display: block; font-size: 12.5px; line-height: 1.35; }
.dk-rail-body span { display: block; font-size: 11px; color: var(--dk-text-3); margin-top: 1px; }
.dk-conflict-card { background: var(--dk-warn-soft); border: 1px solid var(--dk-line); border-radius: 8px; padding: 8px 11px; }
.dk-warn-badge { font-size: 10.5px; font-weight: 700; color: var(--dk-warn); }
.dk-conflict-card strong { display: block; font-size: 12.5px; margin-top: 2px; }
.dk-conflict-card span { display: block; font-size: 11px; color: var(--dk-text-2); margin-top: 1px; }
.dk-bars { display: flex; align-items: flex-end; gap: 4px; height: 68px; padding-top: 6px; }
.dk-bar-col { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 3px; height: 100%; }
.dk-bar-well { flex: 1; width: 100%; background: var(--dk-well); border-radius: 4px; display: flex; align-items: flex-end; overflow: hidden; }
.dk-bar-fill { width: 100%; border-radius: 4px 4px 0 0; }
.dk-bar-col span { font-size: 9px; color: var(--dk-text-3); font-family: "JetBrains Mono", monospace; white-space: nowrap; }
.dk-bento-teams { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-content: stretch; }
.dk-team-card { display: flex; flex-direction: column; gap: 7px; }
.dk-team-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.dk-team-top strong { display: block; font-size: 14.5px; }
.dk-team-meta { display: block; font-size: 11px; color: var(--dk-text-3); margin-top: 1px; }
.dk-prog-track { height: 5px; background: var(--dk-well); border-radius: 999px; overflow: hidden; }
.dk-prog-fill { height: 100%; border-radius: 999px; }
.dk-todo-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; line-height: 1.4; }
.dk-todo-list li { display: flex; align-items: baseline; gap: 6px; }
.dk-wk-chip {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: var(--dk-brand);
  background: var(--dk-brand-soft);
  padding: 1px 6px;
  border-radius: 4px;
  font-variant-numeric: tabular-nums;
}
.dk-cross-note {
  margin-top: auto;
  padding-top: 5px;
  border-top: 1px dashed var(--dk-line);
  font-size: 11px;
  font-weight: 600;
  color: var(--dk-brand);
}
.dk-partner-group { display: flex; flex-direction: column; gap: 4px; }
.dk-partner-items { display: flex; flex-direction: column; gap: 4px; }
.dk-partner-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 4px 9px;
  background: var(--dk-well);
  border-radius: 7px;
}
.dk-partner-row strong { display: block; font-size: 12px; }
.dk-partner-row span { display: block; font-size: 10.5px; color: var(--dk-text-2); }
.dk-agenda-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.dk-agenda-list li { display: flex; gap: 8px; align-items: baseline; line-height: 1.45; }
.dk-agenda-list li strong { font-family: "JetBrains Mono", monospace; font-size: 10.5px; color: var(--dk-brand); }
.dk-precaution-box { margin-top: auto; background: var(--dk-warn-soft); border: 1px solid var(--dk-line); border-radius: 8px; padding: 9px 12px; }
.dk-mx-wrap { background: var(--dk-card); border: 1px solid var(--dk-line); border-radius: 10px; overflow: hidden; }
.dk-mx-table { width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed; }
.dk-mx-table th, .dk-mx-table td { border-bottom: 1px solid var(--dk-line); border-right: 1px solid var(--dk-line); padding: 4px 8px; text-align: left; vertical-align: middle; }
.dk-mx-table th { background: var(--dk-well); font-weight: 700; font-size: 11px; color: var(--dk-text-2); padding: 5px 8px; }
.dk-mx-table th:first-child, .dk-mx-table td:first-child { width: 162px; }
.dk-mx-team { display: flex; align-items: center; gap: 7px; }
.dk-dot { width: 8px; height: 8px; border-radius: 999px; flex-shrink: 0; }
.dk-mx-team strong { display: block; font-size: 11.5px; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dk-mx-team span { display: block; font-size: 9.5px; line-height: 1.2; color: var(--dk-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dk-mx-focus { font-weight: 600; line-height: 1.26; color: var(--dk-text-1); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dk-mx-count { display: block; margin-top: 1px; font-size: 9.5px; line-height: 1.15; color: var(--dk-text-3); font-variant-numeric: tabular-nums; }
.dk-empty { font-size: 12px; color: var(--dk-text-3); padding: 8px 0; }
`;

export function renderSingleSlideHtml(slide: DeckSlide, campaignName: string, totalSlides: number): string {
  return renderSlideBodyHtml(slide, campaignName, totalSlides);
}

/**
 * Generates a standalone, offline-ready, print-to-16:9-PDF editorial presentation deck (`.html`).
 */
export function buildStandalonePresentationHtml(
  snapshot: CampaignSnapshot,
  theme: "light" | "dark" = "light",
): string {
  const slides = buildSlidesDeckModel(snapshot);
  const slidesMarkup = slides
    .map(
      (s, idx) =>
        `<div class="deck-frame" data-slide-idx="${idx}">${renderSlideBodyHtml(s, snapshot.campaign.name, slides.length)}</div>`,
    )
    .join("\n");

  const navPills = slides
    .map(
      (s, idx) =>
        `<button type="button" class="nav-pill${idx === 0 ? " is-active" : ""}" data-go="${idx}">${escapeHtml(s.indexLabel)} · ${escapeHtml(s.tabLabel)}</button>`,
    )
    .join("");

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(snapshot.campaign.name)} · 專案簡報 Deck</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;700&family=Noto+Sans+TC:wght@400;500;700;800&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #E7E4DC; color: #14161B; font-family: "Plus Jakarta Sans", "PingFang TC", "Noto Sans TC", sans-serif; }
  body[data-bg="dark"] { background: #090B10; color: #F3F4F8; }
  .deck-toolbar {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    padding: 10px 20px; background: rgba(250,249,246,0.95); border-bottom: 1px solid #D8D4CA;
  }
  body[data-bg="dark"] .deck-toolbar { background: rgba(18,20,28,0.96); border-bottom-color: #282D3E; }
  .nav-pills { display: flex; gap: 6px; flex-wrap: wrap; }
  .nav-pill, .tool-btn {
    appearance: none; border: 1px solid #D4D0C6; background: #FFFFFF; color: #2B2F38;
    border-radius: 999px; padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  body[data-bg="dark"] .nav-pill, body[data-bg="dark"] .tool-btn { background: #191C27; border-color: #2E3447; color: #E5E8F0; }
  .nav-pill.is-active, .tool-btn.primary { background: #9E2B5C; border-color: #9E2B5C; color: #FFFFFF; }
  .deck-stage { max-width: 1220px; margin: 22px auto 40px; padding: 0 20px; display: flex; flex-direction: column; gap: 28px; }
  body[data-mode="single"] .deck-frame { display: none; }
  body[data-mode="single"] .deck-frame.is-current { display: block; }
  ${DECK_SHARED_CSS}
  @page { size: 1280px 720px; margin: 0; }
  @media print {
    body { background: #FFFFFF !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .deck-toolbar { display: none !important; }
    .deck-stage { max-width: none; margin: 0; padding: 0; gap: 0; }
    .deck-frame { display: block !important; page-break-after: always; break-after: page; width: 1280px; height: 720px; }
    .deck-frame:last-child { page-break-after: auto; break-after: auto; }
    .dk-slide { width: 1280px; height: 720px; border-radius: 0; border: none; }
  }
</style>
</head>
<body data-bg="${theme}" data-mode="single">
  <div class="deck-toolbar">
    <div class="nav-pills">${navPills}</div>
    <div style="display:flex;gap:8px;align-items:center;">
      <button type="button" class="tool-btn" id="btnMode">切換長卷瀏覽</button>
      <button type="button" class="tool-btn" id="btnTheme">深淺主題</button>
      <button type="button" class="tool-btn primary" id="btnPrint">列印 ／ 存為 16:9 PDF</button>
    </div>
  </div>
  <main class="deck-stage dk-root" id="deckRoot" data-deck-theme="${theme}">
    ${slidesMarkup}
  </main>
  <script>
    (function(){
      var cur = 0;
      var frames = Array.prototype.slice.call(document.querySelectorAll('.deck-frame'));
      var pills = Array.prototype.slice.call(document.querySelectorAll('.nav-pill'));
      function show(idx) {
        cur = (idx + frames.length) % frames.length;
        frames.forEach(function(f, i){ f.classList.toggle('is-current', i === cur); });
        pills.forEach(function(p, i){ p.classList.toggle('is-active', i === cur); });
      }
      pills.forEach(function(p){
        p.addEventListener('click', function(){ show(Number(p.getAttribute('data-go') || 0)); });
      });
      document.addEventListener('keydown', function(e){
        if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); show(cur + 1); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); show(cur - 1); }
      });
      document.getElementById('btnMode').addEventListener('click', function(e){
        var b = document.body;
        var next = b.getAttribute('data-mode') === 'single' ? 'scroll' : 'single';
        b.setAttribute('data-mode', next);
        e.target.textContent = next === 'single' ? '切換長卷瀏覽' : '切換單頁投影片';
      });
      document.getElementById('btnTheme').addEventListener('click', function(){
        var root = document.getElementById('deckRoot');
        var next = root.getAttribute('data-deck-theme') === 'light' ? 'dark' : 'light';
        root.setAttribute('data-deck-theme', next);
        document.body.setAttribute('data-bg', next);
      });
      document.getElementById('btnPrint').addEventListener('click', function(){ window.print(); });
      show(0);
    })();
  </script>
</body>
</html>`;
}

/**
 * Generates a Google Slides Apps Script (`buildBellSlides`) so users who want native editable
 * Google Slides textboxes & cards can generate the full multi-slide deck in 1 click.
 */
export function buildGoogleSlidesAppsScript(snapshot: CampaignSnapshot): string {
  const slides = buildSlidesDeckModel(snapshot);
  return `/**
 * BELL Campaign → Google 簡報 (Google Slides) 自動生成腳本
 * 使用方式：開啟一份 Google 簡報 →「擴充功能」→「Apps Script」貼上並執行 buildBellSlides()
 */
function buildBellSlides() {
  const deck = SlidesApp.getActivePresentation();
  const data = ${JSON.stringify(slides)};
  while (deck.getSlides().length > 0) { deck.getSlides()[0].remove(); }

  data.forEach(function(s) {
    const slide = deck.appendSlide(SlidesApp.PredefinedLayout.BLANK);
    slide.getBackground().setSolidFill("#FAF9F6");

    const kicker = slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE, 36, 24, 290, 22);
    kicker.getFill().setSolidFill("#F9ECF1");
    kicker.getBorder().getLineFill().setSolidFill("#E6BDCE");
    kicker.getText().setText(s.kicker).getTextStyle().setFontSize(9).setBold(true).setForegroundColor("#9E2B5C");

    const titleBox = slide.insertTextBox(s.title, 36, 50, 648, 36);
    titleBox.getText().getTextStyle().setFontSize(20).setBold(true).setForegroundColor("#14161B");

    if (s.kind === "cover") {
      const narr = slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE, 36, 102, 380, 145);
      narr.getFill().setSolidFill("#FFFFFF");
      narr.getBorder().getLineFill().setSolidFill("#E4E1D9");
      narr.getText().setText(s.subtitle + "\\n\\n" + s.narrative + "\\n\\n舉辦時程：" + s.dateLabel + " ｜ 節奏：" + s.pacingLabel)
        .getTextStyle().setFontSize(11).setForegroundColor("#2B2F38");

      s.kpis.forEach(function(k, idx) {
        const col = idx % 2, row = Math.floor(idx / 2);
        const card = slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE, 432 + col * 128, 102 + row * 116, 120, 106);
        card.getFill().setSolidFill(idx === 0 ? "#F9ECF1" : "#FFFFFF");
        card.getBorder().getLineFill().setSolidFill("#E4E1D9");
        card.getText().setText(k.label + "\\n" + k.value + "\\n" + k.sub)
          .getTextStyle().setFontSize(10).setBold(true).setForegroundColor("#14161B");
      });
    } else if (s.kind === "roadmap") {
      s.months.slice(0, 4).forEach(function(m, idx) {
        const card = slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE, 36 + idx * 164, 105, 154, 255);
        card.getFill().setSolidFill("#FFFFFF");
        card.getBorder().getLineFill().setSolidFill("#E4E1D9");
        const body = "【" + m.month + "】(" + m.todoCount + "項)\\n\\n" + m.goal + (m.highlights.length ? "\\n\\n• " + m.highlights.join("\\n• ") : "");
        card.getText().setText(body).getTextStyle().setFontSize(9.5).setForegroundColor("#22252C");
      });
    } else if (s.kind === "radar") {
      const left = slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE, 36, 102, 315, 260);
      left.getFill().setSolidFill("#FFFFFF");
      left.getBorder().getLineFill().setSolidFill("#E4E1D9");
      left.getText().setText("▸ 關鍵檢核里程碑\\n\\n" + s.milestones.map(function(m){ return "• " + m.countdown + " (" + m.dateRange + ") " + m.title; }).join("\\n\\n"))
        .getTextStyle().setFontSize(10).setForegroundColor("#14161B");

      const right = slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE, 366, 102, 318, 260);
      right.getFill().setSolidFill("#FDF3E4");
      right.getBorder().getLineFill().setSolidFill("#E4E1D9");
      right.getText().setText("▸ 外部撞期避開雷達\\n\\n" + s.conflicts.map(function(c){ return "⚠️ " + c.countdown + " (" + c.dateRange + ")\\n" + c.title; }).join("\\n\\n"))
        .getTextStyle().setFontSize(10).setForegroundColor("#5A3408");
    } else if (s.kind === "teams") {
      s.teams.forEach(function(t, idx) {
        const col = idx % 2, row = Math.floor(idx / 2);
        const card = slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE, 36 + col * 330, 98 + row * 136, 318, 126);
        card.getFill().setSolidFill("#FFFFFF");
        card.getBorder().getLineFill().setSolidFill("#E4E1D9");
        const lines = t.keyTodos.slice(0, 3).map(function(td){ return "[" + td.weekLabel + "] " + td.title; }).join("\\n");
        card.getText().setText(t.name + "（負責人：" + t.lead + " · " + t.done + "/" + t.total + "）\\n" + lines)
          .getTextStyle().setFontSize(9).setForegroundColor("#1E222B");
      });
    } else if (s.kind === "ecosystem") {
      const left = slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE, 36, 102, 315, 260);
      left.getFill().setSolidFill("#FFFFFF");
      left.getBorder().getLineFill().setSolidFill("#E4E1D9");
      const pText = s.partnerGroups.map(function(g){ return g.category + "\\n" + g.items.map(function(i){ return "• " + i.name + " — " + i.status; }).join("\\n"); }).join("\\n\\n");
      left.getText().setText(pText || "合作名單規劃中").getTextStyle().setFontSize(9.5).setForegroundColor("#14161B");

      const right = slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE, 366, 102, 318, 260);
      right.getFill().setSolidFill("#FFFFFF");
      right.getBorder().getLineFill().setSolidFill("#E4E1D9");
      right.getText().setText(s.meetingTitle + " (" + s.meetingDate + ")\\n\\n• " + s.agendaItems.join("\\n• "))
        .getTextStyle().setFontSize(9.5).setForegroundColor("#14161B");
    } else if (s.kind === "matrix") {
      const rows = Math.min(9, s.rows.length + 1);
      const cols = Math.min(7, s.monthColumns.length + 1);
      const table = slide.insertTable(rows, cols, 36, 100, 648, 260);
      table.getCell(0, 0).getText().setText("組別／月份").getTextStyle().setFontSize(9).setBold(true);
      for (var c = 0; c < cols - 1; c++) {
        table.getCell(0, c + 1).getText().setText(s.monthColumns[c]).getTextStyle().setFontSize(9).setBold(true);
      }
      for (var r = 0; r < rows - 1; r++) {
        table.getCell(r + 1, 0).getText().setText(s.rows[r].teamName).getTextStyle().setFontSize(8.5).setBold(true);
        for (var mc = 0; mc < cols - 1; mc++) {
          table.getCell(r + 1, mc + 1).getText().setText(s.rows[r].cells[mc].focus).getTextStyle().setFontSize(8);
        }
      }
    }
  });
}`;
}
