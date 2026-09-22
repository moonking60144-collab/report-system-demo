export type WorkReportDetailEditorMode =
  | "idle"
  | "batch-create"
  | "batch-delete";

export type WorkReportDetailEditorModeAction =
  | { type: "enter-batch-create" }
  | { type: "enter-batch-delete" }
  | { type: "reset" };

export function workReportDetailEditorModeReducer(
  _state: WorkReportDetailEditorMode,
  action: WorkReportDetailEditorModeAction
): WorkReportDetailEditorMode {
  switch (action.type) {
    case "enter-batch-create":
      return "batch-create";
    case "enter-batch-delete":
      return "batch-delete";
    case "reset":
      return "idle";
  }
}
