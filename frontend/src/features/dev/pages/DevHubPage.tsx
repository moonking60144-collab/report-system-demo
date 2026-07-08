import { useState } from "react";
import { Link } from "react-router-dom";
import { DEV_TOOLS, DEV_GROUP_ORDER, DEV_GROUP_META } from "../config/devTools";
import { useDevContext } from "../layout/devContext";
import { useDevFormBookmarks, type DevFormRef } from "../hooks/useDevFormBookmarks";
import { RagicFormDetailModal } from "../components/RagicFormDetailModal";
import { formatRelativeTime, syncHealth } from "../utils/devSyncHealth";

/**
 * 總覽 = 開發者儀表板（/dev index）：系統概覽（表單/欄位/索引健康）+ 釘選 + 最近開啟（點開明細）
 * + 各群工具入口卡。sidebar 是常駐快速切換，這頁是進來的落地儀表板。
 */
export function DevHubPage() {
  const { token, ragic, onAuthFailure } = useDevContext();
  const { recent, pinned, togglePin, isPinned } = useDevFormBookmarks();
  const [selectedForm, setSelectedForm] = useState<{ path: string; name: string } | null>(null);
  const fail = () => onAuthFailure("session expired, please login again");
  const openForm = (formPath: string, formName: string) =>
    setSelectedForm({ path: formPath, name: formName });

  const state = ragic.state;
  const health = syncHealth(state);

  return (
    <div className="dev-dash">
      <section className="dev-dash__stats">
        <div className="dev-stat">
          <span className="dev-stat__num">{state ? state.totalForms.toLocaleString() : "—"}</span>
          <span className="dev-stat__label">表單</span>
        </div>
        <div className="dev-stat">
          <span className="dev-stat__num">{state ? state.totalFields.toLocaleString() : "—"}</span>
          <span className="dev-stat__label">欄位</span>
        </div>
        <div className="dev-stat">
          <span className="dev-stat__health">
            <span className={`dev-sync__dot ${health.dot}`} title={health.title} aria-hidden />
            索引狀態
          </span>
          <span className="dev-stat__label">
            更新於 {formatRelativeTime(state?.refreshedAt ?? null)}
          </span>
        </div>
      </section>

      {pinned.length > 0 ? (
        <section className="dev-dash__sec">
          <h3 className="dev-dash__title">釘選</h3>
          <div className="dev-dash__cards">
            {pinned.map((f) => (
              <DashCard
                key={f.formPath}
                form={f}
                pinned
                onOpen={openForm}
                onTogglePin={togglePin}
              />
            ))}
          </div>
        </section>
      ) : null}

      {recent.length > 0 ? (
        <section className="dev-dash__sec">
          <h3 className="dev-dash__title">最近開啟</h3>
          <div className="dev-dash__cards">
            {recent.map((f) => (
              <DashCard
                key={f.formPath}
                form={f}
                pinned={isPinned(f.formPath)}
                onOpen={openForm}
                onTogglePin={togglePin}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className="dev-dash__sec">
        <h3 className="dev-dash__title">工具</h3>
        <div className="dev-dash__tools">
          {DEV_GROUP_ORDER.map((g) => (
            <div key={g} className="dev-dash__toolgroup">
              <span className="dev-dash__toollabel">{DEV_GROUP_META[g].label}</span>
              {DEV_TOOLS.filter((tool) => tool.group === g).map((tool) => (
                <Link
                  key={tool.id}
                  to={tool.path}
                  className={`dev-dash__tool dev-dash__tool--${g}`}
                >
                  <span className="dev-dash__tool-name">{tool.label}</span>
                  <span className="dev-dash__tool-desc">{tool.desc}</span>
                </Link>
              ))}
            </div>
          ))}
        </div>
      </section>

      <RagicFormDetailModal
        open={selectedForm !== null}
        token={token}
        formPath={selectedForm?.path ?? null}
        formName={selectedForm?.name ?? null}
        state={ragic.state}
        onRefresh={ragic.refresh}
        refreshError={ragic.refreshError}
        onClose={() => setSelectedForm(null)}
        onAuthFailure={fail}
      />
    </div>
  );
}

function DashCard({
  form,
  pinned,
  onOpen,
  onTogglePin,
}: {
  form: DevFormRef;
  pinned: boolean;
  onOpen: (formPath: string, formName: string) => void;
  onTogglePin: (form: DevFormRef) => void;
}) {
  return (
    <div
      className="dev-dash__card"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(form.formPath, form.formName)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(form.formPath, form.formName);
        }
      }}
    >
      <span className="dev-dash__card-name">{form.formName}</span>
      <code className="dev-dash__card-path">{form.formPath}</code>
      <button
        type="button"
        className={`ragic-inline__pin${pinned ? " is-pinned" : ""}`}
        title={pinned ? "取消釘選" : "釘選"}
        aria-label={pinned ? "取消釘選" : "釘選"}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(form);
        }}
      >
        {pinned ? "★" : "☆"}
      </button>
    </div>
  );
}
