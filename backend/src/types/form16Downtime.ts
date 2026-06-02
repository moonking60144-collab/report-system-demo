export interface Form16DowntimeRecord {
  id: string;
  date: string | null;
  machineId: string | null;
  processCode: string | null;
  operatorId: string | null;
  operatorName: string | null;
  reportType: string | null;
  startTime: string | null;
  endTime: string | null;
  breakTime: string | null;
  plannedIdleMinutes: number | null;
  remark: string | null;
  workOrderNo: string | null;
}

