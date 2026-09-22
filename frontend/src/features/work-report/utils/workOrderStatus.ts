export const CLOSED_WORK_ORDER_STATUS = "已結案";

export function isWorkOrderClosedStatus(
  status: string | null | undefined
): boolean {
  return status === CLOSED_WORK_ORDER_STATUS;
}
