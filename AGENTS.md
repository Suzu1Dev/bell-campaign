# BELL Campaign Development

PONYTAIL MODE ACTIVE — level: ultra

Active for the whole session at level **ultra** by default, until the user says "stop ponytail", "normal mode", or `/ponytail off`. Switch level: `/ponytail lite|full|ultra`.

## Ultra Discipline (Default)

1. **Question unjustified scope first**: Before building, inspect whether every part of a request is justified by the real event-operations need. Push back on redundant workflows, premature abstractions, or unrequested options, and name the smaller option in one line. Explicit user requirements always take precedence once confirmed.
2. **Smallest complete change**: Read the touched code and list callers, shared types, SQLite store, API routes, exports, and tests before editing. Reuse existing project helpers first, then Node/Web standard APIs, then installed dependencies. Never add a dependency for a few lines.
3. **Root cause & verification**: Fix bugs once in shared code after grepping callers. Add or extend one focused test in `server/*.test.ts` or `shared/*.test.ts` for new non-trivial logic, and run `npm test` + `npm run build`.
4. **Concise closeout**: End every reply with one or two lines stating what you skipped or did not check, and any risk the user must know. Shortcuts with known limits get a `shortcut: <limit>, <when to upgrade>` comment.

| Level | Behavior |
|-------|----------|
| **lite** | Build what was asked. Name the smaller option in one line and let the user pick. |
| **full** | Smallest complete change, zero unrequested features/wrappers, 1–2 line skip/risk closeout. |
| **ultra** | Full rules + question any part of the request the real need does not justify before building. **Default (active).** |

## BELL Campaign Invariants

Never cut these boundaries:

1. **Copy tone (`zh-TW`)**: Keep UI labels, schedules, exports, and Bot copy concise, direct, and spoken-professional—no filler openers or padded bullet prose.
2. **Security & Suite Contract v1**: Keep `/api/suite/manifest`, `/api/suite/today`, and `Host` / `Origin` / `Sec-Fetch-Site` / JSON `Content-Type` write guards intact. Keep `UNTRUSTED_BOUNDARY` on all external LLM prompts.
3. **Backward-compatible SQLite persistence**: Existing `data/bell-campaign.sqlite` databases must load without destructive migration. New `ProviderSettings` (`ponytailMode` defaults to `"ultra"`) and table columns must fall back safely on older rows.
4. **Visual & service safety**: Visually verify UI changes in both Light and Dark themes via Playwright before sign-off. Restart the live preview with `systemctl --user restart bell-campaign-preview.service`—never run broad `pkill -f` commands that could hit sibling BELL services.
