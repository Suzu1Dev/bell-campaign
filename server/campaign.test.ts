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
