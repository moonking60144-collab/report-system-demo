export type OperationNoticeTone = "info" | "success" | "warning" | "error";

export interface OperationNotice {
  key: string;
  tone: OperationNoticeTone;
  title: string;
  message?: string;
}
