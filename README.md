# BELL Campaign

**English** · [繁體中文](./README.zh-TW.md)

Local-first weekly countdown timeline, team progress, recruitment gap radar, and event operations workspace built for conference/event directors and cross-functional teams.

Runs out-of-the-box as an **independent Standalone App** (zero environment variables or external API keys required — includes a built-in deterministic Campaign Bot and 5-level pacing scheduler) or as part of **[BELL Suite](https://github.com/Suzu1Dev/bell-suite)** alongside Personal, Explain, BELL PR, and Web Reader.

## Quick Start

### Install in One Line (macOS / Linux / WSL)

```bash
curl -fsSL https://raw.githubusercontent.com/Suzu1Dev/bell-campaign/main/install.sh | sh
bell-campaign
```

The installer checks npm first and automatically falls back to cloning from GitHub (`~/.local/share/bell-campaign/app`) and symlinking `~/.local/bin/bell-campaign`, bootstrapping Node.js 24 if needed.

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/Suzu1Dev/bell-campaign/main/install.ps1 | iex
bell-campaign
```

### Run via `npx` or From Source

```bash
# Run directly with npx
npx bell-campaign

# Or clone and run from source
git clone https://github.com/Suzu1Dev/bell-campaign.git
cd bell-campaign
npm install && npm run build
./bin/bell-campaign.mjs start
```

## CLI Usage

```text
bell-campaign [start] [--port <n>] [--host <h>] [--no-open] [--suite]
bell-campaign doctor [--json]
bell-campaign --version | --help
```

- **Standalone Edition (default)**: listens on `http://127.0.0.1:4640` with local SQLite storage in `./data/` (checkout) or `~/.bell-campaign/data/` (global install).
- **BELL Suite Edition (`--suite` or `bell-suite start`)**: listens on `http://127.0.0.1:4605`, exposes `/api/suite/manifest` and `/api/suite/today`, accepts `#/tasks?draft=...` handoffs, and sends campaign tasks/notes directly to BELL Personal (`#/tasks`), BELL Explain (`#/explain`), or BELL PR (`#/discover`).

## Key Capabilities

- **Weekly Countdown Matrix (`#/schedule`)**: Google Sheets-compatible multi-team timeline with automatic contiguous stage merging, conflict warnings, 16:9 slide deck mode, and single-file `.html` offline share export.
- **5-Level Pacing Scheduler**: Preview weekly workload distribution across *Relaxed*, *Buffered*, *Balanced*, * brisk*, and *Sprint* cadences.
- **Tasks, Partners, Recruitment Radar, Handbooks & Cloud Docs**: Manage team tasks (`#/tasks`), speakers/vendors/staff (`#/partners`), volunteer shift coverage (`#/forms`), handbook generation (`#/files`), and bidirectional Google Docs / HackMD meeting notes (`#/meetings`).

## Architecture Overview

```text
bin/bell-campaign.mjs  Standalone & Suite CLI (start, doctor, --version, --help)
src/                   React 19 workspace (Schedule, Tasks, Partners, Forms, Files,
                       Meetings, Inspirations, Notes, Campaign Bot, Suite switcher)
shared/                Google Sheets TSV/CSV matrix engine, Google Docs/HackMD parser,
                       5-level pacing scheduler, and Suite Contract v1 routes
server/                Express 5 API, SQLite store (node:sqlite), sandboxed uploads,
                       built-in & optional external AI runners
Formula/               Homebrew formula template
```

## Development & Verification

Requires **Node.js 22.13+** (Node.js 24 LTS recommended) for built-in `node:sqlite`.

```bash
npm install
npm run dev        # Vite frontend + API watch
npm test           # Unit & API integration test suite
npm run build      # TypeScript check + production Vite bundle
```

## License

[Apache-2.0](./LICENSE) · [Trademarks](./TRADEMARKS.md)
