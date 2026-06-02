/**
 * Demo Fixture — 假資料種子產生器。
 *
 * 設計：
 * - 完全 deterministic（用簡單 mulberry32 PRNG 種子化），重啟結果一致
 * - 欄位 key 對齊 form-104 / form-105 設定的「中文名稱」key（NOTE in form-104.ts:9）
 * - 子表 key 對齊 FORM_104_CONFIG.subtableId = "_subtable_1002178"
 * - Linked source 表（機台 / 操作員 / 工序）符合 form-104 linkedFields 的 lookupFieldId
 */

import type { RagicRecord } from "./client";
import type { DemoFixture } from "./mockClient";

const MACHINE_FORM_PATH = "/default/forms51/1";
const OPERATOR_FORM_PATH = "/default/forms11/13";
const PROCESS_FORM_PATH = "/default/forms51/3";
const FORM_104_PATH = "/default/forms8/104";
const FORM_105_PATH = "/default/forms8/105";
const FORM_16_PATH = "/default/c1/16";

const FORM_104_SUBTABLE_ID = "_subtable_1002178";

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

const OPERATOR_NAMES = [
  "張小明", "王大華", "李雅婷", "陳建宏", "林佳玲",
  "黃志強", "吳美惠", "劉建志", "周淑芬", "蔡明達",
  "鄭雅文", "謝俊宏", "羅麗華", "高文傑", "梁淑慧",
  "彭家豪", "范文淵", "賴怡君", "韓世昌", "白慧君",
  "邱嘉慧", "童俊賢", "馬國強", "嚴永福", "顏家瑋",
  "童心怡", "袁文凱", "尤志明", "巫宗翰", "魏家祥",
] as const;

// 子製程代碼前綴對齊 form16ReportTypeRules.mapProcessCodeToReportType：
// HF→HF-Forge、TI/WP/BU→TI-ProcessA、LM→PROC-LM、EP→PROC-EP、
// PA→PA-Pack、SP→SP-Stock、CH→CH-ManualInspect。讓 create flow 能順利推導 Form 16 報工類別。
const PROCESS_TABLE = [
  { code: "HF01", subCode: "HF01-A", name: "鍛造", category: "車削" },
  { code: "TI01", subCode: "TI01-A", name: "Process A", category: "車削" },
  { code: "TI02", subCode: "TI02-A", name: "精車", category: "車削" },
  { code: "BU01", subCode: "BU01-A", name: "粗車", category: "車削" },
  { code: "WP01", subCode: "WP01-A", name: "倒角", category: "車削" },
  { code: "LM01", subCode: "LM01-B", name: "粗銑", category: "銑削" },
  { code: "LM02", subCode: "LM02-B", name: "精銑", category: "銑削" },
  { code: "EP01", subCode: "EP01-B", name: "鑽孔", category: "銑削" },
  { code: "EP02", subCode: "EP02-B", name: "攻牙", category: "銑削" },
  { code: "CH01", subCode: "CH01-C", name: "外圓磨", category: "磨削" },
  { code: "PA01", subCode: "PA01-C", name: "平面磨", category: "磨削" },
  { code: "SP01", subCode: "SP01-C", name: "內孔磨", category: "磨削" },
] as const;

const STATUS_POOL = ["進行中", "待開始", "已結案", "停工"] as const;
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
      const code = `M-${group.prefix}${pad(i)}`;
      const id = String(idCounter++);
      records[id] = {
        _ragicId: id,
        機台代碼: code,
        機台簡稱: `${group.processName}機 #${group.prefix}${pad(i)}`,
        製程簡稱: group.processName,
        所屬區域: group.prefix === "A" ? "一廠" : group.prefix === "B" ? "二廠" : "三廠",
      };
    }
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
      工號: empNo,
      姓名: OPERATOR_NAMES[i] ?? `員工 ${i + 1}`,
      部門: i % 3 === 0 ? "生產一課" : i % 3 === 1 ? "生產二課" : "技術課",
    };
  }
  return records;
}

function buildProcesses(): Record<string, RagicRecord> {
  const records: Record<string, RagicRecord> = {};
  let idCounter = 31_000;
  for (const proc of PROCESS_TABLE) {
    const id = String(idCounter++);
    records[id] = {
      _ragicId: id,
      "子製程別代碼Proc. Sub Category ID": proc.subCode,
      "製程別名稱Proc. Name": proc.name,
      製程大分類: proc.category,
      製程代碼: proc.code,
    };
  }
  return records;
}

interface WorkOrderBuildOptions {
  formId: "104" | "105";
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
  const baseId = opts.formId === "104" ? 800_000 : 850_000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < opts.count; i++) {
    const id = String(baseId + i);
    const proc = pick(opts.rng, opts.processes);
    const machineCode = pick(opts.rng, opts.machineCodes);
    const workOrderNo = `WO-${opts.formId}-${pad(i + 1, 4)}`;
    const targetQty = 500 + Math.floor(opts.rng() * 9_500);
    const status = pick(opts.rng, STATUS_POOL);
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
        "Date生產日期Production Date": formatDate(reportDate),
        "Mach機台/Pack Type包裝類別": machineCode,
        "Operator ID操作者工號": operator.empNo,
        "Operator擔當姓名": operator.name,
        "PROCESS子製程別代碼": proc.subCode,
        "Planned Idle計畫停機?": "",
        "Shift Type班別(正常Reg/加班OT)": pick(opts.rng, SHIFT_POOL),
        "Start Time開工時間(H:M)": `${pad(startHour)}:${pad(startMin)}`,
        "End Time完工時間(H:M)": `${pad(endHour)}:${pad(startMin)}`,
        "Break Time扣除休息時間(時Hr)": "1",
        "Total Work Time總工時(時Hr)": String(Math.max(0, endHour - startHour - 1)),
        "Production Qty生產量/PCS": String(productionQty),
        依序累計量: String(producedTotal),
        "Remark備註": opts.rng() < 0.2 ? "進度正常" : "",
        "Setup/Adjust架車(BA)or調機(SA)": pick(opts.rng, SETUP_ADJUST_POOL),
        "Setup/Adjust (Min)架.調車/分鐘": "0",
        "(S)Unplanned Idle自主停機/分": String(Math.floor(opts.rng() * 30)),
      };
    }

    records[id] = {
      _ragicId: id,
      "開始排程?": opts.rng() < 0.85 ? "Y" : "",
      工令單單號: workOrderNo,
      內製指定機台: machineCode,
      預設機台: machineCode, // form-105 用這個 key
      修改狀態: "",
      鍛造母件: opts.rng() < 0.3 ? "M-BASE-001" : "",
      客戶料號: `CUS-${pad(Math.floor(opts.rng() * 999), 3)}`,
      急件: pick(opts.rng, URGENT_POOL),
      工作排序碼: pad(i + 1, 3),
      尺寸: `${5 + Math.floor(opts.rng() * 50)}mm`,
      指定開始日期: formatDate(planStart),
      "指定結束日期 [生產計畫]": formatDate(planEnd),
      預估所需工時: String(8 + Math.floor(opts.rng() * 40)),
      "[上製程]指定結束日期": formatDate(addDays(planStart, -2)),
      目標數pc: String(targetQty),
      待生產數量: String(Math.max(0, targetQty - producedTotal)),
      "已生產數量統計(pc)": String(producedTotal),
      "[上一站]報工數量(pc)": String(producedTotal),
      "[上一站]報工重量(kg)": String(producedTotal * 0.05),
      "[上一站]報工容器數": String(Math.floor(producedTotal / 100)),
      主製程簡稱: proc.name,
      子製程類別代碼: proc.subCode,
      製程大分類代碼: proc.category,
      工令單種類: "一般",
      目前使用來料: "標準鋼料",
      "完工量<br>(扣除製程耗損)": String(producedTotal),
      "製程損耗(pc)": String(Math.floor(opts.rng() * 20)),
      成品線徑: `${1 + Math.floor(opts.rng() * 10)}mm`,
      工令狀態: status,
      "更新[未結案]判斷": isFinished ? "已結案" : "未結案",
      結案狀態: isFinished ? "已結案" : "進行中",
      工令單備註: opts.rng() < 0.3 ? "客戶要求加急" : "",
      產品料號用途種類: pick(opts.rng, PRODUCT_TYPES),
      模具況狀: pick(opts.rng, MOLD_CONDITIONS),
      建立者帳號: "demo",
      最後修改日期: formatDate(new Date()),
      指定主要來料: "鋼線 5mm",
      "[預設]主要製程來料": "鋼線 5mm",
      上一站執行中: opts.rng() < 0.2 ? "Y" : "",
      上一站狀態: "完成",
      "本站執行中?": isFinished ? "" : opts.rng() < 0.5 ? "Y" : "",
      "[上一站]完工數pc": String(producedTotal),
      "[上一站]完工重kg": String(producedTotal * 0.05),
      "[上一站]完工容器數": String(Math.floor(producedTotal / 100)),
      [FORM_104_SUBTABLE_ID]: subtableRows,
    };
  }
  return records;
}

function buildForm16Downtime(rng: () => number, machineCodes: readonly string[]): Record<string, RagicRecord> {
  const records: Record<string, RagicRecord> = {};
  const today = new Date();
  const reasons = ["機台調機", "待料", "計畫停機", "人員請假", "模具更換"];
  for (let i = 0; i < 30; i++) {
    const id = String(160_000 + i);
    const day = new Date(today);
    day.setDate(today.getDate() - Math.floor(rng() * 30));
    records[id] = {
      _ragicId: id,
      "1006365": "", // workOrderNo（demo 空白）
      "1012669": pick(rng, reasons),
      "1002195": "P01-A",
      "1002221": "生產一課",
      "1002191": "金屬",
      "1002177": rng() < 0.3 ? "排程預定停機" : "",
      "1002190": formatDate(day),
      機台: pick(rng, machineCodes),
      停機時間分: String(15 + Math.floor(rng() * 120)),
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

export function buildDemoFixture(): DemoFixture {
  const rng = mulberry32(20260511);

  const machines = buildMachines();
  const machineCodes = Object.values(machines).map((m) => String(m.機台代碼));

  const operatorsRaw = buildOperators();
  const operators = Object.values(operatorsRaw).map((o) => ({
    empNo: String(o.工號),
    name: String(o.姓名),
  }));

  const processesRaw = buildProcesses();
  const processes = Object.values(processesRaw).map((p) => ({
    subCode: String(p["子製程別代碼Proc. Sub Category ID"]),
    name: String(p["製程別名稱Proc. Name"]),
    category: String(p.製程大分類),
  }));

  const form104 = buildWorkOrders({
    formId: "104",
    count: 80,
    reportsPerOrderMin: 2,
    reportsPerOrderMax: 8,
    rng,
    machineCodes,
    operators,
    processes,
  });

  const form105 = buildWorkOrders({
    formId: "105",
    count: 30,
    reportsPerOrderMin: 1,
    reportsPerOrderMax: 4,
    rng,
    machineCodes,
    operators,
    processes,
  });

  const form16 = buildForm16Downtime(rng, machineCodes);

  return {
    [MACHINE_FORM_PATH]: machines,
    [OPERATOR_FORM_PATH]: operatorsRaw,
    [PROCESS_FORM_PATH]: processesRaw,
    [FORM_104_PATH]: form104,
    [FORM_105_PATH]: form105,
    [FORM_16_PATH]: form16,
  };
}
