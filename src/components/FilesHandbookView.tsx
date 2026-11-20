import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  BookOpen,
  Columns2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Image as ImageIcon,
  Pencil,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  FILE_CATEGORIES,
  type CampaignFile,
  type CampaignSnapshot,
  type FileCategory,
  type HandbookTemplate,
} from "../../shared/types";
import { inferUploadMimeType } from "../../shared/docs";
import { apiWrite } from "../lib/api";
import MarkdownPreview from "./MarkdownPreview";

type FilePreviewKind = "image" | "pdf" | "markdown" | "text" | "binary";

function classifyFilePreview(file: CampaignFile): FilePreviewKind {
  const mime = (file.mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf" || /\.pdf$/i.test(file.fileName)) return "pdf";
  if (file.kind === "generated" || mime === "text/markdown" || /\.(md|markdown)$/i.test(file.fileName)) {
    return "markdown";
  }
  if (mime.startsWith("text/") || mime === "application/json" || /\.(txt|csv|json|log)$/i.test(file.fileName)) {
    return "text";
  }
  return "binary";
}

function getFileTypeBadge(file: CampaignFile): string {
  const kind = classifyFilePreview(file);
  if (kind === "pdf") return "PDF";
  if (kind === "markdown") return "MD";
  const ext = file.fileName.trim().split(".").pop()?.toUpperCase();
  if (ext && ext.length <= 5 && ext !== file.fileName.toUpperCase()) return ext;
  return "FILE";
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const CATEGORY_LABELS: Record<FileCategory, string> = {
  handbook: "行前手冊／提醒",
  social: "社群發文圖片",
  vendor: "廠商檔案",
  slides: "簡報企劃",
  other: "其他歸檔",
};

const TEMPLATE_OPTIONS: Array<{ id: HandbookTemplate; label: string; hint: string }> = [
  { id: "staff_lazy_pack", label: "籌備人員懶人包手冊", hint: "集合時間、整點流程、各組窗口與應變守則" },
  { id: "speaker_handbook", label: "講者與談人行前手冊", hint: "報到動線、16:9 簡報規格、時間舉牌與接待窗口" },
  { id: "speaker_reminder", label: "講者／志工行前提醒信", hint: "可直接寄出的精簡倒數通知與交通報帳提醒" },
  { id: "vendor_brief", label: "協力廠商進撤場須知", hint: "貨梯時間窗、電力音控規格與核銷請款說明" },
];

export default function FilesHandbookView({
  snapshot,
  onSnapshot,
  notify,
}: {
  snapshot: CampaignSnapshot;
  onSnapshot: (next: CampaignSnapshot) => void;
  notify: (msg: string) => void;
}) {
  const [catFilter, setCatFilter] = useState<"all" | FileCategory>("all");
  const [template, setTemplate] = useState<HandbookTemplate>("staff_lazy_pack");
  const [recipientName, setRecipientName] = useState("");
  const [sessionTitle, setSessionTitle] = useState("");
  const [sessionTime, setSessionTime] = useState("09:00 報到 · 09:40 正式開始");
  const [venue, setVenue] = useState("台北數位創新基地 A 棟展演廳");
  const [extraNotes, setExtraNotes] = useState("");
  const [genBusy, setGenBusy] = useState(false);

  const [viewingFile, setViewingFile] = useState<CampaignFile | null>(null);
  const [editDocText, setEditDocText] = useState("");
  const [docViewMode, setDocViewMode] = useState<"preview" | "split" | "edit">("preview");
  const [loadingRawText, setLoadingRawText] = useState(false);

  const openFileModal = (file: CampaignFile) => {
    setViewingFile(file);
    setEditDocText(file.contentMd);
    setDocViewMode("preview");
  };

  useEffect(() => {
    if (!viewingFile) return;
    const kind = classifyFilePreview(viewingFile);
    if ((kind !== "markdown" && kind !== "text") || viewingFile.contentMd) {
      setLoadingRawText(false);
      return;
    }
    let cancelled = false;
    setLoadingRawText(true);
    fetch(`/api/files/${viewingFile.id}/raw`)
      .then((res) => (res.ok ? res.text() : ""))
      .then((txt) => {
        if (!cancelled && txt) setEditDocText(txt);
      })
      .catch(() => {
        // ignore fallback read errors
      })
      .finally(() => {
        if (!cancelled) setLoadingRawText(false);
      });
    return () => {
      cancelled = true;
    };
  }, [viewingFile]);

  // Upload dialog state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadCat, setUploadCat] = useState<FileCategory>("social");
  const [uploadTeamId, setUploadTeamId] = useState<string>("");
  const [pickedFile, setPickedFile] = useState<{ name: string; type: string; base64: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const visibleFiles = snapshot.files.filter((f) => catFilter === "all" || f.category === catFilter);

  async function handleGenerateHandbook() {
    setGenBusy(true);
    try {
      const res = await apiWrite<{
        generated: { title: string; contentMd: string };
        file: CampaignFile | null;
        snapshot: CampaignSnapshot;
      }>(`/api/campaigns/${snapshot.campaign.id}/files/generate-handbook`, "POST", {
        template,
        recipientName: recipientName.trim() || undefined,
        sessionTitle: sessionTitle.trim() || undefined,
        sessionTime: sessionTime.trim() || undefined,
        venue: venue.trim() || undefined,
        extraNotes: extraNotes.trim() || undefined,
        saveToArchive: true,
      });
      onSnapshot(res.snapshot);
      if (res.file) {
        openFileModal(res.file);
      }
      notify("已自動生成並歸檔行前文件");
    } catch (err) {
      notify(err instanceof Error ? err.message : "生成失敗");
    } finally {
      setGenBusy(false);
    }
  }

  function onPickLocalFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) {
      notify("單一檔案請勿超過 8MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const resolvedMime = inferUploadMimeType(f.name, f.type);
      setPickedFile({ name: f.name, type: resolvedMime, base64: result });
      if (!uploadTitle.trim()) {
        setUploadTitle(f.name.replace(/\.[^.]+$/, ""));
      }
      if (resolvedMime.startsWith("image/")) setUploadCat("social");
    };
    reader.readAsDataURL(f);
  }

  async function handleConfirmUpload() {
    if (!pickedFile || !uploadTitle.trim()) return;
    try {
      const next = await apiWrite<CampaignSnapshot>(
        `/api/campaigns/${snapshot.campaign.id}/files/upload`,
        "POST",
        {
          title: uploadTitle.trim(),
          category: uploadCat,
          teamId: uploadTeamId || null,
          fileName: pickedFile.name,
          mimeType: pickedFile.type,
          dataBase64: pickedFile.base64,
        },
      );
      onSnapshot(next);
      setPickedFile(null);
      setUploadTitle("");
      setUploadOpen(false);
      notify("已歸檔檔案");
    } catch (err) {
      notify(err instanceof Error ? err.message : "上傳失敗");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* AI Handbook & Pre-Event Reminder Generator */}
      <section className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div>
            <strong style={{ fontSize: 15 }}>AI 自動生成行前手冊與行前提醒</strong>
            <div style={{ fontSize: 12.5, color: "var(--text-3)", marginTop: 2 }}>
              自動串接目前活動日期、組別聯絡窗口與撞期注意事項，一鍵產出懶人包或講者通知
            </div>
          </div>
          <button type="button" className="btn" onClick={() => setUploadOpen(true)}>
            <Upload size={14} />
            <span>上傳歸檔檔案（社群圖／廠商檔）</span>
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
          {TEMPLATE_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setTemplate(opt.id)}
              style={{
                textAlign: "left",
                padding: "10px 12px",
                borderRadius: "var(--radius-sm)",
                border: `1px solid ${template === opt.id ? "var(--campaign)" : "var(--line)"}`,
                background: template === opt.id ? "var(--campaign-tint)" : "var(--panel)",
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13.5, color: template === opt.id ? "var(--campaign-text)" : "var(--text)" }}>
                {opt.label}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 3 }}>{opt.hint}</div>
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
          <div>
            <label className="field-label">收件對象／講者或廠商名稱</label>
            <input
              className="input"
              value={recipientName}
              onChange={(e) => setRecipientName(e.target.value)}
              placeholder={template.startsWith("speaker") ? "例如：林宥辰 老師" : "例如：全體籌備幹部與志工"}
            />
          </div>
          <div>
            <label className="field-label">場次主題／專案區塊</label>
            <input
              className="input"
              value={sessionTitle}
              onChange={(e) => setSessionTitle(e.target.value)}
              placeholder="例如：跨領域產品設計 Panel 與談"
            />
          </div>
          <div>
            <label className="field-label">報到與場次時間</label>
            <input className="input" value={sessionTime} onChange={(e) => setSessionTime(e.target.value)} />
          </div>
          <div>
            <label className="field-label">活動場地與交通指引</label>
            <input className="input" value={venue} onChange={(e) => setVenue(e.target.value)} />
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 320px" }}>
            <label className="field-label">補充叮嚀（題綱重點、飲食統編、設備需求等，選填）</label>
            <input
              className="input"
              value={extraNotes}
              onChange={(e) => setExtraNotes(e.target.value)}
              placeholder="例如：圓桌共有三輪每次 25 分鐘；現場備有雙系統轉接頭"
            />
          </div>
          <button type="button" className="btn btn-primary" disabled={genBusy} onClick={handleGenerateHandbook}>
            <Sparkles size={14} />
            <span>{genBusy ? "正在生成手冊…" : "立即生成並存入歸檔"}</span>
          </button>
        </div>
      </section>

      {/* File Archive Filter & Cards */}
      <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              className={`btn btn-sm ${catFilter === "all" ? "btn-primary" : ""}`}
              onClick={() => setCatFilter("all")}
            >
              全部歸檔 ({snapshot.files.length})
            </button>
            {FILE_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                className={`btn btn-sm ${catFilter === c ? "btn-primary" : ""}`}
                onClick={() => setCatFilter(c)}
              >
                {CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
        </div>

        <div className="file-grid">
          {visibleFiles.map((file) => {
            const previewKind = classifyFilePreview(file);
            const isImage = previewKind === "image";
            const badgeLabel = getFileTypeBadge(file);
            const team = snapshot.teams.find((t) => t.id === file.teamId);
            return (
              <div
                key={file.id}
                className="card"
                style={{ overflow: "hidden", display: "flex", flexDirection: "column", cursor: "pointer" }}
                onClick={() => openFileModal(file)}
              >
                <div className="file-thumb">
                  {isImage ? (
                    <img src={`/api/files/${file.id}/raw`} alt={file.title} loading="lazy" />
                  ) : previewKind === "markdown" && file.contentMd ? (
                    <div style={{ padding: 14, fontSize: 12, color: "var(--text-2)", lineHeight: 1.5, width: "100%", height: "100%", overflow: "hidden" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginBottom: 4 }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--campaign-text)", fontWeight: 600 }}>
                          <BookOpen size={14} />
                          <span>{file.kind === "generated" ? "AI 生成手冊" : "Markdown 文件"}</span>
                        </span>
                        <span className="file-type-badge">{badgeLabel}</span>
                      </div>
                      {file.contentMd.replace(/^#+\s*/gm, "").slice(0, 110)}…
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                      <FileText size={30} style={{ color: "var(--text-3)" }} />
                      <span className={`file-type-badge ${previewKind === "pdf" ? "is-pdf" : ""}`}>{badgeLabel}</span>
                    </div>
                  )}
                </div>

                <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                    <span className={`pill ${file.category === "handbook" ? "pill-campaign" : ""}`}>
                      {CATEGORY_LABELS[file.category]}
                    </span>
                    {team && <span style={{ fontSize: 12, color: "var(--text-3)" }}>{team.name}</span>}
                  </div>
                  <strong style={{ fontSize: 13.5, lineHeight: 1.4 }}>{file.title}</strong>
                  <div style={{ marginTop: "auto", paddingTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "var(--text-3)" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.fileName}</span>
                    {isImage ? <ImageIcon size={13} /> : <FileText size={13} />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* View / Edit File or Handbook Modal */}
      <Dialog.Root open={Boolean(viewingFile)} onOpenChange={(o) => !o && setViewingFile(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content is-wide">
            {viewingFile &&
              (() => {
                const previewKind = classifyFilePreview(viewingFile);
                const canEditDoc = viewingFile.kind === "generated";
                const canCopyText = previewKind === "markdown" || previewKind === "text";
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <div style={{ minWidth: 0 }}>
                        <Dialog.Title style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                          {viewingFile.title}
                        </Dialog.Title>
                        <div style={{ fontSize: 12.5, color: "var(--text-3)", marginTop: 2 }}>
                          {CATEGORY_LABELS[viewingFile.category]} · {viewingFile.fileName}
                          {viewingFile.sizeBytes > 0 ? ` · ${formatFileSize(viewingFile.sizeBytes)}` : ""}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {previewKind === "markdown" && (
                          <div className="segmented-inline" role="tablist" aria-label="文件檢視模式">
                            <button
                              type="button"
                              role="tab"
                              aria-selected={docViewMode === "preview"}
                              className={`seg-btn ${docViewMode === "preview" ? "is-active" : ""}`}
                              onClick={() => setDocViewMode("preview")}
                            >
                              <Eye size={12} />
                              <span>預覽</span>
                            </button>
                            <button
                              type="button"
                              role="tab"
                              aria-selected={docViewMode === "split"}
                              className={`seg-btn ${docViewMode === "split" ? "is-active" : ""}`}
                              onClick={() => setDocViewMode("split")}
                            >
                              <Columns2 size={12} />
                              <span>並排</span>
                            </button>
                            <button
                              type="button"
                              role="tab"
                              aria-selected={docViewMode === "edit"}
                              className={`seg-btn ${docViewMode === "edit" ? "is-active" : ""}`}
                              onClick={() => setDocViewMode("edit")}
                            >
                              <Pencil size={12} />
                              <span>{canEditDoc ? "編輯" : "原始碼"}</span>
                            </button>
                          </div>
                        )}
                        <Dialog.Close asChild>
                          <button type="button" className="icon-btn" aria-label="關閉">
                            <X size={15} />
                          </button>
                        </Dialog.Close>
                      </div>
                    </div>

                    {previewKind === "image" ? (
                      <div style={{ background: "var(--panel)", borderRadius: "var(--radius-md)", padding: 12, border: "1px solid var(--line)", textAlign: "center" }}>
                        <img
                          src={`/api/files/${viewingFile.id}/raw`}
                          alt={viewingFile.title}
                          style={{ maxWidth: "100%", maxHeight: "460px", borderRadius: "var(--radius-sm)" }}
                        />
                      </div>
                    ) : previewKind === "pdf" ? (
                      <iframe
                        src={`/api/files/${viewingFile.id}/raw?inline=1`}
                        title={viewingFile.title}
                        className="file-pdf-frame"
                      />
                    ) : previewKind === "markdown" ? (
                      loadingRawText ? (
                        <div style={{ padding: 24, textAlign: "center", color: "var(--text-3)", fontSize: 13 }}>
                          正在讀取 Markdown 文件內容…
                        </div>
                      ) : docViewMode === "preview" ? (
                        <MarkdownPreview content={editDocText} />
                      ) : docViewMode === "split" ? (
                        <div className="md-split-pane">
                          <textarea
                            className="textarea"
                            rows={16}
                            readOnly={!canEditDoc}
                            value={editDocText}
                            onChange={(e) => canEditDoc && setEditDocText(e.target.value)}
                            style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, minHeight: 360 }}
                          />
                          <MarkdownPreview content={editDocText} />
                        </div>
                      ) : (
                        <textarea
                          className="textarea"
                          rows={15}
                          readOnly={!canEditDoc}
                          value={editDocText}
                          onChange={(e) => canEditDoc && setEditDocText(e.target.value)}
                          style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}
                        />
                      )
                    ) : previewKind === "text" ? (
                      loadingRawText ? (
                        <div style={{ padding: 24, textAlign: "center", color: "var(--text-3)", fontSize: 13 }}>
                          正在讀取檔案內容…
                        </div>
                      ) : (
                        <pre className="file-text-pre">{editDocText || "（空檔案）"}</pre>
                      )
                    ) : (
                      <div className="file-binary-card">
                        <span className="file-type-badge" style={{ fontSize: 12, padding: "4px 10px" }}>
                          {getFileTypeBadge(viewingFile)}
                        </span>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{viewingFile.fileName}</div>
                        <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>
                          {viewingFile.mimeType} · {formatFileSize(viewingFile.sizeBytes)}
                        </div>
                        <a className="btn btn-primary btn-sm" href={`/api/files/${viewingFile.id}/raw?download=1`} download={viewingFile.fileName}>
                          <Download size={13} />
                          <span>下載此檔案</span>
                        </a>
                      </div>
                    )}

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {previewKind === "pdf" && (
                          <a
                            className="btn btn-sm"
                            href={`/api/files/${viewingFile.id}/raw?inline=1`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ExternalLink size={13} />
                            <span>新分頁開啟</span>
                          </a>
                        )}
                        <a className="btn btn-sm" href={`/api/files/${viewingFile.id}/raw?download=1`} download={viewingFile.fileName}>
                          <Download size={13} />
                          <span>下載檔案</span>
                        </a>
                        {canCopyText && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={async () => {
                              await navigator.clipboard.writeText(editDocText);
                              notify("已複製文件內容");
                            }}
                          >
                            <Copy size={13} />
                            <span>複製全文</span>
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={async () => {
                            try {
                              const next = await apiWrite<CampaignSnapshot>(
                                `/api/files/${viewingFile.id}?campaignId=${encodeURIComponent(snapshot.campaign.id)}`,
                                "DELETE",
                              );
                              onSnapshot(next);
                              setViewingFile(null);
                              notify("已刪除歸檔項目");
                            } catch (err) {
                              notify(err instanceof Error ? err.message : "刪除失敗");
                            }
                          }}
                        >
                          <Trash2 size={13} />
                          <span>刪除</span>
                        </button>
                      </div>

                      {canEditDoc && editDocText.trim().length > 0 && (
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={async () => {
                            try {
                              const next = await apiWrite<CampaignSnapshot>(
                                `/api/campaigns/${snapshot.campaign.id}/files/doc`,
                                "POST",
                                {
                                  id: viewingFile.id,
                                  title: viewingFile.title,
                                  category: viewingFile.category,
                                  teamId: viewingFile.teamId,
                                  contentMd: editDocText,
                                },
                              );
                              onSnapshot(next);
                              setViewingFile(null);
                              notify("已更新手冊內容");
                            } catch (err) {
                              notify(err instanceof Error ? err.message : "儲存修改失敗");
                            }
                          }}
                        >
                          儲存修改
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Upload File Dialog */}
      <Dialog.Root open={uploadOpen} onOpenChange={setUploadOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content" style={{ maxWidth: 480 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Dialog.Title style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>上傳並歸檔專案檔案</Dialog.Title>
                <Dialog.Close asChild>
                  <button type="button" className="icon-btn" aria-label="關閉">
                    <X size={15} />
                  </button>
                </Dialog.Close>
              </div>

              <input ref={fileInputRef} type="file" onChange={onPickLocalFile} style={{ display: "none" }} />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={{
                  padding: "22px 16px",
                  borderRadius: "var(--radius-md)",
                  border: "1px dashed var(--line-2)",
                  background: "var(--panel)",
                  cursor: "pointer",
                  textAlign: "center",
                }}
              >
                <Upload size={20} style={{ margin: "0 auto 6px", color: "var(--campaign-text)" }} />
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {pickedFile ? `已選擇：${pickedFile.name}` : "點擊選擇圖片、PDF、廠商報價單或企劃檔"}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>支援 PNG / JPG / SVG / PDF / Markdown（上限 8MB）</div>
              </button>

              <div>
                <label className="field-label">歸檔標題</label>
                <input
                  className="input"
                  value={uploadTitle}
                  onChange={(e) => setUploadTitle(e.target.value)}
                  placeholder="例如：首波講者公開 IG 貼文圖卡"
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label className="field-label">分類</label>
                  <select className="select" value={uploadCat} onChange={(e) => setUploadCat(e.target.value as FileCategory)}>
                    {FILE_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label">所屬組別</label>
                  <select className="select" value={uploadTeamId} onChange={(e) => setUploadTeamId(e.target.value)}>
                    <option value="">全專案共用</option>
                    {snapshot.teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
                <button type="button" className="btn" onClick={() => setUploadOpen(false)}>
                  取消
                </button>
                <button type="button" className="btn btn-primary" disabled={!pickedFile || !uploadTitle.trim()} onClick={handleConfirmUpload}>
                  確認歸檔
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
