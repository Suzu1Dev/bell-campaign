import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SuiteHandoffMenu, { suiteHandoffTargets } from "./SuiteHandoffMenu";

const LINKS = {
  explain: "http://127.0.0.1:20001",
  reader: "http://127.0.0.1:21104",
  personal: "http://127.0.0.1:20003",
  pr: "http://127.0.0.1:20002",
};

test("suiteHandoffTargets filters unlinked/unsafe origins and preserves 4-sibling order", () => {
  const targets = suiteHandoffTargets(
    { ...LINKS, pr: "https://evil.example.com" },
    { text: "行前手冊重點", title: "工作人員手冊", url: "https://hackmd.io/@bell/guide", back: "#/files" },
    "127.0.0.1",
  );
  assert.deepEqual(
    targets.map((t) => t.id),
    ["explain", "reader", "personal"],
  );
  assert.ok(targets[0]?.href.includes("/#/explain?"));
  assert.ok(targets[1]?.href.includes("/#/read?"));
  assert.ok(targets[1]?.href.includes("url=https%3A%2F%2Fhackmd.io%2F%40bell%2Fguide"));
  assert.ok(targets[2]?.href.includes("/#/tasks?"));

  assert.deepEqual(
    suiteHandoffTargets(LINKS, { text: "   \n\t  ", back: "#/notes" }, "127.0.0.1"),
    [],
  );
});

test("SuiteHandoffMenu SSR markup renders trigger only when targets exist", () => {
  const emptyHtml = renderToStaticMarkup(
    createElement(SuiteHandoffMenu, {
      links: {},
      text: "筆記內容",
      back: "#/notes",
    }),
  );
  assert.equal(emptyHtml, "");

  const blankTextHtml = renderToStaticMarkup(
    createElement(SuiteHandoffMenu, {
      links: LINKS,
      text: "   ",
      back: "#/notes",
    }),
  );
  assert.equal(blankTextHtml, "");

  const html = renderToStaticMarkup(
    createElement(SuiteHandoffMenu, {
      links: LINKS,
      text: "確認講者簡報比例",
      title: "講者確認",
      back: "#/tasks",
      compact: true,
    }),
  );
  assert.match(html, /suite-handoff-trigger/);
  assert.match(html, /is-compact/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /傳送到 Suite/);
});
