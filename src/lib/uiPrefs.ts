import type { AiProvider } from "../../shared/types";

export interface ThemeEnv {
  storage?: Pick<Storage, "getItem"> | null;
  matchMedia?: ((query: string) => { matches: boolean }) | null;
}

export function resolveInitialTheme(env?: ThemeEnv): "light" | "dark" {
  try {
    const storage =
      env && "storage" in env
        ? env.storage
        : typeof globalThis !== "undefined" && "localStorage" in globalThis
          ? globalThis.localStorage
          : null;
    const saved = storage?.getItem("bell.theme")?.trim().toLowerCase();
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // ignore storage access errors
  }

  try {
    const mm =
      env && "matchMedia" in env
        ? env.matchMedia
        : typeof globalThis !== "undefined" && typeof globalThis.matchMedia === "function"
          ? globalThis.matchMedia.bind(globalThis)
          : null;
    if (mm?.("(prefers-color-scheme: dark)")?.matches) return "dark";
  } catch {
    // ignore matchMedia errors
  }

  return "light";
}

export function getModKeyLabel(platformStr?: string): "⌘" | "Ctrl" {
  const raw =
    platformStr !== undefined
      ? platformStr
      : typeof globalThis !== "undefined" && "navigator" in globalThis
        ? ((globalThis.navigator as { userAgentData?: { platform?: string }; platform?: string; userAgent?: string })
            .userAgentData?.platform ||
          globalThis.navigator?.platform ||
          globalThis.navigator?.userAgent ||
          "")
        : "";
  return /Mac|iPhone|iPad|iPod/i.test(raw) ? "⌘" : "Ctrl";
}

export function formatShortcut(key: string, platformStr?: string): string {
  const mod = getModKeyLabel(platformStr);
  return mod === "⌘" ? `⌘${key}` : `Ctrl+${key}`;
}

export function stripEffortSuffix(model: string): string {
  return model.trim().replace(/-(low|medium|high|xhigh|max)$/i, "");
}

export const PROVIDER_MODEL_PRESETS: Record<
  Exclude<AiProvider, "builtin">,
  Array<{ id: string; label: string }>
> = {
  antigravity: [
    { id: "gemini-4-hydrogen", label: "Hydrogen · 旗艦" },
    { id: "gemini-4-carbon", label: "Carbon · 均衡" },
    { id: "gemini-3.8-flash", label: "3.8 Flash · 極速" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    { id: "claude-opus-5-5", label: "Opus 5.5" },
  ],
  claude: [
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5 · 均衡" },
    { id: "claude-opus-5-5", label: "Opus 5.5 · 旗艦" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5 · 極速" },
  ],
  codex: [
    { id: "gpt-6.2-sol", label: "GPT-6.2 Sol · 旗艦" },
    { id: "gpt-6.2-astra", label: "GPT-6.2 Astra · 均衡" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol · 輕量" },
  ],
  api: [
    { id: "gpt-4.1", label: "GPT-4.1" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    { id: "o4-mini", label: "o4-mini" },
  ],
};

export function resolveModelOnProviderSwitch(currentModel: string, nextProvider: AiProvider): string {
  const trimmed = currentModel.trim();
  if (!trimmed || nextProvider === "builtin") return "";
  const base = stripEffortSuffix(trimmed);
  const nextIds = new Set(PROVIDER_MODEL_PRESETS[nextProvider].map((p) => p.id));
  if (nextIds.has(base)) return trimmed;

  for (const [provider, presets] of Object.entries(PROVIDER_MODEL_PRESETS)) {
    if (provider === nextProvider) continue;
    if (presets.some((p) => p.id === base)) return "";
  }
  return trimmed;
}
