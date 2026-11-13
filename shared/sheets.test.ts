import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGoogleSheetMatrix,
  buildPacingSchedulePreview,
  matrixToCsvBom,
  matrixToTsv,
  parseGoogleSheetCsv,
} from "./sheets.js";
import {
  explainDraftHref,
  parseCampaignHandoff,
  personalTaskHref,
} from "./suite.js";
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
    assert.ok(tsv.includes("世界咖啡館\t完成度"));
    assert.ok(csv.startsWith("\uFEFF"));

    const reparsed = parseGoogleSheetCsv(csv.slice(1));
    assert.equal(reparsed.weeks.length, snap.weeks.length);
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
});
