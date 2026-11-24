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
    title: "DEF CON LiveCTF（拉斯維加斯／全球連線）",
    region: "國際",
    category: "即時解題直播賽",
    keywords: /ctf|livectf|資安|出題|驗題|infra|靶機|競賽|賽制|輪次|pwn|web|crypto|reverse/i,
    baseScore: 89,
    defaultWhy: "即時輪次解題與獨立靶機調度，直接對應出題組×網管組的容器規格與直播轉播節奏。",
    timelinePattern: "T-12W 定賽制與容器規格 → T-7W 收齊題目與 Docker → T-4W 盲測驗題與 200 人壓測。",
    specialIdeas: [
      "第一個月先定好「出題模板（Dockerfile + healthcheck + 自動解題腳本）」，免得賽前人工搬題出包",
      "安排「破冰暖身題 + 即時解題轉播面板」，讓線上觀眾跟各校新手都有參與感",
      "賽後開源部分題目與官方 Writeup，直接變各校下學期社課教材",
    ],
    pitfalls: [
      "靶機沒鎖 CPU／PID／外網最容易被單一容器拖垮母機，驗題期一定要實測 cgroup 與禁外網",
      "自己驗題很容易漏看非預期解，務必交叉盲測並在賽前 3 週鎖題",
    ],
  },
  {
    title: "LakeCTF（EPFL · no-llm 政策）",
    region: "國際",
    category: "防 AI 秒殺與晉級直播賽",
    keywords: /ctf|llm|agent|出題|網管|資安|淘汰|八強|十六強|直播|lakectf/i,
    baseScore: 88,
    defaultWhy: "率先公開 no-llm 規範並改採緊湊晉級制，跟零籌拍板的防 AI 與淘汰賽直播完全契合。",
    timelinePattern: "開案定 AI 邊界與晉級輪次 → 出題期拿主流 Agent 實測 → 賽前公告規章與錄流量聲明。",
    specialIdeas: [
      "題目加入多步互動或環境探索，出題組交題前先拿主流 Agent 實測過濾秒殺題",
      "改採「初賽積分篩選 ＋ 16強／8強淘汰三天直播」，避開循環賽太冗長、觀眾疲乏的問題",
      "每隊配專屬 Dynamic Flag 加上 VPN 流量留存，抓抄題或異常掃描才有憑據仲裁",
    ],
    pitfalls: [
      "規章只寫禁用 AI 卻沒技術限制會讓老實人吃虧，要寫清楚「可查語法／禁全自動 Agent 掃靶機」並配 Rate Limit",
      "全場錄 PCAP 沒設 Ring Buffer 輪替，第二天硬碟塞爆就會把 CTFd 跟靶機一起搞掛",
    ],
  },
  {
    title: "AIS3 EOF × 台灣跨校資安社聯合新手賽",
    region: "國內",
    category: "跨校資安社雙軌賽",
    keywords: /資安|社團|新手|跨校|聯合|ctf|領獎|資格|各校|廠商|贊助|學生/i,
    baseScore: 88,
    defaultWhy: "同時開放全球隊伍參賽並保留籌備校新手專屬獎項，需對齊各校審資格、談贊助與寒假避撞期。",
    timelinePattern: "11 月各校對檔期＆談贊助 → 12 月開放報名與社課宣傳 → 1 月審新手資格＆驗題 → 2–3 月開賽。",
    specialIdeas: [
      "計分板分「Global 總榜」與「籌備校新手領獎榜」，兼顧國際熱度與社團新手破蛋成就感",
      "贊助包結合「企業冠名題／實習履歷投遞通道」，年底談資安廠商預算更好推",
      "五校各派 1 位社長／代表在 1 月底前核對社員學籍與新手身分，避免賽後領獎爭議",
    ],
    pitfalls: [
      "2–3 月務必避開春節、1 月中下旬學測、開學週、228 連假與 3 月初 SITCON 及國際大賽週末",
      "「新手領獎資格」沒在 12 月報名簡章寫死，賽後一定吵翻",
    ],
  },
  {
    title: "COSCUP 開源人年會",
    region: "國內",
    category: "志工跨組協作年會",
    keywords: /社群|年會|開源|技術|開發|議程|panel|與談|志工/i,
    baseScore: 85,
    defaultWhy: "全志工跨組遠端協作，講究死線控管、贊助履約與行前手冊對齊。",
    timelinePattern: "T-8W 鎖定議程與窗口 → T-4W 發出行前手冊 → T-2W 凍結印刷檔並辦工作人員說明會。",
    specialIdeas: [
      "一頁式行前手冊整合時程、聯絡窗口與報到動線，減少群組重複發問",
      "賽後 72 小時內發佈精華回顧與感謝名單，趁熱度最高時累積下屆口碑",
    ],
    pitfalls: [
      "別等到最後一週才收講者或賽評簡報，T-2W 先收備份檔才不會現場跑版",
      "尖峰時段報到或客服只開單一窗口必塞車，要預先分流",
    ],
  },
  {
    title: "Figma Config（舊金山／全球連線）",
    region: "國際",
    category: "品牌視覺與社群互動",
    keywords: /設計|跨域|產品|工作坊|圓桌|世界咖啡館|體驗|品牌|交流/i,
    baseScore: 83,
    defaultWhy: "主視覺模板先行、分波段社群預熱，適合宣傳組與設計組拉高報名轉換率。",
    timelinePattern: "T-6W 定主視覺與社群模板 → 分三波釋出亮點（T-4W／T-2W／T-3D）維持熱度。",
    specialIdeas: [
      "先做好倒數圖、賽制懶人包與贊助 Logo 套版，宣傳組就能快速出圖不卡設計",
      "中場穿插短訪談或即時解題快訊，取代冗長致詞",
    ],
    pitfalls: [
      "周邊與印刷品沒算進春節工廠封關日，很容易趕不上活動日",
      "多軌轉播或現場音場要提前測音量平衡，避免互相干擾",
    ],
  },
  {
    title: "SITCON 學生計算機年會",
    region: "國內",
    category: "學生跨校招工與傳承",
    keywords: /學生|校園|青年|招工|志工|咖啡館|論壇|社群|工作坊/i,
    baseScore: 84,
    defaultWhy: "同樣靠跨校學生招工與社團協作推進，特別需要注意期末考降載與雙人備援。",
    timelinePattern: "招工隨到隨審拉進 DC 分組 → 期末考與學測週自動降載 → RC 週雙人演練交接。",
    specialIdeas: [
      "給新招工夥伴一頁式任務卡（含回報窗口與死線），5 分鐘就能上手",
      "各組設副組長或雙人備援，有人卡考試或臨時有事也不會斷鏈",
    ],
    pitfalls: [
      "把 OBS 轉播或靶機後台壓在單一幹部身上最危險，RC 週一定要做雙人演練",
      "收尾核銷與寄獎最容易拖延，排班時要先指定結案負責人",
    ],
  },
  {
    title: "Slush Helsinki（芬蘭赫爾辛基）",
    region: "國際",
    category: "分鐘級控場與贊助體驗",
    keywords: /新創|媒合|黑客松|比賽|創投|展演|國際|論壇|demo/i,
    baseScore: 80,
    defaultWhy: "以分鐘級 Run-of-Show 控場與贊助商結案報告聞名，適合轉播組與贊助組借鏡。",
    timelinePattern: "T-3W 鎖定分鐘級導播 Cue 表 → T-1W 只做彩排與異常演練，不再加新功能。",
    specialIdeas: [
      "轉播與場控共用同一份分鐘級 Cue 表，換場口播跟字卡才不會落拍",
      "賽後第 1 週就寄出贊助商專屬數據小卡（觀看數、參賽校數、直播截圖），下屆續約率最高",
    ],
    pitfalls: [
      "換場只留 3 分鐘一定超時拖垮後面賽程，輪次切換至少留 8–10 分鐘緩衝",
      "開賽前一週切忌臨時改賽制或加新外掛，穩住現有流程最重要",
    ],
  },
  {
    title: "白晝之夜 Nuit Blanche ／ 城市策展市集",
    region: "國際",
    category: "多點場控與廠商調度",
    keywords: /市集|展覽|音樂|藝術|戶外|體驗|派對|文化|品牌/i,
    baseScore: 76,
    defaultWhy: "多單位同步運作，重廠商規格確認、進撤場動線與請款統編收攏。",
    timelinePattern: "T-5W 確認硬體規格 → T-2W 發動線與窗口懶人包 → W+1 完成請款核銷。",
    specialIdeas: [
      "廠商與工作人員群組置頂一頁懶人包，統一收攏聯絡人、雲端資料夾與統編抬頭",
      "用闖關或破蛋任務引導新手參與，避免熱度只集中少數強隊",
    ],
    pitfalls: [
      "請款沒先對好學校代收或廠商直付統編，賽後重開發票會卡死核銷",
      "現場或線上突發狀況要有單一仲裁窗口，避免多頭馬車",
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
      ? `對應${matchedTeams}：${item.defaultWhy}`
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

const EXTENSION_MIME_MAP: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export const SAFE_MIME_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:[ \t]*;[\x20-\x7e]*)?$/i;

export function inferUploadMimeType(fileName: string, reportedMimeType?: string): string {
  const cleaned = (reportedMimeType ?? "").trim().toLowerCase();
  if (cleaned && cleaned !== "application/octet-stream" && SAFE_MIME_RE.test(cleaned)) {
    return cleaned;
  }
  const ext = fileName.trim().toLowerCase().split(".").pop() ?? "";
  return EXTENSION_MIME_MAP[ext] ?? "application/octet-stream";
}
