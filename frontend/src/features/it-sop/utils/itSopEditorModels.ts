import type {
  ItSopChecklistItem,
  ItSopSection,
  ItSopSectionKind,
  ItSopTableRow,
} from "../../../api/itSop";

export const SECTION_KIND_LABELS: Record<ItSopSectionKind, string> = {
  text: "文字",
  table: "表格",
  code: "指令",
  checklist: "檢查清單",
};

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createSection(kind: ItSopSectionKind): ItSopSection {
  return {
    id: createId("section"),
    title: "新段落",
    kind,
    text: kind === "text" || kind === "code" ? "" : "",
    rows:
      kind === "table"
        ? [
            {
              id: createId("row"),
              cells: ["項目", "狀態", "備註"],
            },
          ]
        : [],
    items:
      kind === "checklist"
        ? [
            {
              id: createId("item"),
              text: "新增檢查項目",
              checked: false,
            },
          ]
        : [],
    collapsed: false,
  };
}

export function createTableRow(cellCount: number): ItSopTableRow {
  return {
    id: createId("row"),
    cells: Array.from({ length: Math.max(1, cellCount) }, () => ""),
  };
}

export function createChecklistItem(): ItSopChecklistItem {
  return {
    id: createId("item"),
    text: "",
    checked: false,
  };
}

export function duplicateTableRow(row: ItSopTableRow): ItSopTableRow {
  return {
    ...row,
    id: createId("row"),
    cells: [...row.cells],
  };
}

export function duplicateChecklistItem(item: ItSopChecklistItem): ItSopChecklistItem {
  return {
    ...item,
    id: createId("item"),
  };
}

export function duplicateSection(section: ItSopSection): ItSopSection {
  return {
    ...section,
    id: createId("section"),
    title: `${section.title || "未命名段落"} 副本`,
    rows: section.rows.map((row) => duplicateTableRow(row)),
    items: section.items.map((item) => duplicateChecklistItem(item)),
  };
}

export function isSopDataSection(section: ItSopSection): boolean {
  return section.id === "sop-data" || section.title.trim() === "SOP 資料";
}

export function formatSectionForClipboard(section: ItSopSection): string {
  const title = section.title.trim() || "未命名段落";
  let body = "";
  if (section.kind === "table") {
    body = section.rows.map((row) => row.cells.join("\t")).join("\n");
  } else if (section.kind === "checklist") {
    body = section.items.map((item) => `${item.checked ? "[x]" : "[ ]"} ${item.text}`).join("\n");
  } else {
    body = section.text;
  }
  return `# ${title}${body.trim() ? `\n\n${body}` : ""}`;
}
