import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_MODEL_PRESETS,
  formatShortcut,
  getModKeyLabel,
  resolveInitialTheme,
  resolveModelOnProviderSwitch,
  stripEffortSuffix,
} from "./uiPrefs";

test("resolveInitialTheme respects saved preference, OS dark preference, and handles errors/SSR", () => {
  const mkStorage = (val: string | null) => ({ getItem: () => val });
  const darkMm = () => ({ matches: true });
  const lightMm = () => ({ matches: false });

  assert.equal(resolveInitialTheme({ storage: mkStorage("light"), matchMedia: darkMm }), "light");
  assert.equal(resolveInitialTheme({ storage: mkStorage("DARK"), matchMedia: lightMm }), "dark");
  assert.equal(resolveInitialTheme({ storage: mkStorage(null), matchMedia: darkMm }), "dark");
  assert.equal(resolveInitialTheme({ storage: mkStorage("unknown"), matchMedia: darkMm }), "dark");
  assert.equal(resolveInitialTheme({ storage: mkStorage(null), matchMedia: lightMm }), "light");

  const throwingStorage = {
    getItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(resolveInitialTheme({ storage: throwingStorage, matchMedia: darkMm }), "dark");
  assert.equal(resolveInitialTheme({ storage: null, matchMedia: null }), "light");
});

test("getModKeyLabel & formatShortcut distinguish Apple vs non-Apple platforms", () => {
  assert.equal(getModKeyLabel("MacIntel"), "⌘");
  assert.equal(getModKeyLabel("iPhone"), "⌘");
  assert.equal(getModKeyLabel("Linux x86_64"), "Ctrl");
  assert.equal(getModKeyLabel("Win32"), "Ctrl");
  assert.equal(getModKeyLabel(""), "Ctrl");

  assert.equal(formatShortcut("K", "MacIntel"), "⌘K");
  assert.equal(formatShortcut("1–5", "MacIntel"), "⌘1–5");
  assert.equal(formatShortcut("K", "Linux x86_64"), "Ctrl+K");
  assert.equal(formatShortcut("1–5", "Linux x86_64"), "Ctrl+1–5");
});

test("PROVIDER_MODEL_PRESETS and resolveModelOnProviderSwitch keep verified models & reset incompatible ones", () => {
  assert.ok(PROVIDER_MODEL_PRESETS.antigravity.some((m) => m.id === "gemini-4-hydrogen"));
  assert.ok(PROVIDER_MODEL_PRESETS.codex.some((m) => m.id === "gpt-6.2-sol"));
  assert.equal(
    PROVIDER_MODEL_PRESETS.codex.some((m) => m.id === "gpt-5.2-codex" || m.id === "o4-mini"),
    false,
  );

  assert.equal(stripEffortSuffix("gemini-4-hydrogen-high"), "gemini-4-hydrogen");
  assert.equal(stripEffortSuffix("gpt-6.2-sol-xhigh"), "gpt-6.2-sol");

  // Incompatible preset resets to provider default
  assert.equal(resolveModelOnProviderSwitch("gemini-4-hydrogen", "codex"), "");
  assert.equal(resolveModelOnProviderSwitch("gemini-4-hydrogen-high", "claude"), "");
  assert.equal(resolveModelOnProviderSwitch("gpt-6.2-sol", "antigravity"), "");
  assert.equal(resolveModelOnProviderSwitch("gemini-4-hydrogen", "builtin"), "");

  // Shared preset or custom ID preserves cleanly
  assert.equal(resolveModelOnProviderSwitch("claude-sonnet-5-5", "claude"), "claude-sonnet-5-5");
  assert.equal(resolveModelOnProviderSwitch("claude-sonnet-5-5", "antigravity"), "claude-sonnet-5-5");
  assert.equal(resolveModelOnProviderSwitch("my-custom-finetune", "codex"), "my-custom-finetune");
});
