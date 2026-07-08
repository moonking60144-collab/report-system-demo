import {
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  PlusOutlined,
  UpOutlined,
} from "@ant-design/icons";
import type { ItSopSection, ItSopSectionKind } from "../../../api/itSop";
import {
  createChecklistItem,
  createTableRow,
  duplicateChecklistItem,
  duplicateTableRow,
  isSopDataSection,
  SECTION_KIND_LABELS,
} from "../utils/itSopEditorModels";

interface ItSopSectionEditorProps {
  section: ItSopSection;
  index: number;
  onUpdate: (updater: (section: ItSopSection) => ItSopSection) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
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

function hasContentThatWillBeCleared(section: ItSopSection, nextKind: ItSopSectionKind): boolean {
  if (section.kind === nextKind) return false;
  if ((section.kind === "text" || section.kind === "code") && (nextKind === "text" || nextKind === "code")) {
    return false;
  }
  if ((section.kind === "text" || section.kind === "code") && section.text.trim()) {
    return true;
  }
  if (section.kind === "table") {
    return section.rows.some((row) => row.cells.some((cell) => cell.trim()));
  }
  if (section.kind === "checklist") {
    return section.items.some((item) => item.checked || item.text.trim());
  }
  return false;
}

export function ItSopSectionEditor({
  section,
  index,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  onCopy,
  canMoveUp,
  canMoveDown,
}: ItSopSectionEditorProps) {
  function changeKind(kind: ItSopSectionKind): boolean {
    if (
      hasContentThatWillBeCleared(section, kind) &&
      !window.confirm("切換段落類型會清除目前內容。確定要切換嗎？")
    ) {
      return false;
    }
    onUpdate((current) => ({
      ...current,
      kind,
      text: kind === "text" || kind === "code" ? current.text : "",
      rows: kind === "table" ? (current.rows.length ? current.rows : [createTableRow(3)]) : [],
      items: kind === "checklist" ? (current.items.length ? current.items : [createChecklistItem()]) : [],
    }));
    return true;
  }

  const isDataSection = isSopDataSection(section);

  return (
    <article
      className={`it-sop_section${isDataSection ? " it-sop_section--data" : ""}`}
      id={section.id}
    >
      <div className="it-sop_sectionHeader">
        <input
          className="it-sop_sectionTitle"
          value={section.title}
          onChange={(event) =>
            onUpdate((current) => ({
              ...current,
              title: event.target.value,
            }))
          }
          aria-label="段落標題"
        />
        <div className="it-sop_sectionTools">
          <span className="it-sop_sectionIndex">{String(index + 1).padStart(2, "0")}</span>
          <button
            className="it-sop_button subtle"
            type="button"
            onClick={onMoveUp}
            disabled={!canMoveUp}
          >
            <UpOutlined aria-hidden="true" />
            上移
          </button>
          <button
            className="it-sop_button subtle"
            type="button"
            onClick={onMoveDown}
            disabled={!canMoveDown}
          >
            <DownOutlined aria-hidden="true" />
            下移
          </button>
          <button className="it-sop_button subtle" type="button" onClick={onDuplicate}>
            <CopyOutlined aria-hidden="true" />
            複製
          </button>
          <button className="it-sop_button subtle" type="button" onClick={onCopy}>
            <CopyOutlined aria-hidden="true" />
            複製內容
          </button>
          <select
            className="it-sop_select"
            value={section.kind}
            onChange={(event) => {
              if (!changeKind(event.target.value as ItSopSectionKind)) {
                event.currentTarget.value = section.kind;
              }
            }}
            aria-label="段落類型"
          >
            {Object.entries(SECTION_KIND_LABELS).map(([kind, label]) => (
              <option value={kind} key={kind}>
                {label}
              </option>
            ))}
          </select>
          <button
            className="it-sop_button subtle"
            type="button"
            onClick={() =>
              onUpdate((current) => ({
                ...current,
                collapsed: !current.collapsed,
              }))
            }
          >
            {section.collapsed ? (
              <DownOutlined aria-hidden="true" />
            ) : (
              <UpOutlined aria-hidden="true" />
            )}
            {section.collapsed ? "展開" : "收合"}
          </button>
          <button className="it-sop_button danger" type="button" onClick={onRemove}>
            <DeleteOutlined aria-hidden="true" />
            刪除
          </button>
        </div>
      </div>
      {isDataSection ? (
        <p className="it-sop_sectionHelp">
          此區可直接編輯，會自動保存在目前瀏覽器；按「儲存到 server」後同步給其他人。
        </p>
      ) : null}
      {section.collapsed ? (
        <div className="it-sop_collapsed">已收合，儲存後其他人也會看到這個收合狀態。</div>
      ) : (
        <SectionBody section={section} onUpdate={onUpdate} />
      )}
    </article>
  );
}

function SectionBody({
  section,
  onUpdate,
}: {
  section: ItSopSection;
  onUpdate: (updater: (section: ItSopSection) => ItSopSection) => void;
}) {
  if (section.kind === "text" || section.kind === "code") {
    return (
      <textarea
        className={`it-sop_textBlock ${section.kind === "code" ? "code" : ""}`}
        value={section.text}
        aria-label={section.kind === "code" ? "指令內容" : "段落文字"}
        onChange={(event) =>
          onUpdate((current) => ({
            ...current,
            text: event.target.value,
          }))
        }
      />
    );
  }

  if (section.kind === "table") {
    const cellCount = Math.max(1, ...section.rows.map((row) => row.cells.length));
    const hasHeaderRow = !isSopDataSection(section) && section.rows.length > 1;
    const removeColumn = (columnIndex: number) => {
      onUpdate((current) => ({
        ...current,
        rows: current.rows.map((row) => ({
          ...row,
          cells: row.cells.filter((_, cellIndex) => cellIndex !== columnIndex),
        })),
      }));
    };
    return (
      <div className="it-sop_tableEditor">
        <table className="it-sop_table">
          {hasHeaderRow ? (
            <thead>
              <tr>
                {section.rows[0]?.cells.map((cell, cellIndex) => (
                  <th key={`${section.rows[0].id}-${cellIndex}`}>
                    <textarea
                      className="it-sop_tableCell"
                      value={cell}
                      onChange={(event) =>
                        onUpdate((current) => ({
                          ...current,
                          rows: current.rows.map((currentRow) =>
                            currentRow.id === section.rows[0].id
                              ? {
                                  ...currentRow,
                                  cells: currentRow.cells.map((currentCell, currentCellIndex) =>
                                    currentCellIndex === cellIndex ? event.target.value : currentCell
                                  ),
                                }
                              : currentRow
                          ),
                        }))
                      }
                      aria-label={`表頭第 ${cellIndex + 1} 欄`}
                    />
                  </th>
                ))}
                <th className="it-sop_tableActionHead" aria-label="操作" />
              </tr>
            </thead>
          ) : null}
          <tbody>
            {(hasHeaderRow ? section.rows.slice(1) : section.rows).map((row, rowIndex) => (
              <tr key={row.id}>
                {row.cells.map((cell, cellIndex) => {
                  const CellTag = !hasHeaderRow && cellIndex === 0 ? "th" : "td";
                  return (
                    <CellTag key={`${row.id}-${cellIndex}`}>
                      <textarea
                        className="it-sop_tableCell"
                        value={cell}
                        onChange={(event) =>
                          onUpdate((current) => ({
                            ...current,
                            rows: current.rows.map((currentRow) =>
                              currentRow.id === row.id
                                ? {
                                    ...currentRow,
                                    cells: currentRow.cells.map((currentCell, currentCellIndex) =>
                                      currentCellIndex === cellIndex
                                        ? event.target.value
                                        : currentCell
                                    ),
                                  }
                                : currentRow
                            ),
                          }))
                        }
                        aria-label={`第 ${rowIndex + 1} 列第 ${cellIndex + 1} 欄`}
                      />
                    </CellTag>
                  );
                })}
                <td className="it-sop_tableActionCell">
                  <div className="it-sop_rowActions">
                    <button
                      className="it-sop_iconButton"
                      type="button"
                      onClick={() =>
                        onUpdate((current) => {
                          const originalRowIndex = hasHeaderRow ? rowIndex + 1 : rowIndex;
                          return {
                            ...current,
                            rows: moveItem(current.rows, originalRowIndex, originalRowIndex - 1),
                          };
                        })
                      }
                      disabled={hasHeaderRow ? rowIndex === 0 : rowIndex === 0}
                      aria-label={`上移第 ${rowIndex + 1} 列`}
                    >
                      <UpOutlined aria-hidden="true" />
                    </button>
                    <button
                      className="it-sop_iconButton"
                      type="button"
                      onClick={() =>
                        onUpdate((current) => {
                          const originalRowIndex = hasHeaderRow ? rowIndex + 1 : rowIndex;
                          return {
                            ...current,
                            rows: moveItem(current.rows, originalRowIndex, originalRowIndex + 1),
                          };
                        })
                      }
                      disabled={(hasHeaderRow ? rowIndex + 1 : rowIndex) >= section.rows.length - 1}
                      aria-label={`下移第 ${rowIndex + 1} 列`}
                    >
                      <DownOutlined aria-hidden="true" />
                    </button>
                    <button
                      className="it-sop_iconButton"
                      type="button"
                      onClick={() =>
                        onUpdate((current) => {
                          const originalRowIndex = current.rows.findIndex(
                            (currentRow) => currentRow.id === row.id
                          );
                          if (originalRowIndex < 0) return current;
                          const nextRows = [...current.rows];
                          nextRows.splice(
                            originalRowIndex + 1,
                            0,
                            duplicateTableRow(current.rows[originalRowIndex])
                          );
                          return {
                            ...current,
                            rows: nextRows,
                          };
                        })
                      }
                      aria-label={`複製第 ${rowIndex + 1} 列`}
                    >
                      <CopyOutlined aria-hidden="true" />
                    </button>
                    <button
                      className="it-sop_iconButton danger"
                      type="button"
                      onClick={() =>
                        onUpdate((current) => ({
                          ...current,
                          rows: current.rows.filter((currentRow) => currentRow.id !== row.id),
                        }))
                      }
                      aria-label={`刪除第 ${rowIndex + 1} 列`}
                    >
                      <DeleteOutlined aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="it-sop_inlineActions">
          <button
            className="it-sop_button subtle"
            type="button"
            onClick={() =>
              onUpdate((current) => ({
                ...current,
                rows: [...current.rows, createTableRow(cellCount)],
              }))
            }
          >
            <PlusOutlined aria-hidden="true" />
            新增列
          </button>
          <button
            className="it-sop_button subtle"
            type="button"
            onClick={() =>
              onUpdate((current) => ({
                ...current,
                rows: current.rows.map((row) => ({
                  ...row,
                  cells: [...row.cells, ""],
                })),
              }))
            }
          >
            <PlusOutlined aria-hidden="true" />
            新增欄
          </button>
          <button
            className="it-sop_button subtle"
            type="button"
            disabled={cellCount <= 1}
            onClick={() => removeColumn(cellCount - 1)}
          >
            <DeleteOutlined aria-hidden="true" />
            刪除最後欄
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="it-sop_checklistEditor">
      {section.items.map((item, itemIndex) => (
        <div className="it-sop_checkItem" key={item.id}>
          <input
            type="checkbox"
            checked={item.checked}
            onChange={(event) =>
              onUpdate((current) => ({
                ...current,
                items: current.items.map((currentItem) =>
                  currentItem.id === item.id
                    ? {
                        ...currentItem,
                        checked: event.target.checked,
                      }
                    : currentItem
                ),
              }))
            }
            aria-label={`第 ${itemIndex + 1} 個檢查項目完成狀態`}
          />
          <input
            className="it-sop_checkText"
            value={item.text}
            onChange={(event) =>
              onUpdate((current) => ({
                ...current,
                items: current.items.map((currentItem) =>
                  currentItem.id === item.id
                    ? {
                        ...currentItem,
                        text: event.target.value,
                      }
                    : currentItem
                ),
              }))
            }
            aria-label={`第 ${itemIndex + 1} 個檢查項目`}
          />
          <div className="it-sop_checkActions">
            <button
              className="it-sop_iconButton"
              type="button"
              disabled={itemIndex === 0}
              onClick={() =>
                onUpdate((current) => ({
                  ...current,
                  items: moveItem(current.items, itemIndex, itemIndex - 1),
                }))
              }
              aria-label={`上移第 ${itemIndex + 1} 個檢查項目`}
            >
              <UpOutlined aria-hidden="true" />
            </button>
            <button
              className="it-sop_iconButton"
              type="button"
              disabled={itemIndex === section.items.length - 1}
              onClick={() =>
                onUpdate((current) => ({
                  ...current,
                  items: moveItem(current.items, itemIndex, itemIndex + 1),
                }))
              }
              aria-label={`下移第 ${itemIndex + 1} 個檢查項目`}
            >
              <DownOutlined aria-hidden="true" />
            </button>
            <button
              className="it-sop_iconButton"
              type="button"
              onClick={() =>
                onUpdate((current) => {
                  const nextItems = [...current.items];
                  nextItems.splice(itemIndex + 1, 0, duplicateChecklistItem(item));
                  return {
                    ...current,
                    items: nextItems,
                  };
                })
              }
              aria-label={`複製第 ${itemIndex + 1} 個檢查項目`}
            >
              <CopyOutlined aria-hidden="true" />
            </button>
            <button
              className="it-sop_iconButton danger"
              type="button"
              onClick={() =>
                onUpdate((current) => ({
                  ...current,
                  items: current.items.filter((currentItem) => currentItem.id !== item.id),
                }))
              }
              aria-label={`刪除第 ${itemIndex + 1} 個檢查項目`}
            >
              <DeleteOutlined aria-hidden="true" />
            </button>
          </div>
        </div>
      ))}
      <button
        className="it-sop_button subtle"
        type="button"
        onClick={() =>
          onUpdate((current) => ({
            ...current,
            items: [...current.items, createChecklistItem()],
          }))
        }
      >
        <PlusOutlined aria-hidden="true" />
        新增檢查項目
      </button>
    </div>
  );
}
