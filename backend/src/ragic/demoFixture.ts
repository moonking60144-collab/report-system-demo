/**
 * Demo Fixture — 假資料種子產生器。
 *
 * 設計：
 * - 完全 deterministic（用簡單 mulberry32 PRNG 種子化），重啟結果一致
 * - 欄位 key 對齊 form-901 / form-902 的 `demo_*` synthetic contract
 * - 子表 key 對齊 FORM_901_CONFIG.subtableId = "_subtable_demo_reports"
 * - Linked source 表（機台 / 操作員 / 工序）符合 form-901 linkedFields 的 lookupFieldId
 */

import type { RagicRecord } from "./client";
import type { DemoFixture } from "./mockClient";

const MACHINE_FORM_PATH = "/demo/reference/machines";
const OPERATOR_FORM_PATH = "/demo/reference/operators";
const PROCESS_FORM_PATH = "/demo/reference/processes";
const FORM_901_PATH = "/demo/work-orders/line-a";
const FORM_902_PATH = "/demo/work-orders/line-b";
const ACTIVITY_LOG_FORM_PATH = "/demo/activity-logs";

const FORM_901_SUBTABLE_ID = "_subtable_demo_reports";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

const MACHINE_GROUPS = [
  { prefix: "A", count: 5, processName: "車削" },
  { prefix: "B", count: 5, processName: "銑削" },
  { prefix: "C", count: 5, processName: "磨削" },
];

const OPERATOR_NAMES = Array.from(
  { length: 30 },
  (_, index) => `示範員工 ${pad(index + 1)}`
);

// Demo 製程代碼對齊 activityLogReportTypeRules.mapProcessCodeToReportType。
const PROCESS_TABLE = [
  { code: "A01", subCode: "A01-1", name: "製程 A1", category: "車削" },
  { code: "A02", subCode: "A02-1", name: "製程 A2", category: "車削" },
  { code: "A03", subCode: "A03-1", name: "製程 A3", category: "車削" },
  { code: "A04", subCode: "A04-1", name: "製程 A4", category: "車削" },
  { code: "B01", subCode: "B01-1", name: "製程 B1", category: "車削" },
  { code: "B02", subCode: "B02-1", name: "製程 B2", category: "車削" },
  { code: "C01", subCode: "C01-2", name: "製程 C1", category: "銑削" },
  { code: "C02", subCode: "C02-2", name: "製程 C2", category: "銑削" },
  { code: "D01", subCode: "D01-2", name: "製程 D1", category: "銑削" },
  { code: "QA01", subCode: "QA01-3", name: "品質檢驗", category: "磨削" },
  { code: "PK01", subCode: "PK01-3", name: "包裝", category: "磨削" },
  { code: "ST01", subCode: "ST01-3", name: "備料", category: "磨削" },
] as const;

const STATUS_POOL = ["未結案", "未結案", "未結案", "已結案"] as const;
const URGENT_POOL = ["Y", "", ""] as const;
// 對齊 payloadValueRules.ts 的 SHIFT_TYPE_ALLOWED_VALUES
const SHIFT_POOL = ["正常班Reg", "加班OT"] as const;
const SETUP_ADJUST_POOL = ["BA", "SA", ""] as const;
const PRODUCT_TYPES = ["金屬", "塑膠", "電子"] as const;
const MOLD_CONDITIONS = ["良好", "需保養", "新模"] as const;

function buildMachines(): Record<string, RagicRecord> {
  const records: Record<string, RagicRecord> = {};
  let idCounter = 51_000;
  for (const group of MACHINE_GROUPS) {
    for (let i = 1; i <= group.count; i++) {
      const code = `${group.prefix}${pad(i)}`;
      const id = String(idCounter++);
      records[id] = {
        _ragicId: id,
        demo_machine_code: code,
        demo_machine_name: `${group.processName}機 #${group.prefix}${pad(i)}`,
        demo_process_name: group.processName,
        demo_process_category: group.prefix,
        demo_process_code:
          group.prefix === "A" ? "A01-1" : group.prefix === "B" ? "C01-2" : "QA01-3",
        demo_primary_operator_id: "E001",
        demo_primary_operator_name: OPERATOR_NAMES[0],
        demo_area: group.prefix === "A" ? "一廠" : group.prefix === "B" ? "二廠" : "三廠",
        demo_status: "使用中",
      };
    }
  }
  for (const [id, code, name] of [
    ["51990", "MB50", "示範主機台 MB50"],
    ["51991", "MA01", "示範機台 MA01"],
    ["51992", "MA02", "示範機台 MA02"],
  ] as const) {
    records[id] = {
      _ragicId: id,
      demo_machine_code: code,
      demo_machine_name: name,
      demo_process_name: "車削",
      demo_process_category: "A",
      demo_process_code: "A01-1",
      demo_primary_operator_id: "EMP001",
      demo_primary_operator_name: "示範操作員甲",
      demo_area: "示範區",
      demo_status: "使用中",
    };
  }
  return records;
}

function buildOperators(): Record<string, RagicRecord> {
  const records: Record<string, RagicRecord> = {};
  let idCounter = 11_000;
  for (let i = 0; i < OPERATOR_NAMES.length; i++) {
    const id = String(idCounter++);
    const empNo = `E${pad(i + 1, 3)}`;
    records[id] = {
      _ragicId: id,
      demo_operator_id: empNo,
      demo_operator_name: OPERATOR_NAMES[i] ?? `員工 ${i + 1}`,
      demo_department_name: i % 3 === 0 ? "生產一課" : i % 3 === 1 ? "生產二課" : "技術課",
      demo_department_group: i < 10 ? "P01加工一組" : i < 20 ? "P02加工二組" : "ADM管理組",
    };
  }
  records["11990"] = {
    _ragicId: "11990",
    demo_operator_id: "EMP001",
    demo_operator_name: "示範操作員甲",
    demo_department_name: "示範生產課",
    demo_department_group: "P01加工一組",
  };
  records["11991"] = {
    _ragicId: "11991",
    demo_operator_id: "EMP002",
    demo_operator_name: "示範操作員乙",
    demo_department_name: "示範生產課",
    demo_department_group: "P01加工一組",
  };
  return records;
}

function buildProcesses(): Record<string, RagicRecord> {
  const records: Record<string, RagicRecord> = {};
  let idCounter = 31_000;
  for (const proc of PROCESS_TABLE) {
    const id = String(idCounter++);
    records[id] = {
      _ragicId: id,
      "demo_process_code": proc.subCode,
      "demo_process_name": proc.name,
      demo_process_category: proc.category,
      demo_process_id: proc.code,
    };
  }
  return records;
}

interface WorkOrderBuildOptions {
  formId: "901" | "902";
  count: number;
  reportsPerOrderMin: number;
  reportsPerOrderMax: number;
  rng: () => number;
  machineCodes: readonly string[];
  operators: ReadonlyArray<{ empNo: string; name: string }>;
  processes: ReadonlyArray<{ subCode: string; name: string; category: string }>;
}

function buildWorkOrders(opts: WorkOrderBuildOptions): Record<string, RagicRecord> {
  const records: Record<string, RagicRecord> = {};
  const baseId = opts.formId === "901" ? 800_000 : 850_000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < opts.count; i++) {
    const id = String(baseId + i);
    const proc = pick(opts.rng, opts.processes);
    const machinePrefix = proc.category === "車削" ? "A" : proc.category === "銑削" ? "B" : "C";
    const compatibleMachineCodes = opts.machineCodes.filter((code) => code.startsWith(machinePrefix));
    const machineCode = i === 0
      ? (compatibleMachineCodes[0] ?? pick(opts.rng, opts.machineCodes))
      : pick(opts.rng, compatibleMachineCodes.length > 0 ? compatibleMachineCodes : opts.machineCodes);
    const workOrderNo = `WO-${opts.formId}-${pad(i + 1, 4)}`;
    const targetQty = 500 + Math.floor(opts.rng() * 9_500);
    const status = i === 0 ? "未結案" : pick(opts.rng, STATUS_POOL);
    const isFinished = status === "已結案";

    const planStart = new Date(today);
    planStart.setDate(today.getDate() - 60 + Math.floor(opts.rng() * 120));
    const planEnd = new Date(planStart);
    planEnd.setDate(planStart.getDate() + 1 + Math.floor(opts.rng() * 14));

    const subtableRows: Record<string, RagicRecord> = {};
    const reportCount =
      opts.reportsPerOrderMin +
      Math.floor(opts.rng() * (opts.reportsPerOrderMax - opts.reportsPerOrderMin + 1));
    let producedTotal = 0;
    for (let r = 0; r < reportCount; r++) {
      const reportDate = new Date(planStart);
      reportDate.setDate(planStart.getDate() + r);
      const operator = pick(opts.rng, opts.operators);
      const startHour = 8 + Math.floor(opts.rng() * 4);
      const startMin = pick(opts.rng, [0, 15, 30, 45]);
      const durationHours = 2 + Math.floor(opts.rng() * 6);
      const endHour = Math.min(startHour + durationHours, 22);
      const productionQty = 50 + Math.floor(opts.rng() * 350);
      producedTotal += productionQty;
      const rowId = String(20_000 + i * 50 + r);

      subtableRows[rowId] = {
        "demo_date": formatDate(reportDate),
        "demo_machine_id": machineCode,
        "demo_operator_id": operator.empNo,
        "demo_operator_name": operator.name,
        "demo_process_code": proc.subCode,
        "demo_planned_idle": "",
        "demo_shift_type": pick(opts.rng, SHIFT_POOL),
        "demo_start_time": `${pad(startHour)}:${pad(startMin)}`,
        "demo_end_time": `${pad(endHour)}:${pad(startMin)}`,
        "demo_break_time": "1",
        "demo_total_work_time": String(Math.max(0, endHour - startHour - 1)),
        "demo_production_qty": String(productionQty),
        demo_cumulative_qty: String(producedTotal),
        "demo_remark": opts.rng() < 0.2 ? "進度正常" : "",
        "demo_setup_adjust_type": pick(opts.rng, SETUP_ADJUST_POOL),
        "demo_setup_adjust_minutes": "0",
        "demo_count_setup_time_flag": "",
        "demo_setup_time_standard_hours": "1",
        "demo_setup_loss_qty_per_pcs": "0",
        "demo_process_loss_qty_per_pcs": "0",
        "demo_total_container_qty": "0",
        "demo_container_unit": "箱",
        "demo_planned_idle_minutes": "0",
        "demo_unplanned_idle_minutes": String(Math.floor(opts.rng() * 30)),
        "demo_absent_or_training_minutes": "0",
        "demo_no_material_minutes": "0",
        "demo_waiting_qc_approval_minutes": "0",
        "demo_meeting_minutes": "0",
        "demo_cleaning_minutes": "0",
        "demo_rd_sampling_minutes": "0",
        "demo_support_other_machines_minutes": "0",
        "demo_machine_breakdown_minutes": "0",
        "demo_machine_adjustment_minutes": "0",
        "demo_others_minutes": "0",
        "demo_waiting_for_dies_minutes": "0",
        "demo_testing_dies_minutes": "0",
      };
    }

    records[id] = {
      _ragicId: id,
      "demo_start_schedule": i === 0 || opts.rng() < 0.85 ? "Yes" : "",
      demo_work_order_no: workOrderNo,
      demo_machine_code: machineCode,
      demo_line_b_machine: machineCode,
      demo_default_machine: machineCode,
      demo_modification_status: "",
      demo_forging_mother: opts.rng() < 0.3 ? "M-BASE-001" : "",
      demo_customer_part_no: `CUS-${pad(Math.floor(opts.rng() * 999), 3)}`,
      demo_urgent: pick(opts.rng, URGENT_POOL),
      demo_sort_order: pad(i + 1, 3),
      demo_size: `${5 + Math.floor(opts.rng() * 50)}mm`,
      demo_planned_start_date: formatDate(planStart),
      "demo_planned_end_date": formatDate(planEnd),
      demo_estimated_hours: String(8 + Math.floor(opts.rng() * 40)),
      "demo_prev_plan_end_date": formatDate(addDays(planStart, -2)),
      demo_target_qty_pc: String(targetQty),
      demo_pending_qty: String(Math.max(0, targetQty - producedTotal)),
      "demo_produced_qty_stat": String(producedTotal),
      "demo_prev_report_qty_pc": String(producedTotal),
      "demo_prev_report_qty_kg": String(producedTotal * 0.05),
      "demo_prev_report_container_qty": String(Math.floor(producedTotal / 100)),
      demo_process_name: proc.name,
      demo_default_process_code: proc.subCode,
      // 對齊 frontend landing page 的 prodTypeCode filter（constants.ts line-a-901=PA、line-b-902=PB）
      // 推導：process code 前綴決定 prodType，跟 activityLogReportTypeRules.mapProcessCodeToReportType 同邏輯
      demo_prod_type: deriveProdTypeFromProcessCode(proc.subCode),
      demo_work_order_type: "一般",
      demo_current_material: "標準鋼料",
      "demo_completed_qty": String(producedTotal),
      "demo_process_loss_pc": String(Math.floor(opts.rng() * 20)),
      demo_finished_wire_size: `${1 + Math.floor(opts.rng() * 10)}mm`,
      demo_status: status,
      "demo_ragic_unfinished_status": isFinished ? "已結案" : "未結案",
      demo_source_close_status: isFinished ? "已結案" : "進行中",
      demo_work_order_remark: opts.rng() < 0.3 ? "客戶要求加急" : "",
      demo_product_usage_type: pick(opts.rng, PRODUCT_TYPES),
      demo_mold_condition: pick(opts.rng, MOLD_CONDITIONS),
      demo_created_by: "demo",
      demo_last_updated_at: formatDate(new Date()),
      demo_primary_material: "鋼線 5mm",
      "demo_default_main_material": "鋼線 5mm",
      demo_prev_station_running: opts.rng() < 0.2 ? "Yes" : "",
      demo_prev_station_status: "完成",
      "demo_site_running": isFinished ? "" : i < 20 || opts.rng() < 0.5 ? "Yes" : "",
      "demo_prev_complete_pc": String(producedTotal),
      "demo_prev_complete_kg": String(producedTotal * 0.05),
      "demo_prev_complete_container": String(Math.floor(producedTotal / 100)),
      [FORM_901_SUBTABLE_ID]: subtableRows,
    };
  }
  return records;
}

function addWorkOrderAlias(
  records: Record<string, RagicRecord>,
  sourceId: string,
  aliasId: string,
  subtableRowAlias?: string,
  sourceMachine?: string,
  blankFirstSetupAdjust = false,
): void {
  const source = records[sourceId];
  if (!source) {
    throw new Error(`Demo fixture source work order ${sourceId} is missing`);
  }

  const sourceRows = source[FORM_901_SUBTABLE_ID];
  const rows = sourceRows && typeof sourceRows === "object"
    ? Object.fromEntries(
        Object.entries(sourceRows as Record<string, RagicRecord>).map(([rowId, row]) => [
          rowId,
          { ...row },
        ]),
      )
    : {};

  if (subtableRowAlias) {
    const firstRow = Object.entries(rows)[0];
    if (!firstRow) {
      throw new Error(`Demo fixture source work order ${sourceId} has no report row`);
    }
    delete rows[firstRow[0]];
    rows[subtableRowAlias] = firstRow[1];
  }
  if (blankFirstSetupAdjust) {
    const firstRow = Object.values(rows)[0];
    if (firstRow) {
      firstRow["demo_setup_adjust_type"] = "";
    }
  }

  records[aliasId] = {
    ...source,
    _ragicId: aliasId,
    demo_work_order_no: `WO-DEMO-${aliasId}`,
    "demo_start_schedule": "Yes",
    demo_status: "未結案",
    "demo_ragic_unfinished_status": "未結案",
    demo_source_close_status: "進行中",
    ...(sourceMachine
      ? {
          demo_machine_code: sourceMachine,
          demo_line_b_machine: sourceMachine,
          demo_default_machine: sourceMachine,
        }
      : {}),
    [FORM_901_SUBTABLE_ID]: rows,
  };
}

function buildActivityLogDowntime(rng: () => number, machineCodes: readonly string[]): Record<string, RagicRecord> {
  const records: Record<string, RagicRecord> = {};
  const today = new Date();
  const reasons = ["機台調機", "待料", "計畫停機", "人員請假", "模具更換"];
  for (let i = 0; i < 30; i++) {
    const id = String(160_000 + i);
    const day = new Date(today);
    day.setDate(today.getDate() - Math.floor(rng() * 30));
    records[id] = {
      _ragicId: id,
      "9001047": "", // workOrderNo（demo 空白）
      "9001065": pick(rng, reasons),
      "9001033": "P01-A",
      "9001037": "生產一課",
      "9001031": "金屬",
      "9001029": rng() < 0.3 ? "排程預定停機" : "",
      "9001030": formatDate(day),
      demo_machine_id: pick(rng, machineCodes),
      demo_planned_idle_minutes: String(15 + Math.floor(rng() * 120)),
    };
  }
  return records;
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(d.getDate() + days);
  return out;
}

function deriveProdTypeFromProcessCode(processCode: string): string {
  const upper = processCode.trim().toUpperCase();
  if (upper.startsWith("A")) return "PA";
  if (upper.startsWith("B")) return "PB";
  if (upper.startsWith("C")) return "PC";
  if (upper.startsWith("D")) return "PD";
  if (upper.startsWith("QA")) return "QA";
  if (upper.startsWith("PK")) return "PK";
  if (upper.startsWith("ST")) return "ST";
  return "OTHER";
}

export function buildDemoFixture(): DemoFixture {
  const rng = mulberry32(20260511);

  const machines = buildMachines();
  const machineCodes = Object.values(machines).map((m) => String(m.demo_machine_code));

  const operatorsRaw = buildOperators();
  const operators = Object.values(operatorsRaw)
    .filter((operator) => String(operator.demo_operator_id).startsWith("E"))
    .map((o) => ({
      empNo: String(o.demo_operator_id),
      name: String(o.demo_operator_name),
    }));

  const processesRaw = buildProcesses();
  const processes = Object.values(processesRaw).map((p) => ({
    subCode: String(p["demo_process_code"]),
    name: String(p["demo_process_name"]),
    category: String(p.demo_process_category),
  }));

  const form901 = buildWorkOrders({
    formId: "901",
    count: 80,
    reportsPerOrderMin: 2,
    reportsPerOrderMax: 8,
    rng,
    machineCodes,
    operators,
    processes: processes.filter((process) => process.subCode.startsWith("A")),
  });
  addWorkOrderAlias(form901, "800000", "90001", "111762");
  addWorkOrderAlias(form901, "800001", "90002", undefined, "MB50", true);

  const form902 = buildWorkOrders({
    formId: "902",
    count: 30,
    reportsPerOrderMin: 1,
    reportsPerOrderMax: 4,
    rng,
    machineCodes,
    operators,
    processes: processes.filter((process) => process.subCode.startsWith("B")),
  });

  const activityLog = buildActivityLogDowntime(rng, machineCodes);

  return {
    [MACHINE_FORM_PATH]: machines,
    [OPERATOR_FORM_PATH]: operatorsRaw,
    [PROCESS_FORM_PATH]: processesRaw,
    [FORM_901_PATH]: form901,
    [FORM_902_PATH]: form902,
    [ACTIVITY_LOG_FORM_PATH]: activityLog,
  };
}
