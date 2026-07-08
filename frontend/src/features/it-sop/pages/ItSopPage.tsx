import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckSquareOutlined,
  CodeOutlined,
  DownOutlined,
  FileTextOutlined,
  ReloadOutlined,
  SaveOutlined,
  TableOutlined,
  UpOutlined,
} from "@ant-design/icons";
import { isAxiosError } from "axios";
import { Link, useParams } from "react-router-dom";
import { extractErrorMessage, getErrorCode, isUnauthorized } from "../../../api/apiErrors";
import {
  fetchItSopDocument,
  saveItSopDocument,
  type ItSopDocument,
  type ItSopSection,
  type ItSopSectionKind,
} from "../../../api/itSop";
import { ItSopOutline } from "../components/ItSopOutline";
import { ItSopSectionEditor } from "../components/ItSopSectionEditor";
import "../styles/it-sop-page.css";
import {
  createSection,
  duplicateSection,
  formatSectionForClipboard,
  SECTION_KIND_LABELS,
} from "../utils/itSopEditorModels";

const DEFAULT_DOCUMENT_ID = "wk-e-pc-001";
const INITIAL_DOCUMENT_UPDATED_AT = new Date(0).toISOString();

interface DraftPayload {
  savedAt: string;
  document: ItSopDocument;
}

function draftKey(documentId: string): string {
  return `it-sop-draft:${documentId}`;
}

function readDraft(documentId: string): DraftPayload | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(draftKey(documentId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DraftPayload;
    if (!parsed || parsed.document?.id !== documentId || typeof parsed.savedAt !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeDraft(document: ItSopDocument): void {
  if (typeof window === "undefined") return;
  const payload: DraftPayload = {
    savedAt: new Date().toISOString(),
    document,
  };
  window.localStorage.setItem(draftKey(document.id), JSON.stringify(payload));
}

function clearDraft(documentId: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(draftKey(documentId));
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  let copied = false;
  try {
    textarea.select();
    copied = document.execCommand("copy");
  } finally {
    textarea.remove();
  }
  if (!copied) {
    throw new Error("clipboard copy failed");
  }
}

function buildSaveErrorMessage(error: unknown): string {
  const code = getErrorCode(error);
  if (code === "IT_SOP_VERSION_CONFLICT") {
    return "server 已有新版本，已保留本機草稿。請先重新讀取或放棄本機草稿，再決定要套用哪一版。";
  }
  if (isUnauthorized(error) || (isAxiosError(error) && error.response?.status === 403)) {
    return "需要管理員登入後才能儲存。已保留本機草稿，請先登入管理員再重試。";
  }
  return extractErrorMessage(error, "儲存失敗，已保留本機草稿。請檢查網路或稍後再試。");
}

function isLegacyTemplateDraft(draft: DraftPayload, serverDocument: ItSopDocument): boolean {
  const draftVersion = Number(draft.document.templateVersion ?? 0);
  const serverVersion = Number(serverDocument.templateVersion ?? 0);
  return (
    serverDocument.updatedAt === INITIAL_DOCUMENT_UPDATED_AT &&
    draft.document.updatedAt === serverDocument.updatedAt &&
    serverVersion > draftVersion
  );
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
    return items;
  }
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

function renderSectionKindIcon(kind: ItSopSectionKind) {
  if (kind === "table") return <TableOutlined aria-hidden="true" />;
  if (kind === "checklist") return <CheckSquareOutlined aria-hidden="true" />;
  if (kind === "code") return <CodeOutlined aria-hidden="true" />;
  return <FileTextOutlined aria-hidden="true" />;
}

export function ItSopPage() {
  const params = useParams<{ documentId?: string }>();
  const documentId = params.documentId || DEFAULT_DOCUMENT_ID;

  const [document, setDocument] = useState<ItSopDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftLoadedAt, setDraftLoadedAt] = useState<string | null>(null);
  const skipNextDraftWriteRef = useRef(false);
  const latestDocumentRef = useRef<ItSopDocument | null>(null);
  const loadRequestIdRef = useRef(0);
  const documentRevisionRef = useRef(0);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const hasUnsavedChangesRef = useRef(false);
  const savingRef = useRef(false);

  const setUnsavedChanges = useCallback((value: boolean) => {
    hasUnsavedChangesRef.current = value;
    setHasUnsavedChanges(value);
  }, []);

  const replaceDocument = useCallback(
    (nextDocument: ItSopDocument, options: { dirty: boolean }) => {
      latestDocumentRef.current = nextDocument;
      setDocument(nextDocument);
      setUnsavedChanges(options.dirty);
    },
    [setUnsavedChanges]
  );

  const markUserEdit = useCallback(() => {
    documentRevisionRef.current += 1;
    setUnsavedChanges(true);
  }, [setUnsavedChanges]);

  const loadDocument = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const serverDocument = await fetchItSopDocument(documentId);
      if (loadRequestIdRef.current !== requestId) return;
      const draft = readDraft(documentId);
      skipNextDraftWriteRef.current = true;
      if (draft && isLegacyTemplateDraft(draft, serverDocument)) {
        replaceDocument(serverDocument, { dirty: false });
        setDraftLoadedAt(draft.savedAt);
        setNotice(
          "已偵測到舊版精簡本機草稿，先顯示新版完整 SOP 範本；確認不需要舊草稿後可按「放棄本機草稿」。"
        );
      } else if (draft) {
        replaceDocument(draft.document, { dirty: true });
        setDraftLoadedAt(draft.savedAt);
        setNotice(
          draft.document.updatedAt === serverDocument.updatedAt
            ? "已載入這台電腦的本機草稿，按「儲存到 server」後才會同步給其他人。"
            : "已載入本機草稿，但 server 已有不同版本。請先確認內容；若要改用 server 版本，按「放棄本機草稿」。"
        );
      } else {
        replaceDocument(serverDocument, { dirty: false });
        setDraftLoadedAt(null);
      }
    } catch (loadError) {
      if (loadRequestIdRef.current !== requestId) return;
      console.error("[itSop] load failed", loadError);
      setError(
        isUnauthorized(loadError)
          ? "需要管理員登入後才能讀取 SOP 文件。請先進入 Dev 模式登入。"
          : "SOP 文件讀取失敗，請稍後重試。"
      );
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [documentId, replaceDocument]);

  useEffect(() => {
    void loadDocument();
    return () => {
      loadRequestIdRef.current += 1;
    };
  }, [loadDocument]);

  useEffect(() => {
    latestDocumentRef.current = document;
  }, [document]);

  useEffect(() => {
    if (!document || loading || saving) return;
    if (skipNextDraftWriteRef.current) {
      skipNextDraftWriteRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      writeDraft(document);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [document, loading, saving]);

  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const latestDocument = latestDocumentRef.current;
      if (latestDocument && hasUnsavedChangesRef.current) {
        writeDraft(latestDocument);
      }
      if (!hasUnsavedChangesRef.current && !savingRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  const confirmLeavingWithUnsavedChanges = useCallback(() => {
    const latestDocument = latestDocumentRef.current;
    if (latestDocument && hasUnsavedChangesRef.current) {
      writeDraft(latestDocument);
    }
    if (!hasUnsavedChangesRef.current && !savingRef.current) return true;
    return window.confirm("SOP 有尚未儲存到 server 的修改，已先保留本機草稿。確定要離開嗎？");
  }, []);

  useEffect(() => {
    const handleDocumentClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.altKey ||
        event.ctrlKey ||
        event.shiftKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }
      if (!confirmLeavingWithUnsavedChanges()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.document.addEventListener("click", handleDocumentClick, true);
    return () => {
      window.document.removeEventListener("click", handleDocumentClick, true);
    };
  }, [confirmLeavingWithUnsavedChanges]);

  useEffect(() => {
    const handlePopState = () => {
      const latestDocument = latestDocumentRef.current;
      if (latestDocument && hasUnsavedChangesRef.current) {
        writeDraft(latestDocument);
      }
      if (!hasUnsavedChangesRef.current && !savingRef.current) return;
      window.alert("SOP 有尚未儲存到 server 的修改，已先保留本機草稿。");
    };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    }
  }, []);

  const updatedDescription = useMemo(() => {
    if (!document) return "";
    if (document.updatedAt === INITIAL_DOCUMENT_UPDATED_AT) {
      return "尚未儲存 server 正式版本";
    }
    const by = document.updatedByLabel ? `，${document.updatedByLabel}` : "";
    return `${new Date(document.updatedAt).toLocaleString()}${by}`;
  }, [document]);

  function updateDocument(patch: Partial<Pick<ItSopDocument, "title" | "summary">>) {
    markUserEdit();
    setDocument((current) => {
      const nextDocument = current ? { ...current, ...patch } : current;
      latestDocumentRef.current = nextDocument;
      return nextDocument;
    });
  }

  function updateSection(sectionId: string, updater: (section: ItSopSection) => ItSopSection) {
    markUserEdit();
    setDocument((current) => {
      if (!current) return current;
      const nextDocument = {
        ...current,
        sections: current.sections.map((section) =>
          section.id === sectionId ? updater(section) : section
        ),
      };
      latestDocumentRef.current = nextDocument;
      return nextDocument;
    });
  }

  function addSection(kind: ItSopSectionKind) {
    markUserEdit();
    setDocument((current) => {
      if (!current) return current;
      const nextDocument = {
        ...current,
        sections: [...current.sections, createSection(kind)],
      };
      latestDocumentRef.current = nextDocument;
      return nextDocument;
    });
  }

  function removeSection(sectionId: string) {
    const sectionTitle =
      latestDocumentRef.current?.sections.find((section) => section.id === sectionId)?.title || "這個段落";
    if (!window.confirm(`確定要刪除「${sectionTitle}」？此操作要儲存後才會同步到 server。`)) {
      return;
    }
    markUserEdit();
    setDocument((current) => {
      if (!current) return current;
      const nextDocument = {
        ...current,
        sections: current.sections.filter((section) => section.id !== sectionId),
      };
      latestDocumentRef.current = nextDocument;
      return nextDocument;
    });
  }

  function moveSection(sectionId: string, direction: -1 | 1) {
    markUserEdit();
    setDocument((current) => {
      if (!current) return current;
      const fromIndex = current.sections.findIndex((section) => section.id === sectionId);
      const nextDocument = {
        ...current,
        sections: moveItem(current.sections, fromIndex, fromIndex + direction),
      };
      latestDocumentRef.current = nextDocument;
      return nextDocument;
    });
  }

  function duplicateSectionAfter(sectionId: string) {
    markUserEdit();
    setDocument((current) => {
      if (!current) return current;
      const fromIndex = current.sections.findIndex((section) => section.id === sectionId);
      if (fromIndex < 0) return current;
      const nextSections = [...current.sections];
      nextSections.splice(fromIndex + 1, 0, duplicateSection(current.sections[fromIndex]));
      const nextDocument = {
        ...current,
        sections: nextSections,
      };
      latestDocumentRef.current = nextDocument;
      return nextDocument;
    });
  }

  async function copySectionToClipboard(sectionId: string) {
    const section = latestDocumentRef.current?.sections.find((current) => current.id === sectionId);
    if (!section) return;
    try {
      await writeClipboardText(formatSectionForClipboard(section));
      setError(null);
      setNotice(`已複製「${section.title || "未命名段落"}」內容到剪貼簿。`);
    } catch (copyError) {
      console.error("[itSop] copy section failed", copyError);
      setError("複製到剪貼簿失敗，請確認瀏覽器權限後再試。");
    }
  }

  function setAllSectionsCollapsed(collapsed: boolean) {
    markUserEdit();
    setDocument((current) => {
      if (!current) return current;
      const nextDocument = {
        ...current,
        sections: current.sections.map((section) => ({ ...section, collapsed })),
      };
      latestDocumentRef.current = nextDocument;
      return nextDocument;
    });
  }

  const handleSave = useCallback(async () => {
    if (!document) return;
    const revisionAtSubmit = documentRevisionRef.current;
    const documentAtSubmit = document;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveItSopDocument(documentAtSubmit);
      if (documentRevisionRef.current === revisionAtSubmit) {
        skipNextDraftWriteRef.current = true;
        replaceDocument(saved, { dirty: false });
        clearDraft(saved.id);
        setDraftLoadedAt(null);
        setNotice("已儲存到 server，其他人重新開啟會看到這個版本。");
      } else {
        const latestDocument = latestDocumentRef.current;
        if (latestDocument) {
          writeDraft(latestDocument);
          setDraftLoadedAt(new Date().toISOString());
        }
        setNotice("送出時的版本已儲存到 server；你剛剛的新修改已保留為本機草稿，請再按一次儲存同步。");
      }
    } catch (saveError) {
      console.error("[itSop] save failed", saveError);
      setError(buildSaveErrorMessage(saveError));
      const latestDocument = latestDocumentRef.current ?? documentAtSubmit;
      writeDraft(latestDocument);
    } finally {
      setSaving(false);
    }
  }, [document, replaceDocument]);

  function handleDiscardDraft() {
    clearDraft(documentId);
    setDraftLoadedAt(null);
    void loadDocument();
  }

  function handleReloadClick() {
    const latestDocument = latestDocumentRef.current;
    if (latestDocument && hasUnsavedChangesRef.current) {
      writeDraft(latestDocument);
      setDraftLoadedAt(new Date().toISOString());
    }
    void loadDocument();
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (savingRef.current || !latestDocumentRef.current) return;
      void handleSave();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleSave]);

  if (loading) {
    return (
      <main className="it-sop_page">
        <div className="it-sop_loading">讀取 SOP 文件中...</div>
      </main>
    );
  }

  if (!document) {
    return (
      <main className="it-sop_page">
        <div className="it-sop_error">{error || "SOP 文件不存在。"}</div>
        <button className="it-sop_button" type="button" onClick={() => void loadDocument()}>
          重新讀取
        </button>
      </main>
    );
  }

  const statusLabel = hasUnsavedChanges
    ? "本機變更"
    : draftLoadedAt
    ? "本機草稿"
    : document.updatedAt === INITIAL_DOCUMENT_UPDATED_AT
      ? "尚未儲存"
      : "已同步";
  const statusClassName = hasUnsavedChanges || draftLoadedAt
    ? "draft"
    : document.updatedAt === INITIAL_DOCUMENT_UPDATED_AT
      ? "unsaved"
      : "synced";

  return (
    <main className="it-sop_page">
      <header className="it-sop_header">
        <div className="it-sop_headerText">
          <nav className="it-sop_nav" aria-label="SOP 頁面導覽">
            <Link className="it-sop_back" to="/dev">
              返回 Dev 模式
            </Link>
            <Link className="it-sop_back" to="/it/duty">
              返回 IT 值班表
            </Link>
          </nav>
          <div className="it-sop_titleRow">
            <input
              className="it-sop_titleInput"
              value={document.title}
              onChange={(event) => updateDocument({ title: event.target.value })}
              aria-label="SOP 標題"
            />
            <span className={`it-sop_statusPill ${statusClassName}`}>{statusLabel}</span>
          </div>
          <div className="it-sop_metaGrid" aria-label="文件狀態">
            <span>
              <strong>文件 ID</strong>
              {document.id}
            </span>
            <span>
              <strong>版本</strong>
              v{document.templateVersion}
            </span>
            <span>
              <strong>更新</strong>
              {updatedDescription}
            </span>
            {draftLoadedAt ? (
              <span>
                <strong>草稿</strong>
                {new Date(draftLoadedAt).toLocaleString()}
              </span>
            ) : null}
          </div>
        </div>
        <div className="it-sop_actions">
          {draftLoadedAt ? (
            <button className="it-sop_button subtle" type="button" onClick={handleDiscardDraft}>
              放棄本機草稿
            </button>
          ) : null}
          <button className="it-sop_button subtle" type="button" onClick={handleReloadClick}>
            <ReloadOutlined aria-hidden="true" />
            重新讀取
          </button>
          <button
            className="it-sop_button primary"
            type="button"
            disabled={saving}
            onClick={() => void handleSave()}
          >
            <SaveOutlined aria-hidden="true" />
            {saving ? "儲存中..." : "儲存到 server"}
          </button>
        </div>
      </header>

      {notice ? <div className="it-sop_notice">{notice}</div> : null}
      {error ? <div className="it-sop_error">{error}</div> : null}

      <div className="it-sop_workspace">
        <div className="it-sop_documentColumn">
          <section className="it-sop_summaryBox" aria-label="總結">
            <strong>總結</strong>
            <textarea
              id="sop-summary-input"
              value={document.summary}
              onChange={(event) => updateDocument({ summary: event.target.value })}
              aria-label="SOP 總結"
            />
          </section>

          <section className="it-sop_toolbar" aria-label="新增 SOP 段落">
            <span>新增段落</span>
            {(["text", "table", "checklist", "code"] as ItSopSectionKind[]).map((kind) => (
              <button
                className="it-sop_button subtle"
                type="button"
                key={kind}
                onClick={() => addSection(kind)}
              >
                {renderSectionKindIcon(kind)}
                {SECTION_KIND_LABELS[kind]}
              </button>
            ))}
            <span className="it-sop_toolbarDivider" aria-hidden="true" />
            <button
              className="it-sop_button subtle"
              type="button"
              onClick={() => setAllSectionsCollapsed(false)}
            >
              <DownOutlined aria-hidden="true" />
              全部展開
            </button>
            <button
              className="it-sop_button subtle"
              type="button"
              onClick={() => setAllSectionsCollapsed(true)}
            >
              <UpOutlined aria-hidden="true" />
              全部收合
            </button>
          </section>

          <section className="it-sop_sections">
            {document.sections.map((section, index) => (
              <ItSopSectionEditor
                key={section.id}
                section={section}
                index={index}
                onUpdate={(updater) => updateSection(section.id, updater)}
                onRemove={() => removeSection(section.id)}
                onMoveUp={() => moveSection(section.id, -1)}
                onMoveDown={() => moveSection(section.id, 1)}
                onDuplicate={() => duplicateSectionAfter(section.id)}
                onCopy={() => void copySectionToClipboard(section.id)}
                canMoveUp={index > 0}
                canMoveDown={index < document.sections.length - 1}
              />
            ))}
          </section>
        </div>

        <ItSopOutline sections={document.sections} />
      </div>
    </main>
  );
}
