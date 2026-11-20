import { deflateRawSync } from "node:zlib";
import type { CampaignSnapshot } from "../shared/types.js";
import {
  buildStyledSheetModel,
  type BorderWeight,
  type SheetCellBorders,
  type SheetCellStyle,
} from "../shared/exporters.js";

// Precomputed IEEE 802.3 CRC-32 table for standard ZIP archive headers
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZipBuffer(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const uncompressed = entry.data;
    const compressed = deflateRawSync(uncompressed, { level: 6 });
    const sum = crc32(uncompressed);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed 2.0
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(8, 8); // DEFLATE
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x21, 12);
    localHeader.writeUInt32LE(sum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    localParts.push(localHeader, compressed);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(sum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + compressed.length;
  }

  const centralSize = centralParts.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function colIndexToLetters(colIdx: number): string {
  let n = colIdx + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function xmlEscape(raw: string): string {
  return raw
    // Preserve valid surrogate pairs while stripping C0 controls, XML 1.0 noncharacters, and lone surrogates
    .replace(
      /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/g,
      (m) => (m.length === 2 ? m : ""),
    )
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generates a native OpenXML `.xlsx` spreadsheet buffer with colors, generous column widths,
 * row heights, wrapped text, frozen panes, and automatic cell merges ready for Google Sheets / Excel.
 */
export function buildCampaignXlsxBuffer(snapshot: CampaignSnapshot): Buffer {
  const model = buildStyledSheetModel(snapshot);

  // Deduplicate fills (OpenXML requires index 0 = none, index 1 = gray125)
  const fillXmls: string[] = [
    `<fill><patternFill patternType="none"/></fill>`,
    `<fill><patternFill patternType="gray125"/></fill>`,
  ];
  const fillMap = new Map<string, number>();
  const getFillId = (hex6: string): number => {
    const key = hex6.toUpperCase();
    const existing = fillMap.get(key);
    if (existing !== undefined) return existing;
    const id = fillXmls.length;
    fillXmls.push(
      `<fill><patternFill patternType="solid"><fgColor rgb="FF${key}"/><bgColor indexed="64"/></patternFill></fill>`,
    );
    fillMap.set(key, id);
    return id;
  };

  // Deduplicate fonts (index 0 = default font)
  const fontXmls: string[] = [
    `<font><sz val="10"/><color rgb="FF222222"/><name val="Noto Sans TC"/></font>`,
  ];
  const fontMap = new Map<string, number>();
  const getFontId = (bold: boolean, sz: number, fgHex: string): number => {
    const key = `${bold ? 1 : 0}:${sz}:${fgHex.toUpperCase()}`;
    const existing = fontMap.get(key);
    if (existing !== undefined) return existing;
    const id = fontXmls.length;
    fontXmls.push(
      `<font>${bold ? "<b/>" : ""}<sz val="${sz}"/><color rgb="FF${fgHex.toUpperCase()}"/><name val="Noto Sans TC"/></font>`,
    );
    fontMap.set(key, id);
    return id;
  };

  // Deduplicate borders (index 0 = none)
  const borderSideXml = (tag: "left" | "right" | "top" | "bottom", w: BorderWeight | undefined): string => {
    const bw = w ?? "grid";
    if (bw === "none") return `<${tag}/>`;
    if (bw === "box_strong") return `<${tag} style="medium"><color rgb="FF000000"/></${tag}>`;
    if (bw === "box") return `<${tag} style="thin"><color rgb="FF000000"/></${tag}>`;
    return `<${tag} style="thin"><color rgb="FFE2E5EC"/></${tag}>`;
  };
  const borderXmls: string[] = [`<border><left/><right/><top/><bottom/><diagonal/></border>`];
  const borderMap = new Map<string, number>();
  const getBorderId = (b: SheetCellBorders | undefined): number => {
    const top = b?.top ?? "grid";
    const right = b?.right ?? "grid";
    const bottom = b?.bottom ?? "grid";
    const left = b?.left ?? "grid";
    if (top === "none" && right === "none" && bottom === "none" && left === "none") return 0;
    const key = `${left}:${right}:${top}:${bottom}`;
    const existing = borderMap.get(key);
    if (existing !== undefined) return existing;
    const id = borderXmls.length;
    borderXmls.push(
      `<border>${borderSideXml("left", left)}${borderSideXml("right", right)}${borderSideXml("top", top)}${borderSideXml("bottom", bottom)}<diagonal/></border>`,
    );
    borderMap.set(key, id);
    return id;
  };

  // Deduplicate cellXfs (index 0 = base)
  const xfXmls: string[] = [
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`,
  ];
  const xfMap = new Map<string, number>();
  const getXfId = (s: SheetCellStyle): number => {
    const fillId = s.bg.toUpperCase() === "FFFFFF" ? 0 : getFillId(s.bg);
    const fontId = getFontId(s.bold, s.fontSize ?? 10, s.fg);
    const borderId = getBorderId(s.borders);
    const vAlign = s.valign === "middle" ? "center" : "top";
    const key = `${fontId}:${fillId}:${borderId}:${s.align}:${vAlign}`;
    const existing = xfMap.get(key);
    if (existing !== undefined) return existing;
    const id = xfXmls.length;
    xfXmls.push(
      `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="1" applyFill="${fillId > 0 ? 1 : 0}" applyBorder="1" applyAlignment="1"><alignment horizontal="${s.align}" vertical="${vAlign}" wrapText="1"/></xf>`,
    );
    xfMap.set(key, id);
    return id;
  };

  const colsXml = model.colWidthsPx
    .map((px, idx) => {
      const charWidth = (px / 7.2).toFixed(2);
      return `<col min="${idx + 1}" max="${idx + 1}" width="${charWidth}" customWidth="1"/>`;
    })
    .join("");

  const rowsXml = model.cells
    .map((row, rIdx) => {
      const rNum = rIdx + 1;
      const ht = model.rowHeightsPt[rIdx]?.toFixed(1) ?? "24.0";
      const cellsXml = row
        .map((cell, cIdx) => {
          const ref = `${colIndexToLetters(cIdx)}${rNum}`;
          const xf = getXfId(cell.style);
          if (!cell.value) return `<c r="${ref}" s="${xf}"/>`;
          return `<c r="${ref}" s="${xf}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell.value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rNum}" ht="${ht}" customHeight="1">${cellsXml}</row>`;
    })
    .join("");

  const mergesXml =
    model.merges.length > 0
      ? `<mergeCells count="${model.merges.length}">${model.merges
          .map(
            (m) =>
              `<mergeCell ref="${colIndexToLetters(m.startCol)}${m.startRow + 1}:${colIndexToLetters(m.endCol)}${m.endRow + 1}"/>`,
          )
          .join("")}</mergeCells>`
      : "";

  const topLeftFrozen = `${colIndexToLetters(model.frozenCols)}${model.frozenRows + 1}`;
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView tabSelected="1" workbookViewId="0">
      <pane xSplit="${model.frozenCols}" ySplit="${model.frozenRows}" topLeftCell="${topLeftFrozen}" activePane="bottomRight" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="24"/>
  <cols>${colsXml}</cols>
  <sheetData>${rowsXml}</sheetData>
  ${mergesXml}
</worksheet>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="${fontXmls.length}">${fontXmls.join("")}</fonts>
  <fills count="${fillXmls.length}">${fillXmls.join("")}</fills>
  <borders count="${borderXmls.length}">${borderXmls.join("")}</borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="${xfXmls.length}">${xfXmls.join("")}</cellXfs>
</styleSheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${xmlEscape(model.sheetName)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  return buildZipBuffer([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypesXml, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRelsXml, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbookXml, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRelsXml, "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(stylesXml, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheetXml, "utf8") },
  ]);
}
