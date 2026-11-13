import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { CampaignStore } from "./store.js";
import { createApp } from "./app.js";
import type { CampaignSnapshot } from "../shared/types.js";
import type { SuiteManifest, SuiteTodayFeed } from "../shared/suite.js";

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
  });
});
