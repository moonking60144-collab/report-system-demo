import { useMemo, type FormEvent } from "react";
import { CloseOutlined } from "@ant-design/icons";
import type { RagicDefinitionForm } from "../../../api/devRagicDefinitions";
import { isCompleteFormPath } from "./ragicDefinitionsExplorerUtils";

export function FormPickerModal({
  forms,
  query,
  lookupPath,
  selectedPath,
  onQueryChange,
  onSelect,
  onClose,
}: {
  forms: RagicDefinitionForm[];
  query: string;
  lookupPath: string;
  selectedPath: string | null;
  onQueryChange: (query: string) => void;
  onSelect: (formPath: string) => void;
  onClose: () => void;
}) {
  const canOpenLookup = isCompleteFormPath(lookupPath);
  const normalizedQuery = query.trim();
  const showParsedPath = Boolean(
    normalizedQuery && lookupPath && lookupPath !== normalizedQuery
  );
  const groups = useMemo(() => {
    const groupMap = new Map<string, RagicDefinitionForm[]>();
    for (const form of forms) {
      const [namespace, category] = form.formPath.split("/");
      const key = category ? `${namespace}/${category}` : namespace || "未分類";
      const current = groupMap.get(key);
      if (current) {
        current.push(form);
      } else {
        groupMap.set(key, [form]);
      }
    }
    return Array.from(groupMap.entries())
      .map(([name, groupForms]) => ({ name, forms: groupForms }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [forms]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canOpenLookup) {
      onSelect(lookupPath);
    }
  }

  return (
    <div
      className="ragic-defs__picker-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="ragic-defs__picker-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ragic-defs-picker-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="ragic-defs__picker-head">
          <div>
            <h3 id="ragic-defs-picker-title">選擇表單</h3>
            <span>{forms.length.toLocaleString()} 筆符合目前條件</span>
          </div>
          <button
            type="button"
            className="dev-mode-btn ragic-defs__picker-close"
            onClick={onClose}
            aria-label="關閉表單選擇"
          >
            <CloseOutlined />
          </button>
        </header>
        <form className="ragic-defs__picker-search" onSubmit={handleSubmit}>
          <input
            type="search"
            className="ragic-inline__search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="貼上 Ragic 網址、表單路徑或輸入表單名稱"
            aria-label="篩選 definition 表單"
            autoFocus
          />
          <button type="submit" className="dev-mode-btn" disabled={!canOpenLookup}>
            開啟表單
          </button>
        </form>
        {showParsedPath ? (
          <p className="ragic-defs__picker-parsed">
            已辨識：<code>{lookupPath}</code>
          </p>
        ) : null}
        {groups.length ? (
          <div className="ragic-defs__picker-groups">
            {groups.map((group) => (
              <section key={group.name} className="ragic-defs__picker-group">
                <div className="ragic-defs__picker-group-head">
                  <strong>{group.name}</strong>
                  <span>{group.forms.length}</span>
                </div>
                <div className="ragic-defs__picker-list">
                  {group.forms.map((form) => (
                    <button
                      key={form.formPath}
                      type="button"
                      className={`ragic-defs__picker-row${
                        selectedPath === form.formPath ? " is-active" : ""
                      }`}
                      onClick={() => onSelect(form.formPath)}
                    >
                      <span>{form.formName || "(未命名)"}</span>
                      <code>{form.formPath}</code>
                      <small>
                        {form.counts.fields} 欄 · {form.counts.formulas} 公式 ·{" "}
                        {form.counts.workflows} workflow
                      </small>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <p className="ragic-inline__hint">沒有符合條件的表單。</p>
        )}
      </section>
    </div>
  );
}
