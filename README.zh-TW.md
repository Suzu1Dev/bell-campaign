# BELL Campaign

[English](./README.md) · **繁體中文**

專為活動總召與團隊籌備設計的**本機優先每週倒數專案時程與團隊協作工作台**。可單獨執行（Standalone Edition），也可與 [BELL Suite](https://github.com/Suzu1Dev/bell-suite)（Personal、Explain、PR、Web Reader）串聯運作。

## 一鍵安裝與 CLI 啟動

```bash
# macOS / Linux / WSL
curl -fsSL https://raw.githubusercontent.com/Suzu1Dev/bell-campaign/main/install.sh | sh
bell-campaign

# 或直接透過 npx 啟動
npx bell-campaign
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Suzu1Dev/bell-campaign/main/install.ps1 | iex
bell-campaign
```

常用 CLI 指令：

```bash
bell-campaign start               # 獨立模式啟動（預設 http://127.0.0.1:4640）
bell-campaign start --suite       # BELL Suite 模式啟動（預設 http://127.0.0.1:4605）
bell-campaign doctor              # 檢查 Node、SQLite、資料目錄與選用 AI CLI 狀態
```

## 核心設計與功能

1. **Google 試算表結構對齊的每週倒數矩陣（`#/schedule`）**
   - 從籌備起點切分至「活動當週」與「活動後 1–2 週復盤」，上方標示月份分組、整體進度百分比、重大里程碑與**撞期大型活動警示**（例如 `COSCUP`、人員入伍等），排程時一眼避開高風險時段。
   - 各大組別連續週次若處於同一進度階段（如 `進度20%`、`進度50%`、`復盤`），自動合併為**橫跨多週的連續階段橫條**並去除重複文字。
2. **Google 試算表／簡報／Google 文件／HackMD 與免登入分享中心**
   - **雙向試算表相容**：支援貼上公開 Google 試算表網址或 CSV 匯入；一鍵複製 TSV 矩陣直接貼進 Google 試算表 `A1`、下載 UTF-8 BOM `.csv`，或複製 Google Apps Script 自動同步腳本。
   - **會議記錄雲端雙向互通（`#/meetings`）**：支援 **Google 文件** 與 **HackMD** 雙向匯入與匯出。
   - **免登入團隊分享**：匯出單檔離線可讀 `.html` 互動時程表，或一鍵複製 LINE／Discord／Slack 本週籌備週報。
3. **AI 自動排程與 5 段時程緊湊度調節器**
   - 依 **「從容留白 · 穩健緩衝 · 均衡適中 · 緊湊推進 · 密集衝刺」** 五段節奏即時預覽每週負荷分佈圖。
4. **待辦、合作名單、招工雷達、文件手冊與 BELL Suite 雙向交接**
   - 待辦清單支援一鍵送往 `BELL Personal`（`#/tasks`）與 `BELL PR`（`#/discover`），個人筆記支援送往 `BELL Explain`（`#/explain`），並支援接收來自姊妹應用的 `#/tasks?draft=...` 與 `#/handoff` 跨工具草稿。

## 開發與測試

```bash
npm install
npm run dev
npm test
npm run build
```

## 授權

[Apache-2.0](./LICENSE) · [Trademarks](./TRADEMARKS.md)
