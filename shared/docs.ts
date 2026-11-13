import type {
  CampaignInspiration,
  CampaignMeeting,
  MeetingDocSource,
} from "./types.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripSimpleHtml(raw: string): string {
  if (!/<(html|body|h[1-6]|p|div|ul|ol|li|br)\b/i.test(raw)) return raw;
  return raw
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

export function detectDocSourceFromUrl(url: string): MeetingDocSource {
  const clean = url.trim().toLowerCase();
  if (!clean) return "";
  if (clean.includes("hackmd.io")) return "hackmd";
  if (clean.includes("docs.google.com/document")) return "gdoc";
  return "markdown";
}

export interface ParsedMeetingFields {
  title: string;
  meetingDate: string;
  attendees: string;
  agenda: string;
  arrangements: string;
  precautions: string;
  decisions: string;
}

/**
 * Parses Google Docs plain-text/HTML export or HackMD Markdown (including YAML frontmatter)
 * into structured CampaignMeeting fields, and round-trips cleanly with meetingToHackMd / meetingToGoogleDocHtml.
 */
export function parseMeetingDoc(rawInput: string, fallbackDate?: string): ParsedMeetingFields {
  let text = stripSimpleHtml(rawInput).replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "").trim();
  let title = "";
  let meetingDate = fallbackDate || `${new Date().toISOString().slice(0, 10)} 20:30`;
  let attendees = "";

  // Extract optional HackMD YAML frontmatter
  if (text.startsWith("---\n")) {
    const endIdx = text.indexOf("\n---", 4);
    if (endIdx > 0) {
      const fm = text.slice(4, endIdx);
      const titleMatch = /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm);
      if (titleMatch) title = titleMatch[1].trim();
      const dateMatch = /^date:\s*["']?(.+?)["']?\s*$/m.exec(fm);
      if (dateMatch) meetingDate = dateMatch[1].trim();
      text = text.slice(endIdx + 4).trim();
    }
  }

  const lines = text.split("\n");
  type Bucket = "preamble" | "agenda" | "arrangements" | "precautions" | "decisions";
  let bucket: Bucket = "preamble";
  const buckets: Record<Bucket, string[]> = {
    preamble: [],
    agenda: [],
    arrangements: [],
    precautions: [],
    decisions: [],
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    // H1 or first prominent title line
    const h1 = /^#\s+(.+)$/.exec(trimmed);
    if (h1 && !title) {
      title = h1[1].trim();
      continue;
    }

    // Metadata lines near top (時間 / 日期 / 與會 / 出席)
    const dateMeta = /^(?:[-*•]\s*)?(?:\*\*)?(?:開會時間|會議時間|時間|日期|Date|Time)(?:\*\*)?\s*[:：]\s*(.+)$/i.exec(
      trimmed,
    );
    if (dateMeta && bucket === "preamble") {
      meetingDate = dateMeta[1].replace(/\*\*/g, "").trim();
      continue;
    }

    const attendeeMeta = /^(?:[-*•]\s*)?(?:\*\*)?(?:與會組別[／/]?人員|與會人員|與會組別|與會|出席人員|出席|Attendees)(?:\*\*)?\s*[:：]\s*(.+)$/i.exec(
      trimmed,
    );
    if (attendeeMeta && bucket === "preamble") {
      attendees = attendeeMeta[1].replace(/\*\*/g, "").trim();
      continue;
    }

    // Section headings (Markdown ##/### or Google Docs plain headings like "一、會前大綱")
    const headingMatch =
      /^(?:#{2,4}\s*|[一二三四五六1-6][、.]\s*|【)(.+?)(?:】)?\s*[:：]?$/.exec(trimmed);
    if (headingMatch && trimmed.length <= 42) {
      const h = headingMatch[1];
      if (/大綱|議題|討論事項|agenda/i.test(h)) {
        bucket = "agenda";
        continue;
      }
      if (/安排|議程|流程|時程|順序|schedule|flow/i.test(h)) {
        bucket = "arrangements";
        continue;
      }
      if (/注意|提醒|風險|撞期|準備|precaution|note|risk/i.test(h)) {
        bucket = "precautions";
        continue;
      }
      if (/決議|結論|待辦|行動|追蹤|decision|action|todo/i.test(h)) {
        bucket = "decisions";
        continue;
      }
    }

    buckets[bucket].push(line);
  }

  if (!title) {
    const firstNonEmpty = buckets.preamble.find((l) => l.trim().length > 0);
    if (firstNonEmpty && firstNonEmpty.trim().length <= 80) {
      title = firstNonEmpty.replace(/^[-*•#\s]+/, "").trim();
      buckets.preamble = buckets.preamble.slice(buckets.preamble.indexOf(firstNonEmpty) + 1);
    } else {
      title = "匯入之籌備會議記錄";
    }
  }

  const cleanJoin = (arr: string[]) => arr.join("\n").trim();
  let agenda = cleanJoin(buckets.agenda);
  const preambleRest = cleanJoin(buckets.preamble);
  if (!agenda && preambleRest) {
    agenda = preambleRest;
  } else if (agenda && preambleRest) {
    agenda = `${preambleRest}\n\n${agenda}`;
  }

  return {
    title: title.slice(0, 120),
    meetingDate: meetingDate.slice(0, 40),
    attendees: attendees.slice(0, 300),
    agenda: agenda.slice(0, 6000),
    arrangements: cleanJoin(buckets.arrangements).slice(0, 6000),
    precautions: cleanJoin(buckets.precautions).slice(0, 6000),
    decisions: cleanJoin(buckets.decisions).slice(0, 6000),
  };
}

/** Formats a meeting as HackMD-native Markdown with YAML frontmatter and structured sections. */
export function meetingToHackMd(meeting: Omit<CampaignMeeting, "id" | "campaignId" | "updatedAt">, campaignName: string): string {
  const safeTitle = meeting.title.replace(/"/g, '\\"');
  return `---
title: "${safeTitle}"
tags: [BELL Campaign, ${campaignName}, 會議記錄]
---

# ${meeting.title}

- **開會時間**：${meeting.meetingDate || "待定"}
- **與會組別／人員**：${meeting.attendees || "全體籌備組"}

## 會前大綱
${meeting.agenda.trim() || "（尚無內容）"}

## 議程與時間安排
${meeting.arrangements.trim() || "（尚無內容）"}

## 會前注意事項與提醒
${meeting.precautions.trim() || "（尚無內容）"}

## 會議決議與後續行動
${meeting.decisions.trim() || "- [ ] （待補會議決議）"}
`;
}

function linesToHtmlBlocks(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return `<p style="color:#666;">（尚無內容）</p>`;
  const isList = lines.every((l) => /^([-*•]|\d+[.)、])/.test(l));
  if (isList) {
    return `<ul>${lines
      .map((l) => `<li>${escapeHtml(l.replace(/^([-*•]|\d+[.)、])\s*/, ""))}</li>`)
      .join("")}</ul>`;
  }
  return lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("");
}

/**
 * Formats a meeting as clean semantic HTML suitable for both:
 * 1. Rich Clipboard copy (`text/html`) to paste straight into Google Docs with real H1/H2 & lists.
 * 2. `.doc` / `.html` file upload into Google Drive -> Open as Google Docs.
 */
export function meetingToGoogleDocHtml(
  meeting: Omit<CampaignMeeting, "id" | "campaignId" | "updatedAt">,
  campaignName: string,
): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(meeting.title)}</title>
</head>
<body style="font-family:'PingFang TC','Noto Sans TC',sans-serif;line-height:1.65;color:#141518;max-width:760px;">
  <p style="font-size:12px;color:#9E2B5C;font-weight:600;margin:0 0 4px;">${escapeHtml(campaignName)} · 會議記錄</p>
  <h1 style="font-size:22px;margin:0 0 12px;">${escapeHtml(meeting.title)}</h1>
  <p style="margin:0 0 4px;"><strong>開會時間：</strong>${escapeHtml(meeting.meetingDate || "待定")}</p>
  <p style="margin:0 0 18px;"><strong>與會組別／人員：</strong>${escapeHtml(meeting.attendees || "全體籌備組")}</p>
  <hr style="border:none;border-top:1px solid #E5E7EB;margin:16px 0;" />
  <h2 style="font-size:16px;color:#9E2B5C;">一、會前大綱</h2>
  ${linesToHtmlBlocks(meeting.agenda)}
  <h2 style="font-size:16px;color:#9E2B5C;">二、議程與時間安排</h2>
  ${linesToHtmlBlocks(meeting.arrangements)}
  <h2 style="font-size:16px;color:#9E2B5C;">三、會前注意事項與提醒</h2>
  ${linesToHtmlBlocks(meeting.precautions)}
  <h2 style="font-size:16px;color:#9E2B5C;">四、會議決議與後續行動</h2>
  ${linesToHtmlBlocks(meeting.decisions)}
</body>
</html>`;
}

// ── Comparable Event Benchmark Curator (`#/inspirations` · 靈感借鏡) ─────────
interface BenchmarkTemplate {
  title: string;
  region: "國內" | "國際";
  category: string;
  keywords: RegExp;
  baseScore: number;
  defaultWhy: string;
  timelinePattern: string;
  specialIdeas: string[];
  pitfalls: string[];
}

const BENCHMARK_LIBRARY: readonly BenchmarkTemplate[] = [
  {
    title: "COSCUP 開源人年會",
    region: "國內",
    category: "多軌技術社群年會",
    keywords: /社群|年會|開源|技術|開發|議程|panel|與談|志工/i,
    baseScore: 88,
    defaultWhy: "同樣由兼職／志工團隊跨組協作推進，具備多軌議程、講者接待與現場高密度報到分流需求。",
    timelinePattern: "倒數 8 週鎖定議程軌與桌長 → 倒數 4 週發佈講者行前手冊 → 倒數 2 週凍結印刷檔並執行志工線上行前說明會。",
    specialIdeas: [
      "設計「講者與桌長專屬快速報到通道 + 休息室充電補給角」，大幅降低開場前講者迷路焦慮",
      "在名牌背面直接印上「當日整點議程表與圓桌換桌動線 QR Code」，減少紙本手冊印量",
      "會後 72 小時內釋出「閃電共筆精華包」，趁社群討論熱度最高時延續品牌聲量",
    ],
    pitfalls: [
      "切忌在活動前一週才收集講者投影片——務必在倒數 2 週收齊 PDF 備份檔，避免現場字型跑版或轉接頭不相容",
      "報到開放入場前 25 分鐘會湧入 65% 人潮，若只設單一驗票口必排隊塞車，需拆成「奇偶手機末碼或預報到雙動線」",
    ],
  },
  {
    title: "Figma Config（舊金山／全球連線）",
    region: "國際",
    category: "設計與產品跨域盛會",
    keywords: /設計|跨域|產品|工作坊|圓桌|世界咖啡館|體驗|品牌|交流/i,
    baseScore: 85,
    defaultWhy: "強調設計師與開發者跨界對話，重視高互動圓桌交流、主視覺一致性與精緻與會體驗。",
    timelinePattern: "主視覺系統先行（T-6W 定調色票與模板）→ 分三波段釋出與談亮點（T-4W / T-2W / T-3D）維持報名熱度，避免單週資訊轟炸。",
    specialIdeas: [
      "進場領取「互動話題貼紙」（例如：我想聊 AI 協作／我在找副作用專案夥伴），讓中場休息破冰自然發生",
      "Panel 與談預留最後 15 分鐘「即時 Slido 高票提問快問快答」，取代冗長開場致詞",
      "每張交流圓桌鋪設可書寫海報紙與雙色麥克筆，討論結束直接拍照成為會後社群金句圖卡",
    ],
    pitfalls: [
      "圓桌討論與主舞台若在同一開放空間，音場極易互相干擾——需事先與音控確認指向性喇叭角度與換桌提示鈴聲",
      "限量周邊或餐點若未標示素食／過敏原動線，午茶時段容易造成取餐回堵與素食夥伴撲空",
    ],
  },
  {
    title: "SITCON 學生計算機年會",
    region: "國內",
    category: "青年社群與議程共創",
    keywords: /學生|校園|青年|招工|志工|咖啡館|論壇|社群|工作坊/i,
    baseScore: 84,
    defaultWhy: "高度仰賴招工表單招募跨校／跨領域夥伴，並設有深度交流的圓桌論壇與主題與談環節。",
    timelinePattern: "招工表單採「隨到隨審 + 組長 15 分鐘輕量面談」，並在關鍵幹部請假／入伍／考試週前預留雙代理人交接週。",
    specialIdeas: [
      "為新加入的當日志工製作「一頁式口袋任務卡（含緊急聯絡電話與常見問題話術）」，5 分鐘即可上手",
      "設置「白板許願／閃電講招募牆」，讓現場與會者也能貢獻 3 分鐘觀點",
    ],
    pitfalls: [
      "避免將重要場控設備（如音控、直播、報到後台）壓在單一幹部身上——遇突發撞期或入伍請假時會瞬間斷鏈，務必在 RC 週完成雙人演練",
      "撤場時段最容易人力流失，排班時應明確指定「撤場專責小組」並預留清點押金時間",
    ],
  },
  {
    title: "Slush Helsinki（芬蘭赫爾辛基）",
    region: "國際",
    category: "高密度媒合與舞台策展",
    keywords: /新創|媒合|黑客松|比賽|創投|展演|國際|論壇|demo/i,
    baseScore: 80,
    defaultWhy: "以極高精準度的時間控場與志工體驗聞名，擅長在單日活動中平衡舞台內容與雙向交流密度。",
    timelinePattern: "倒數 3 週鎖定全場分鐘級 Cue 表（Run-of-Show）→ 倒數 1 週只做走位與異常演練，不再新增企劃分支。",
    specialIdeas: [
      "設計「1 對 1 或 4 人微聚會預約角（Meeting Tables）」，編上醒目桌號方便與會者精準碰面",
      "活動後第 1 週立即寄發「講者與合作廠商專屬致謝數據小卡（出席率、精彩側拍照）」，為下屆合作鋪路",
    ],
    pitfalls: [
      "串場轉換若只留 3 分鐘，講者換麥克風與測試畫面必定超時並骨牌式拖垮下半場——每場之間至少留 8–10 分鐘緩衝",
      "外燴與音響廠商共用貨梯時段若未錯開，早上進場會卡在卸貨區延誤彩排",
    ],
  },
  {
    title: "白晝之夜 Nuit Blanche ／ 城市策展市集",
    region: "國際",
    category: "展演市集與多點動線",
    keywords: /市集|展覽|音樂|藝術|戶外|體驗|派對|文化|品牌/i,
    baseScore: 76,
    defaultWhy: "多組攤位／展區同步運作，特別講究廠商進撤場時段管理、電力配置與現場臨時人力調度。",
    timelinePattern: "T-5W 確認攤商與硬體電力規格 → T-2W 發放進撤場車證與動線圖 → 活動後 1 週完成場地復原與廠商請款核銷。",
    specialIdeas: [
      "以「時段集章或任務連線」引導人流平均分佈至較內側的展桌，避免入口處過度擁擠",
      "建立「廠商與臨時工即時回報群組置頂懶人包」，統一收攏貨梯位置、聯絡人與統編資訊",
    ],
    pitfalls: [
      "高功率餐飲設備（咖啡機、保溫爐）與舞台音響絕對不可接在同一迴路，否則活動中途極易跳電",
      "戶外或半開放場館需在 T-3D 啟動雨備／冷氣動線備案確認",
    ],
  },
];

export function curateComparableEvents(input: {
  campaignId: string;
  name: string;
  subtitle: string;
  brief: string;
  mainGoal: string;
  teamNames: string[];
  focusHint?: string;
}): Omit<CampaignInspiration, "id" | "updatedAt">[] {
  const corpus = [
    input.name,
    input.subtitle,
    input.brief,
    input.mainGoal,
    input.focusHint ?? "",
    ...input.teamNames,
  ].join(" ");

  const scored = BENCHMARK_LIBRARY.map((item) => {
    const matches = corpus.match(new RegExp(item.keywords.source, "gi")) ?? [];
    const boost = Math.min(11, matches.length * 3);
    const similarityScore = Math.min(97, item.baseScore + boost);
    const matchedTeams = input.teamNames.slice(0, 2).join("、");
    const whySimilar = matchedTeams
      ? `與「${input.name}」的${matchedTeams}編制高度呼應：${item.defaultWhy}`
      : item.defaultWhy;
    return {
      campaignId: input.campaignId,
      title: item.title,
      region: item.region,
      category: item.category,
      similarityScore,
      whySimilar,
      timelinePattern: item.timelinePattern,
      specialIdeas: [...item.specialIdeas],
      pitfalls: [...item.pitfalls],
    };
  });

  scored.sort((a, b) => b.similarityScore - a.similarityScore);
  return scored.slice(0, 4);
}
