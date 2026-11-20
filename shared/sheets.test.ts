import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAppsScriptSyncCode,
  buildGoogleSheetMatrix,
  buildPacingSchedulePreview,
  buildWeeklyTimelineDefs,
  matrixToCsvBom,
  matrixToTsv,
  normalizeStage,
  parseGoogleSheetCsv,
  parseMonthNumbers,
} from "./sheets.js";
import {
  curateComparableEvents,
  inferUploadMimeType,
  meetingToGoogleDocHtml,
  meetingToHackMd,
  parseMeetingDoc,
} from "./docs.js";
import {
  allowedSuiteRoute,
  explainDraftHref,
  parseCampaignHandoff,
  personalTaskHref,
  prDraftHref,
} from "./suite.js";
import { buildSlidesDeckModel, buildStyledSheetModel, renderSingleSlideHtml } from "./exporters.js";
import { isSafeMarkdownUrl, parseMarkdownBlocks } from "./markdown.js";
import { CampaignStore } from "../server/store.js";

const REFERENCE_GSHEET_CSV = `,月,六月,,七月,,,,八月
,日期,6/22~6/28,6/29~7/05,7/06~7/12,7/13~7/19,7/20~7/26,7/27~8/02,8/03~8/09
倒數週數,,倒數 6 周,倒數 5 周,倒數 4 周,倒數 3 周,倒數 2 周,倒數 1 周,活動當周
主要排程,,,,"7/11
名單確認",,,"7/27 
Kazma 當兵",8/8~8/9 COSCUP
,,,,,,,,
備註,,,7/5 送出,7/9 送出,,,,
世界咖啡館,完成度,進度25%,進度50%,進度75%,進度100%,Debug,RC,活動
,本週進度,名單研究&確認,第一波寄信,第二波寄信,企劃&通知,,,活動當日
,待辦事項,潛在名單蒐集,信件撰寫,信件撰寫,講者行前通知,簡報最後確認,,負責主持
,,信件模板,,,協助志工行前通知(?),,,
,,,,,企劃,,,
,跨部合作,,,,圓桌題綱討論,,,
,,,,,主持人講稿&簡報準備,,,
Panel,完成度,進度25%,進度50%,進度75%,進度100%,Debug,RC,活動
,本週進度,名單研究&確認,第一波寄信,第二波寄信,企劃&通知,,,活動當日
,待辦事項,潛在名單蒐集,信件撰寫,信件撰寫,講者行前通知,傳題綱給與談者,,機動
,,信件模板,,,協助志工行前通知(?),,,
,,,,,企劃,,,
,跨部合作,,,,主持人題綱討論,,,`;

test("parseGoogleSheetCsv parses reference 籌備時程規劃-2026 spreadsheet accurately", () => {
  const parsed = parseGoogleSheetCsv(REFERENCE_GSHEET_CSV);
  assert.equal(parsed.weeks.length, 7);
  assert.equal(parsed.weeks[0].monthLabel, "六月");
  assert.equal(parsed.weeks[2].monthLabel, "七月");
  assert.equal(parsed.weeks[6].monthLabel, "八月");
  assert.equal(parsed.weeks[6].phase, "event");

  // Multiline date+event cell merges cleanly and classifies milestones vs conflicts
  assert.deepEqual(
    parsed.weeks[2].majorEvents.map((e) => ({ title: e.title, kind: e.kind })),
    [{ title: "7/11 名單確認", kind: "milestone" }],
  );
  assert.equal(parsed.weeks[5].majorEvents[0]?.title, "7/27 Kazma 當兵");
  assert.equal(parsed.weeks[5].majorEvents[0]?.kind, "conflict");
  assert.equal(parsed.weeks[6].majorEvents[0]?.title, "8/8~8/9 COSCUP");
  assert.equal(parsed.weeks[6].majorEvents[0]?.kind, "conflict");
  assert.deepEqual(
    parsed.weeks.map((w) => w.stage),
    ["進度25%", "進度50%", "進度75%", "進度100%", "Debug", "RC", "活動"],
  );

  assert.equal(parsed.teams.length, 2);
  const cafe = parsed.teams[0];
  assert.equal(cafe.name, "世界咖啡館");
  assert.equal(cafe.cells[0].stage, "進度25%");
  assert.deepEqual(cafe.cells[0].todos, ["潛在名單蒐集", "信件模板"]);
  assert.equal(cafe.cells[3].stage, "進度100%");
  assert.deepEqual(cafe.cells[3].todos, ["講者行前通知", "協助志工行前通知(?)", "企劃"]);
  assert.equal(cafe.cells[3].crossTeam, "圓桌題綱討論 ／ 主持人講稿&簡報準備");
});

test("Google Sheet matrix TSV/CSV export round-trips and Pacing engine avoids conflict weeks", () => {
  const dir = mkdtempSync(join(tmpdir(), "bell-campaign-sheets-"));
  try {
    const store = new CampaignStore(join(dir, "campaign.db"), join(dir, "uploads"));
    const snap = store.getSnapshot();

    const matrix = buildGoogleSheetMatrix(snap);
    const tsv = matrixToTsv(matrix);
    const csv = matrixToCsvBom(matrix);
    assert.ok(tsv.includes("整體進度\t總完成"));
    assert.ok(tsv.includes("世界咖啡館\t本週進度"));
    assert.ok(!tsv.includes("世界咖啡館\t完成度"));
    assert.ok(csv.startsWith("\uFEFF"));

    const reparsed = parseGoogleSheetCsv(csv.slice(1));
    assert.equal(reparsed.weeks.length, snap.weeks.length);
    assert.deepEqual(
      reparsed.weeks.map((w) => w.stage),
      snap.weeks.map((w) => w.stage),
    );
    assert.equal(reparsed.teams.length, snap.teams.length);

    const tasksText = [
      "世界咖啡館：確認 8 位桌長最終名單",
      "Panel 與談：寄送與談題綱與彩排邀請",
      "行銷與設計組：輸出社群倒數宣傳圖卡",
      "場務與志工組：確認外燴茶點與音響進場動線",
      "行銷與設計組：印製名牌與桌次指引牌",
      "場務與志工組：完成志工報到動線演練",
    ].join("\n");

    const relaxed = buildPacingSchedulePreview(snap, {
      mainGoal: snap.campaign.mainGoal,
      monthlyGoals: snap.campaign.monthlyGoals,
      tasksText,
      pacing: "relaxed",
    });
    const intense = buildPacingSchedulePreview(snap, {
      mainGoal: snap.campaign.mainGoal,
      monthlyGoals: snap.campaign.monthlyGoals,
      tasksText,
      pacing: "intense",
    });

    assert.ok(relaxed.avoidedConflictWeeks.length >= 1);
    assert.equal(relaxed.todos.length, 6);
    assert.notDeepEqual(
      relaxed.cells.map((c) => c.stage),
      intense.cells.map((c) => c.stage),
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Suite handoff parser enforces allowlisted origins, single params, and clean back routes", () => {
  const links = {
    personal: "http://127.0.0.1:21103",
    explain: "http://127.0.0.1:21101",
  };

  const ok = parseCampaignHandoff(
    "#/handoff?text=%E7%A2%BA%E8%AA%8D%E8%AC%9B%E8%80%85%E7%B0%A1%E5%A0%B1&title=%E8%AC%9B%E8%80%85%E8%BF%BD%E8%B9%A4&from=personal&back=%23%2Ftoday",
    links,
  );
  assert.equal(ok.present, true);
  if (ok.present) {
    assert.equal(ok.rejected, undefined);
    assert.equal(ok.draft?.from, "personal");
    assert.equal(ok.draft?.title, "講者追蹤");
    assert.equal(ok.draft?.backUrl, "http://127.0.0.1:21103/#/today");
  }

  const unlinked = parseCampaignHandoff("#/handoff?text=hi&from=reader", links);
  assert.deepEqual(unlinked, { present: true, rejected: "from" });

  const dup = parseCampaignHandoff("#/handoff?text=a&text=b&from=personal", links);
  assert.deepEqual(dup, { present: true, rejected: "duplicate" });

  const pHref = personalTaskHref("http://127.0.0.1:21103", "寄發志工錄取信", "#/forms", "127.0.0.1");
  assert.ok(pHref?.startsWith("http://127.0.0.1:21103/#/tasks?"));

  const eHref = explainDraftHref(
    "http://127.0.0.1:21101",
    { text: "世界咖啡館換桌規則", title: "換桌設計", back: "#/notes" },
    "127.0.0.1",
  );
  assert.ok(eHref?.startsWith("http://127.0.0.1:21101/#/explain?"));

  for (const r of ["#/", "#/home", "#/demo", "#/repos", "#/repos/bell-campaign", "#/discover", "#/team", "#/group", "#/learning", "#/settings", "#/runs/run_7"]) {
    assert.equal(allowedSuiteRoute("pr", r), true, r);
  }
  assert.equal(allowedSuiteRoute("pr", "#/runs/.."), false);

  const fromPr = parseCampaignHandoff(
    "#/tasks?draft=Sync+landing+copy&title=Landing+PR&from=pr&back=%23%2Fruns%2Frun_7",
    { ...links, pr: "http://127.0.0.1:4603" },
  );
  assert.equal(fromPr.present, true);
  if (fromPr.present) {
    assert.equal(fromPr.draft?.from, "pr");
    assert.equal(fromPr.draft?.title, "Landing PR");
    assert.equal(fromPr.draft?.backUrl, "http://127.0.0.1:4603/#/runs/run_7");
  }

  const prHref = prDraftHref(
    "http://127.0.0.1:4603",
    { draft: "[COSCUP · 議程組] 更新網站時刻表", title: "更新網站時刻表", back: "#/tasks" },
    "127.0.0.1",
  );
  assert.ok(prHref?.startsWith("http://127.0.0.1:4603/#/discover?"));
  const prParams = new URLSearchParams(prHref!.split("?")[1]);
  assert.equal(prParams.get("from"), "campaign");
  assert.equal(prParams.get("back"), "#/tasks");
});

test("Bidirectional Google Docs & HackMD meeting parser round-trips cleanly and curates benchmarks", () => {
  assert.equal(normalizeStage("20%"), "進度20%");
  assert.equal(normalizeStage("進度60%"), "進度60%");

  const draft = {
    title: "倒數 3 週 · 講者接待與音控對齊會",
    meetingDate: "2026-07-15 20:30",
    attendees: "Panel 組、場務組、音控廠商",
    agenda: "1. 確認講者簡報比例\n2. 雙軌報到分流測試",
    arrangements: "- 20:30 各組快報\n- 20:50 動線核對",
    precautions: "會前先上傳場地平面圖",
    decisions: "7/20 前收齊所有講者 PDF 備份",
    docUrl: "https://hackmd.io/@bell/summit-sync",
    docSource: "hackmd" as const,
  };

  const hackmd = meetingToHackMd(draft, "2026 跨域盛會");
  assert.match(hackmd, /^---\ntitle:/);
  const parsedFromMd = parseMeetingDoc(hackmd);
  assert.equal(parsedFromMd.title, draft.title);
  assert.equal(parsedFromMd.meetingDate, draft.meetingDate);
  assert.equal(parsedFromMd.attendees, draft.attendees);
  assert.match(parsedFromMd.agenda, /雙軌報到分流測試/);
  assert.match(parsedFromMd.decisions, /收齊所有講者 PDF/);

  const gdocHtml = meetingToGoogleDocHtml(draft, "2026 跨域盛會");
  const parsedFromHtml = parseMeetingDoc(gdocHtml);
  assert.equal(parsedFromHtml.title, draft.title);
  assert.match(parsedFromHtml.precautions, /場地平面圖/);

  const curated = curateComparableEvents({
    campaignId: "camp-test",
    name: "校園開源設計工作坊",
    subtitle: "主題與談 · 世界咖啡館",
    brief: "由學生志工籌備的 150 人跨領域開源與設計交流活動",
    mainGoal: "凝聚學生開發者與設計師",
    teamNames: ["世界咖啡館", "場務與志工組"],
  });
  assert.equal(curated.length, 4);
  assert.ok(curated.some((c) => c.region === "國內"));
  assert.ok(curated.some((c) => c.region === "國際"));
  assert.ok(curated.every((c) => c.pitfalls.length >= 2 && c.specialIdeas.length >= 2));

  // Multi-month LiveCTF timeline & month-aware scheduler
  assert.deepEqual(parseMonthNumbers("11月底～1月初完成出題"), [11, 12, 1]);
  assert.deepEqual(parseMonthNumbers("十一月"), [11]);
  const tl = buildWeeklyTimelineDefs({
    startDate: "2026-11-13",
    eventDate: "2027-02-27",
    postWeeks: 2,
    dateTentative: true,
    referenceToday: "2026-11-13",
  });
  assert.equal(tl.prepCount, 16);
  assert.equal(tl.weeks.length, 19);
  assert.equal(tl.weeks[0]?.countdownLabel, "倒數 16 周");
  assert.equal(tl.weeks[16]?.countdownLabel, "暫定活動當周");

  const ctfCurated = curateComparableEvents({
    campaignId: "camp-ctf",
    name: "TSCCTF-2026",
    subtitle: "全台各校聯合新手 LiveCTF 資安競賽",
    brief: "核心受眾為全台資安社新手，採 LiveCTF 賽制並進行出題組與 Infra 組協作及各校領獎資格審核",
    mainGoal: "完成 LiveCTF 題目互驗與跨校新手資格審核",
    teamNames: ["出題組", "Infra 組", "行政與廠商公關組"],
  });
  assert.ok(ctfCurated.some((c) => /LiveCTF/i.test(c.title)));
  assert.ok(ctfCurated.some((c) => /資安社/.test(c.title)));
});

test("renderSingleSlideHtml matrix wraps .dk-mx-team inside <td> and Markdown parser handles GFM + XSS safely", () => {
  const dir = mkdtempSync(join(tmpdir(), "bell-campaign-md-"));
  try {
    const store = new CampaignStore(join(dir, "campaign.db"), join(dir, "uploads"));
    const snap = store.getSnapshot();
    const slides = buildSlidesDeckModel(snap);
    const matrixSlide = slides.find((s) => s.kind === "matrix");
    assert.ok(matrixSlide);
    const matrixHtml = renderSingleSlideHtml(matrixSlide, snap.campaign.name, slides.length);
    assert.match(matrixHtml, /<td><div class="dk-mx-team">/);
    assert.doesNotMatch(matrixHtml, /<td class="dk-mx-team">/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Safe URL checks
  assert.equal(isSafeMarkdownUrl("https://example.com/a"), true);
  assert.equal(isSafeMarkdownUrl("http://127.0.0.1:21105/#/schedule"), true);
  assert.equal(isSafeMarkdownUrl("/api/files/1/raw"), true);
  assert.equal(isSafeMarkdownUrl("#section"), true);
  assert.equal(isSafeMarkdownUrl("//evil.com/phish"), false);
  assert.equal(isSafeMarkdownUrl("///evil.com"), false);
  assert.equal(isSafeMarkdownUrl("/\\evil.com/phish"), false);
  assert.equal(isSafeMarkdownUrl("javascript:alert(1)"), false);
  assert.equal(isSafeMarkdownUrl("data:text/html,<script>alert(1)</script>"), false);

  const md = `# 籌備手冊
> 注意 **9:00** 準時報到

---

- [x] 已完成 \`場勘\`
- [ ] 待確認 [官方網站](https://example.com) 與 [危險連結](javascript:alert(1))

| 組別 | 窗口 |
| :--- | ---: |
| 行銷組 | 3 |

\`\`\`bash
echo "hello"
\`\`\`
`;
  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks[0]?.type, "heading");
  assert.equal(blocks[1]?.type, "blockquote");
  assert.equal(blocks[2]?.type, "hr");
  assert.equal(blocks[3]?.type, "list");
  if (blocks[3]?.type === "list") {
    assert.equal(blocks[3].items[0]?.checked, true);
    assert.equal(blocks[3].items[1]?.checked, false);
    const spans = blocks[3].items[1]?.spans ?? [];
    assert.ok(spans.some((s) => s.type === "link" && s.href === "https://example.com"));
    assert.ok(!spans.some((s) => s.type === "link" && s.href.startsWith("javascript:")));
    assert.ok(spans.some((s) => s.type === "text" && s.text === "危險連結"));
  }
  assert.equal(blocks[4]?.type, "table");
  assert.equal(blocks[5]?.type, "code");
});

test("Regression guards: surrogate-safe sheetName, empty-weeks pacing, and CRLF MIME fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "bell-campaign-reg-"));
  try {
    const store = new CampaignStore(join(dir, "campaign.db"), join(dir, "uploads"));
    const snap = store.getSnapshot();
    const emojiSnap = {
      ...snap,
      campaign: { ...snap.campaign, name: "a".repeat(27) + "🎉" + "suffix" },
    };

    const sheetModel = buildStyledSheetModel(emojiSnap);
    assert.equal(sheetModel.sheetName, "a".repeat(27) + "🎉");
    assert.equal(Buffer.from(sheetModel.sheetName, "utf8").toString("utf8"), sheetModel.sheetName);

    const appsScript = buildAppsScriptSyncCode(emojiSnap);
    assert.ok(appsScript.includes(JSON.stringify("a".repeat(27) + "🎉")));

    const emptyWeekPreview = buildPacingSchedulePreview(
      { weeks: [], teams: snap.teams, cells: [], todos: [] },
      { mainGoal: "", monthlyGoals: [], tasksText: "孤立任務", pacing: "balanced" },
    );
    assert.deepEqual(emptyWeekPreview.todos, []);
    assert.deepEqual(emptyWeekPreview.cells, []);

    assert.equal(inferUploadMimeType("notes.txt", "text/plain\r\nX-Injected: 1"), "text/plain");
    assert.equal(inferUploadMimeType("notes.txt", "text/plain\r\n;charset=utf-8"), "text/plain");
    assert.equal(inferUploadMimeType("notes.txt", "text/plain; charset=中文"), "text/plain");
    assert.equal(inferUploadMimeType("unknown.bin", "bad\nmime"), "application/octet-stream");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
