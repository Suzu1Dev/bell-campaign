import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { inflateRawSync } from "node:zlib";
import { CampaignStore } from "./store.js";
import { createApp } from "./app.js";
import { applyPonytailPrompt, replyCampaignBot } from "./ai.js";
import type { CampaignSnapshot, ProviderSettings } from "../shared/types.js";
import type { SuiteManifest, SuiteTodayFeed } from "../shared/suite.js";
import {
  buildSlidesDeckModel,
  buildStyledSheetClipboardHtml,
  buildStyledSheetModel,
} from "../shared/exporters.js";
import { buildCampaignXlsxBuffer } from "./xlsx.js";

async function withServer(
  fn: (baseUrl: string, store: CampaignStore) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "bell-campaign-api-"));
  const store = new CampaignStore(join(dir, "campaign.db"), join(dir, "uploads"));
  const app = createApp({
    store,
    suiteLinks: {
      personal: "http://127.0.0.1:21103",
      explain: "http://127.0.0.1:21101",
      reader: "http://127.0.0.1:21104",
    },
    docFetcher: async (url) => ({
      source: url.includes("hackmd.io") ? "hackmd" : "gdoc",
      text: `# 雲端同步週會\n- 開會時間：2026-07-18 21:00\n- 與會人員：全體組長\n\n## 會前大綱\n確認講者動線與外燴時段\n\n## 會議決議與後續行動\n鎖定奇偶分流報到口`,
    }),
    sheetCsvFetcher: async () =>
      `姓名,Email,第一志願,角色,專長,可配合時段\n沈柏翰,bohan@example.com,場務與志工組,當日志工,"音控支援","8/05 全日"\n許庭甄,ting@example.com,行銷與設計組,組員,"社群文案","會前每週籌備, 8/05 全日"`,
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl, store);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Suite Contract v1 endpoints and security guards (Host, Origin, Sec-Fetch-Site, JSON)", async () => {
  await withServer(async (baseUrl) => {
    const mRes = await fetch(`${baseUrl}/api/suite/manifest`);
    assert.equal(mRes.status, 200);
    const manifest = (await mRes.json()) as SuiteManifest;
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.appId, "campaign");
    assert.equal(manifest.links.personal, "http://127.0.0.1:21103");

    const tRes = await fetch(`${baseUrl}/api/suite/today`);
    assert.equal(tRes.status, 200);
    const feed = (await tRes.json()) as SuiteTodayFeed;
    assert.equal(feed.schemaVersion, 1);
    assert.equal(feed.appId, "campaign");
    assert.ok(feed.items.length > 0 && feed.items.length <= 5);
    assert.ok(typeof feed.counts.progressPercent === "number");

    // Cross-origin write blocked (403)
    const badOrigin = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "builtin" }),
    });
    assert.equal(badOrigin.status, 403);

    // Sec-Fetch-Site cross-site write blocked (403)
    const badFetchSite = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "builtin" }),
    });
    assert.equal(badFetchSite.status, 403);

    // Non-JSON write blocked (415)
    const badContentType = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "text/plain" },
      body: "provider=builtin",
    });
    assert.equal(badContentType.status, 415);
  });
});

test("End-to-end campaign workflows: todos, handbook generation, file upload, forms & Bot apply", async () => {
  await withServer(async (baseUrl) => {
    const snapRes = await fetch(`${baseUrl}/api/snapshot`);
    assert.equal(snapRes.status, 200);
    let snap = (await snapRes.json()) as CampaignSnapshot;
    const cid = snap.campaign.id;
    const initialTodoCount = snap.todos.length;

    // 1. Add a Todo and mark it done
    const addTodoRes = await fetch(`${baseUrl}/api/campaigns/${cid}/todos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        teamId: snap.teams[0].id,
        weekId: snap.weeks[0].id,
        title: "確認世界咖啡館桌紙印刷打樣",
        priority: "high",
      }),
    });
    assert.equal(addTodoRes.status, 201);
    snap = (await addTodoRes.json()) as CampaignSnapshot;
    assert.equal(snap.todos.length, initialTodoCount + 1);
    assert.equal(snap.weeks[0].stage, "進度25%");

    const patchWeekRes = await fetch(`${baseUrl}/api/weeks/${snap.weeks[1].id}?campaignId=${cid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "進度50%" }),
    });
    assert.equal(patchWeekRes.status, 200);
    snap = (await patchWeekRes.json()) as CampaignSnapshot;
    assert.equal(snap.weeks[1].stage, "進度50%");

    // 2. Generate a Speaker Handbook into the File Archive
    const genRes = await fetch(`${baseUrl}/api/campaigns/${cid}/files/generate-handbook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        template: "speaker_handbook",
        recipientName: "林致遠博士",
        sessionTitle: "AI 輔助開源協作",
        saveToArchive: true,
      }),
    });
    assert.equal(genRes.status, 201);
    const genPayload = (await genRes.json()) as {
      generated: { title: string; contentMd: string };
      snapshot: CampaignSnapshot;
    };
    assert.ok(genPayload.generated.contentMd.includes("林致遠博士"));
    assert.ok(genPayload.snapshot.files.some((f) => f.title.includes("林致遠博士")));

    // 3. Upload a file & verify sandboxed raw download headers
    const svgBase64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"></svg>').toString("base64");
    const uploadRes = await fetch(`${baseUrl}/api/campaigns/${cid}/files/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "社群倒數圖卡草稿",
        category: "social",
        fileName: "countdown.svg",
        mimeType: "image/svg+xml",
        dataBase64: svgBase64,
      }),
    });
    assert.equal(uploadRes.status, 201);
    snap = (await uploadRes.json()) as CampaignSnapshot;
    const uploaded = snap.files.find((f) => f.title === "社群倒數圖卡草稿");
    assert.ok(uploaded);

    const rawRes = await fetch(`${baseUrl}/api/files/${uploaded.id}/raw`);
    assert.equal(rawRes.status, 200);
    assert.equal(rawRes.headers.get("x-content-type-options"), "nosniff");
    assert.match(rawRes.headers.get("content-security-policy") ?? "", /sandbox/);

    // 4. Recruitment Form CSV Import & Status Review
    const formId = snap.forms[0].id;
    const csvImportRes = await fetch(`${baseUrl}/api/campaigns/${cid}/forms/${formId}/import-csv`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        csvText: `姓名,Email,第一志願,角色,專長,可配合時段\n周語彤,yutong@example.com,世界咖啡館,組員,"雙語引導, 紀錄","8/05 全日, 撤場"`,
      }),
    });
    assert.equal(csvImportRes.status, 200);
    const csvBody = (await csvImportRes.json()) as { importedCount: number; snapshot: CampaignSnapshot };
    assert.equal(csvBody.importedCount, 1);
    const newApplicant = csvBody.snapshot.formResponses.find((r) => r.applicantName === "周語彤");
    assert.ok(newApplicant);

    const reviewRes = await fetch(`${baseUrl}/api/form-responses/${newApplicant.id}?campaignId=${cid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "accepted", reviewerNote: "雙語引導經驗佳" }),
    });
    assert.equal(reviewRes.status, 200);
    snap = (await reviewRes.json()) as CampaignSnapshot;
    assert.equal(snap.formResponses.find((r) => r.id === newApplicant.id)?.status, "accepted");

    // 5. Campaign Bot chat + 1-click proposal execution
    const chatRes = await fetch(`${baseUrl}/api/campaigns/${cid}/bot/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "幫我把排程調整成穩健緩衝節奏" }),
    });
    assert.equal(chatRes.status, 200);
    snap = (await chatRes.json()) as CampaignSnapshot;
    const lastMsg = snap.botMessages.at(-1);
    assert.equal(lastMsg?.role, "assistant");
    assert.ok(lastMsg && lastMsg.proposals.length >= 1);

    const applyRes = await fetch(`${baseUrl}/api/campaigns/${cid}/bot/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: lastMsg.id,
        proposalId: lastMsg.proposals[0].id,
      }),
    });
    assert.equal(applyRes.status, 200);
    snap = (await applyRes.json()) as CampaignSnapshot;
    assert.equal(snap.campaign.pacing, "steady");
    assert.equal(snap.botMessages.at(-1)?.proposals[0]?.applied, true);
  });
});

test("Meetings cloud doc import/export, Partners & Temp Staff tasks, Inspirations, and Form Sheet dedup sync", async () => {
  await withServer(async (baseUrl) => {
    // 1. Create a new campaign -> initializes Bot onboarding & comparable event inspirations
    const createRes = await fetch(`${baseUrl}/api/campaigns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "2026 產品設計與開發交流節",
        subtitle: "主題與談 · 圓桌工作坊",
        brief: "預計 140 人參與的設計與前端跨界單日活動",
        eventDate: "2026-10-18",
        postWeeks: 2,
      }),
    });
    assert.equal(createRes.status, 201);
    let snap = (await createRes.json()) as CampaignSnapshot;
    const cid = snap.campaign.id;
    assert.equal(snap.campaign.brief, "預計 140 人參與的設計與前端跨界單日活動");
    assert.ok(snap.inspirations.length >= 3);
    assert.ok(snap.botMessages[0]?.content.includes("跟我聊聊"));
    assert.ok(snap.botMessages[0]?.content.includes("靈感借鏡"));

    // 2. Import meeting from HackMD URL & export as .md and .doc
    const impRes = await fetch(`${baseUrl}/api/campaigns/${cid}/meetings/import-doc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docUrl: "https://hackmd.io/@bell/weekly-sync" }),
    });
    assert.equal(impRes.status, 201);
    const impBody = (await impRes.json()) as { meeting: { id: string; title: string; docSource: string }; snapshot: CampaignSnapshot };
    assert.equal(impBody.meeting.title, "雲端同步週會");
    assert.equal(impBody.meeting.docSource, "hackmd");

    const expMd = await fetch(`${baseUrl}/api/meetings/${impBody.meeting.id}/export?format=md`);
    assert.equal(expMd.status, 200);
    assert.match(await expMd.text(), /鎖定奇偶分流報到口/);

    const expDoc = await fetch(`${baseUrl}/api/meetings/${impBody.meeting.id}/export?format=doc`);
    assert.equal(expDoc.status, 200);
    assert.match(await expDoc.text(), /<h1/i);

    // 3. Add a Temp Staff partner with assigned tasks & toggle completion
    const teamId = impBody.snapshot.teams[0].id;
    const pRes = await fetch(`${baseUrl}/api/campaigns/${cid}/partners`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "temp_staff",
        name: "郭庭瑋",
        roleOrTopic: "報到台與動線引導",
        teamId,
        status: "confirmed",
        shiftOrFee: "10/18 08:30–17:30 · NT$2,000",
        tasks: [
          { id: "t1", title: "佈置報到雙通道立牌", done: false },
          { id: "t2", title: "中場茶點補水巡檢", done: false },
        ],
      }),
    });
    assert.equal(pRes.status, 201);
    snap = (await pRes.json()) as CampaignSnapshot;
    const staff = snap.partners.find((p) => p.name === "郭庭瑋");
    assert.ok(staff);
    assert.equal(staff.tasks.length, 2);

    const patchStaff = await fetch(`${baseUrl}/api/partners/${staff.id}?campaignId=${cid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tasks: [
          { id: "t1", title: "佈置報到雙通道立牌", done: true },
          { id: "t2", title: "中場茶點補水巡檢", done: false },
        ],
      }),
    });
    assert.equal(patchStaff.status, 200);
    snap = (await patchStaff.json()) as CampaignSnapshot;
    assert.equal(snap.partners.find((p) => p.id === staff.id)?.tasks[0]?.done, true);

    // 4. Recruitment Form Google Sheet sync deduplicates repeated syncs
    const formId = snap.forms[0].id;
    const sync1 = await fetch(`${baseUrl}/api/campaigns/${cid}/forms/${formId}/sync-sheet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sheetSyncUrl: "https://docs.google.com/spreadsheets/d/1dvyOuE0JzIRaylJAFH_9GMulxKG6rOSUNrIZt92hxO8/edit#gid=0",
      }),
    });
    assert.equal(sync1.status, 200);
    const syncBody1 = (await sync1.json()) as { importedCount: number; snapshot: CampaignSnapshot };
    assert.equal(syncBody1.importedCount, 2);

    const sync2 = await fetch(`${baseUrl}/api/campaigns/${cid}/forms/${formId}/sync-sheet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(sync2.status, 200);
    const syncBody2 = (await sync2.json()) as { importedCount: number; snapshot: CampaignSnapshot };
    assert.equal(syncBody2.importedCount, 0);
    assert.equal(syncBody2.snapshot.formResponses.length, syncBody1.snapshot.formResponses.length);
  });
});

test("Long-term multi-month timeline (>6 weeks), tentative dates, and non-destructive timeline expansion", async () => {
  await withServer(async (baseUrl) => {
    const createRes = await fetch(`${baseUrl}/api/campaigns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "TSCCTF 聯合新手資安賽",
        subtitle: "LiveCTF 跨校競賽",
        brief: "全台資安社新手社員競賽，11月確認賽制與Infra合作，12月報名宣傳，1月互驗與資格審核",
        startDate: "2026-11-13",
        eventDate: "2026-12-25",
        postWeeks: 2,
        dateTentative: true,
        tentativeNote: "預計 2027 年 2–3 月舉辦（日期待定）",
      }),
    });
    assert.equal(createRes.status, 201);
    let snap = (await createRes.json()) as CampaignSnapshot;
    const cid = snap.campaign.id;
    assert.equal(snap.campaign.dateTentative, true);
    assert.equal(snap.campaign.tentativeNote, "預計 2027 年 2–3 月舉辦（日期待定）");
    assert.equal(snap.weeks.filter((w) => w.phase === "prep").length, 6);
    assert.ok(snap.teams.some((t) => t.name === "出題組"));
    assert.ok(snap.teams.some((t) => t.name === "Infra 組"));

    // Add a dated todo before expanding timeline from 6 prep weeks to 16 prep weeks
    const targetWeek = snap.weeks[2];
    const todoRes = await fetch(`${baseUrl}/api/campaigns/${cid}/todos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        teamId: snap.teams[0].id,
        weekId: targetWeek.id,
        title: "11月底啟動第一批題目容器封裝",
        priority: "high",
      }),
    });
    assert.equal(todoRes.status, 201);

    // Expand timeline to late Feb (16 prep weeks) and verify zero todo loss
    const tlRes = await fetch(`${baseUrl}/api/campaigns/${cid}/timeline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startDate: "2026-11-13",
        eventDate: "2027-02-27",
        postWeeks: 2,
        dateTentative: true,
        tentativeNote: "預計 2027 年 2–3 月舉辦（日期待定）",
      }),
    });
    assert.equal(tlRes.status, 200);
    snap = (await tlRes.json()) as CampaignSnapshot;
    assert.equal(snap.weeks.filter((w) => w.phase === "prep").length, 16);
    assert.equal(snap.weeks[0]?.countdownLabel, "倒數 16 周");
    const preservedTodo = snap.todos.find((t) => t.title.includes("第一批題目容器封裝"));
    assert.ok(preservedTodo);
    assert.ok(preservedTodo.weekId && snap.weeks.some((w) => w.id === preservedTodo.weekId));

    // Rename campaign (e.g., TSCCTF-2026 -> TSCCTF-2027) with cascadeRename
    const renameRes = await fetch(`${baseUrl}/api/campaigns/${cid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "TSCCTF-2027",
        cascadeRename: true,
      }),
    });
    assert.equal(renameRes.status, 200);
    snap = (await renameRes.json()) as CampaignSnapshot;
    assert.equal(snap.campaign.name, "TSCCTF-2027");
    assert.ok(snap.forms[0]?.title.includes("TSCCTF-2027"));
    assert.ok(snap.inspirations.every((ins) => !ins.whySimilar.includes("TSCCTF-2026")));
  });
});

test("Formatted .xlsx workbook export, rich HTML clipboard table, and multi-slide presentation deck export", async () => {
  await withServer(async (baseUrl, store) => {
    const snap = store.getSnapshot();
    const cid = snap.campaign.id;

    // 1. Rich clipboard HTML includes colors, merges, and non-clipping wrap
    const clipHtml = buildStyledSheetClipboardHtml(snap);
    assert.match(clipHtml, /colspan="/);
    assert.match(clipHtml, /rowspan="/);
    assert.match(clipHtml, /background-color:#434343/);
    assert.match(clipHtml, /background-color:#FFF2CC/);
    assert.match(clipHtml, /solid #000000/);
    assert.match(clipHtml, /font-weight:700/);
    assert.match(clipHtml, /white-space:pre-wrap/);

    // 2. Native .xlsx export produces valid ZIP + OpenXML with custom column widths, wrapText, frozen panes, and mergeCells
    const xlsxRes = await fetch(`${baseUrl}/api/campaigns/${cid}/export.xlsx`);
    assert.equal(xlsxRes.status, 200);
    assert.match(xlsxRes.headers.get("content-type") ?? "", /spreadsheetml\.sheet/);
    const buf = Buffer.from(await xlsxRes.arrayBuffer());
    assert.equal(buf.readUInt32LE(0), 0x04034b50); // ZIP PK\x03\x04 signature

    // Walk local ZIP entries and verify xl/worksheets/sheet1.xml & xl/styles.xml decompress cleanly
    const entries = new Map<string, string>();
    let offset = 0;
    while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
      const compSize = buf.readUInt32LE(offset + 18);
      const nameLen = buf.readUInt16LE(offset + 26);
      const extraLen = buf.readUInt16LE(offset + 28);
      const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
      const dataStart = offset + 30 + nameLen + extraLen;
      const inflated = inflateRawSync(buf.subarray(dataStart, dataStart + compSize)).toString("utf8");
      entries.set(name, inflated);
      offset = dataStart + compSize;
    }
    assert.ok(entries.has("xl/worksheets/sheet1.xml"));
    assert.ok(entries.has("xl/styles.xml"));
    const sheetXml = entries.get("xl/worksheets/sheet1.xml")!;
    const stylesXml = entries.get("xl/styles.xml")!;
    assert.match(sheetXml, /<pane xSplit="2" ySplit="4"/);
    assert.match(sheetXml, /<mergeCell ref="A1:A2"\/>/);
    assert.match(sheetXml, /customWidth="1"/);
    assert.match(stylesXml, /wrapText="1"/);
    assert.match(stylesXml, /FF434343/);
    assert.match(stylesXml, /FF000000/);
    assert.match(stylesXml, /<b\/>/);

    // 3. Multi-slide Editorial Presentation Deck
    const slides = buildSlidesDeckModel(snap);
    assert.ok(slides.length >= 5);
    assert.equal(slides[0].kind, "cover");
    assert.equal(slides[1].kind, "roadmap");
    assert.equal(slides[2].kind, "radar");
    assert.equal(slides.at(-1)?.kind, "matrix");

    const deckRes = await fetch(`${baseUrl}/api/campaigns/${cid}/export-deck.html?theme=dark`);
    assert.equal(deckRes.status, 200);
    const deckHtml = await deckRes.text();
    assert.match(deckHtml, /data-deck-theme="dark"/);
    assert.match(deckHtml, /@page \{ size: 1280px 720px; margin: 0; \}/);
    assert.ok(deckHtml.includes(snap.campaign.name));
  });
});

test("Ponytail efficiency mode defaults to ultra, persists via PATCH /api/settings, and shapes prompts & Bot replies", async () => {
  await withServer(async (baseUrl, store) => {
    // 1. Default snapshot settings use ponytailMode === "ultra"
    const snapRes = await fetch(`${baseUrl}/api/snapshot`);
    assert.equal(snapRes.status, 200);
    const snap = (await snapRes.json()) as CampaignSnapshot;
    assert.equal(snap.settings.ponytailMode, "ultra");

    // 2. Prompt injection across modes
    assert.equal(applyPonytailPrompt("BASE_PROMPT", "off"), "BASE_PROMPT");
    assert.match(applyPonytailPrompt("BASE_PROMPT", "lite"), /Ponytail lite/);
    assert.match(applyPonytailPrompt("BASE_PROMPT", "full"), /Ponytail full/);
    assert.match(applyPonytailPrompt("BASE_PROMPT", "ultra"), /Ponytail ultra[\s\S]*先質疑冗餘/);

    // 3. Builtin Campaign Bot includes Ponytail Ultra review note by default
    const ultraReply = await replyCampaignBot(
      snap,
      "目前整體狀況如何？",
      snap.settings,
      new AbortController().signal,
    );
    assert.match(ultraReply.content, /Ponytail Ultra 精簡檢視/);
    assert.doesNotMatch(ultraReply.content, /你可以直接對我說/);

    // 4. External LLM runner receives injected Ponytail ultra rule + thinkingEffort calibration
    let capturedPrompt = "";
    await replyCampaignBot(
      snap,
      "幫我規劃下週議程",
      { provider: "codex", model: "", ponytailMode: "ultra", thinkingEffort: "xhigh", botAutoApply: true },
      new AbortController().signal,
      async (prompt) => {
        capturedPrompt = prompt;
        return { content: "已精簡議程", proposals: [] };
      },
    );
    assert.match(capturedPrompt, /Ponytail ultra/);
    assert.match(capturedPrompt, /思考深度（xhigh/);

    // 5. PATCH /api/settings persists ponytailMode, thinkingEffort, and botAutoApply
    assert.equal(snap.settings.thinkingEffort, "medium");
    assert.equal(snap.settings.botAutoApply, true);
    const patchRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ponytailMode: "full", thinkingEffort: "high" }),
    });
    assert.equal(patchRes.status, 200);
    const updated = (await patchRes.json()) as ProviderSettings;
    assert.equal(updated.ponytailMode, "full");
    assert.equal(updated.thinkingEffort, "high");
    assert.equal(store.getSettings().thinkingEffort, "high");

    // 6. Proactive Campaign Bot splits compound team & migrates tasks immediately upon user request
    const cid = snap.campaign.id;
    const compoundTeam = store.addTeam(cid, { name: "總召&轉播組", lead: "owl_d", targetHeadcount: 5 });
    const broadcastTodo = store.addTodo(cid, {
      teamId: compoundTeam.id,
      weekId: snap.weeks[0].id,
      title: "OBS 導播彩排 & 排裁判值班表",
      priority: "high",
    });
    const generalTodo = store.addTodo(cid, {
      teamId: compoundTeam.id,
      weekId: snap.weeks[0].id,
      title: "五校社團時間對齊",
      priority: "normal",
    });

    const splitChatRes = await fetch(`${baseUrl}/api/campaigns/${cid}/bot/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "轉播組我覺得可以獨立一組" }),
    });
    assert.equal(splitChatRes.status, 200);
    const afterSplit = (await splitChatRes.json()) as CampaignSnapshot;
    const lastBot = afterSplit.botMessages.at(-1)!;
    assert.equal(lastBot.proposals[0]?.kind, "split_team");
    assert.equal(lastBot.proposals[0]?.applied, true);

    const renamedLeadTeam = afterSplit.teams.find((t) => t.id === compoundTeam.id);
    const newBroadcastTeam = afterSplit.teams.find((t) => t.name === "轉播組");
    assert.equal(renamedLeadTeam?.name, "總召組");
    assert.ok(newBroadcastTeam);
    assert.equal(newBroadcastTeam.orderIndex, renamedLeadTeam!.orderIndex + 1);
    assert.equal(afterSplit.todos.find((t) => t.id === broadcastTodo.id)?.teamId, newBroadcastTeam.id);
    assert.equal(afterSplit.todos.find((t) => t.id === generalTodo.id)?.teamId, compoundTeam.id);

    // 7. Spreadsheet model includes all teams without truncating after 3 teams
    for (const extra of ["贊助組", "財務組", "設計組"]) {
      store.addTeam(cid, { name: extra, targetHeadcount: 3 });
    }
    const fullSnap = store.getSnapshot(cid);
    assert.ok(fullSnap.teams.length >= 8);
    const sheetModel = buildStyledSheetModel(fullSnap);
    const colAValues = sheetModel.cells.map((r) => r[0]?.value).filter(Boolean);
    for (const tm of fullSnap.teams) {
      assert.ok(colAValues.some((v) => v.includes(tm.name)), `Expected team ${tm.name} in styled sheet model`);
    }
  });
});

test("Inline PDF headers, MIME inference on .md upload, Bot QUICK_PROMPTS[0], split_team regex safety, and xlsx edge cases", async () => {
  await withServer(async (baseUrl, store) => {
    const snap = store.getSnapshot();
    const cid = snap.campaign.id;

    // 1. Upload PDF and verify ?inline=1 vs ?download=1 vs SVG sandbox headers
    const pdfBase64 = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n").toString("base64");
    const pdfUp = await fetch(`${baseUrl}/api/campaigns/${cid}/files/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "廠商電力配置圖",
        category: "vendor",
        fileName: "power-plan.pdf",
        mimeType: "application/octet-stream",
        dataBase64: pdfBase64,
      }),
    });
    assert.equal(pdfUp.status, 201);
    const snapAfterPdf = (await pdfUp.json()) as CampaignSnapshot;
    const pdfFile = snapAfterPdf.files.find((f) => f.title === "廠商電力配置圖");
    assert.ok(pdfFile);
    assert.equal(pdfFile.mimeType, "application/pdf");

    const inlineRes = await fetch(`${baseUrl}/api/files/${pdfFile.id}/raw?inline=1`);
    assert.equal(inlineRes.status, 200);
    assert.equal(inlineRes.headers.get("content-type"), "application/pdf");
    assert.equal(inlineRes.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.match(inlineRes.headers.get("content-disposition") ?? "", /^inline;/);
    const inlineCsp = inlineRes.headers.get("content-security-policy") ?? "";
    assert.match(inlineCsp, /frame-ancestors 'self'/);
    assert.doesNotMatch(inlineCsp, /sandbox/);

    const dlRes = await fetch(`${baseUrl}/api/files/${pdfFile.id}/raw?download=1`);
    assert.equal(dlRes.status, 200);
    assert.match(dlRes.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.match(dlRes.headers.get("content-security-policy") ?? "", /sandbox/);

    // 2. Upload .md with application/octet-stream -> inferred text/markdown + populated contentMd
    const mdContent = "# 志工簽到說明\n\n- [x] 測試項目\n- [ ] 尚未完成";
    const mdUp = await fetch(`${baseUrl}/api/campaigns/${cid}/files/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "志工簽到 Markdown",
        category: "handbook",
        fileName: "checkin.md",
        mimeType: "application/octet-stream",
        dataBase64: Buffer.from(mdContent, "utf8").toString("base64"),
      }),
    });
    assert.equal(mdUp.status, 201);
    const snapAfterMd = (await mdUp.json()) as CampaignSnapshot;
    const mdFile = snapAfterMd.files.find((f) => f.title === "志工簽到 Markdown");
    assert.ok(mdFile);
    assert.equal(mdFile.mimeType, "text/markdown");
    assert.equal(mdFile.contentMd, mdContent);

    // 3. Bot QUICK_PROMPTS[0] never creates bogus "並把相關待辦移轉過去組"
    const quickPrompt = "幫我檢視目前有沒有複合組別可以拆開獨立運作，或直接幫我新增組別並把相關待辦移轉過去。";
    const qpRes = await fetch(`${baseUrl}/api/campaigns/${cid}/bot/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: quickPrompt }),
    });
    assert.equal(qpRes.status, 200);
    const afterQp = (await qpRes.json()) as CampaignSnapshot;
    assert.ok(!afterQp.teams.some((t) => t.name.includes("並把相關待辦移轉過去")));

    // Also test QUICK_PROMPTS[0] when NO compound teams remain
    const noCompoundSnap: CampaignSnapshot = {
      ...afterQp,
      teams: [{ id: "tm-1", campaignId: cid, name: "議程組", lead: "", color: "rose", targetHeadcount: 4, orderIndex: 0 }],
    };
    const noCompReply = await replyCampaignBot(noCompoundSnap, quickPrompt, afterQp.settings, new AbortController().signal);
    assert.equal(noCompReply.proposals.length, 0);
    assert.match(noCompReply.content, /暫無/);

    // 4. split_team with regex metacharacters (C++&AI組) and 與 separator (行銷與設計組)
    const cppTeam = store.addTeam(cid, { name: "C++&AI組", lead: "dev", targetHeadcount: 4 });
    store.addTodo(cid, { teamId: cppTeam.id, weekId: snap.weeks[0].id, title: "準備 C++ 講義", priority: "high" });
    const splitCpp = await fetch(`${baseUrl}/api/campaigns/${cid}/bot/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "把「C++組」拆出來" }),
    });
    assert.equal(splitCpp.status, 200);
    const afterCpp = (await splitCpp.json()) as CampaignSnapshot;
    assert.ok(afterCpp.teams.some((t) => t.name === "C++組"));
    assert.equal(afterCpp.teams.find((t) => t.id === cppTeam.id)?.name, "AI組");

    const mktTeam = store.addTeam(cid, { name: "公關與贊助組", lead: "des", targetHeadcount: 4 });
    const splitMkt = await fetch(`${baseUrl}/api/campaigns/${cid}/bot/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "贊助組可以獨立出來" }),
    });
    assert.equal(splitMkt.status, 200);
    const afterMkt = (await splitMkt.json()) as CampaignSnapshot;
    assert.ok(afterMkt.teams.some((t) => t.name === "贊助組"));
    assert.equal(afterMkt.teams.find((t) => t.id === mktTeam.id)?.name, "公關組");

    // 5. botAutoApply wording alignment
    const autoOnReply = await replyCampaignBot(
      snap,
      "幫我把排程調成穩健緩衝",
      { ...snap.settings, botAutoApply: true },
      new AbortController().signal,
    );
    assert.match(autoOnReply.content, /已直接套用/);
    assert.doesNotMatch(autoOnReply.content, /點擊下方卡片/);

    const autoOffReply = await replyCampaignBot(
      snap,
      "幫我把排程調成穩健緩衝",
      { ...snap.settings, botAutoApply: false },
      new AbortController().signal,
    );
    assert.match(autoOffReply.content, /點擊下方卡片/);

    // 6. Styled sheet model & XLSX edge cases: leading/trailing quote in campaign name, special chars, empty weeks/teams
    const edgeSnap: CampaignSnapshot = {
      ...snap,
      campaign: { ...snap.campaign, name: "'2026 & <Edge> \"Test\"'" },
      weeks: [],
      teams: [],
      cells: [],
      todos: [],
    };
    const edgeModel = buildStyledSheetModel(edgeSnap);
    assert.ok(!edgeModel.sheetName.startsWith("'"));
    assert.ok(!edgeModel.sheetName.endsWith("'"));
    const edgeXlsx = buildCampaignXlsxBuffer(edgeSnap);
    assert.equal(edgeXlsx.readUInt32LE(0), 0x04034b50);
  });
});
