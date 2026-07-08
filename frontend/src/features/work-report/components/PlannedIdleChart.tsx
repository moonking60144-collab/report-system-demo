import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PlannedIdleMachineSummary } from "../../../api/downtime";
import "./PlannedIdleChart.css";

// 製程分組由上到下固定順序：搓牙(TI) → 鍛造(HF) → 加工(LM) → PA，未列出的排最後。
const PROC_ORDER = ["TI", "HF", "LM", "PA"];

// 該月工作日數（扣週末）當「計畫停機天數異常」門檻：超過就代表整月幾乎都在停機、把運轉率灌爆。
function workdaysInMonth(ym: string): number {
  const [year, month] = ym.split("/").map(Number);
  if (!year || !month) {
    return 0;
  }
  const lastDay = new Date(year, month, 0).getDate();
  let count = 0;
  for (let day = 1; day <= lastDay; day += 1) {
    const dow = new Date(year, month - 1, day).getDay();
    if (dow !== 0 && dow !== 6) {
      count += 1;
    }
  }
  return count;
}

interface PlannedIdleChartProps {
  month: string;
  machines: PlannedIdleMachineSummary[];
}

export function PlannedIdleChart({ month, machines }: PlannedIdleChartProps) {
  const { t } = useTranslation(["workReport"]);
  const threshold = useMemo(() => workdaysInMonth(month), [month]);

  const groups = useMemo(() => {
    const byProc = new Map<string, PlannedIdleMachineSummary[]>();
    for (const machine of machines) {
      const key = machine.prodType || "—";
      const list = byProc.get(key) ?? [];
      list.push(machine);
      byProc.set(key, list);
    }
    const orderOf = (code: string) => {
      const index = PROC_ORDER.indexOf(code);
      return index < 0 ? PROC_ORDER.length : index;
    };
    return [...byProc.entries()]
      .map(([prodType, list]) => ({
        prodType,
        label: t(`workReport:downtimePage.chart.proc.${prodType}`, prodType),
        list: [...list].sort((left, right) => right.totalDays - left.totalDays),
      }))
      .sort((left, right) => orderOf(left.prodType) - orderOf(right.prodType));
  }, [machines, t]);

  if (machines.length === 0) {
    return (
      <div className="planned-idle-chart-empty">{t("workReport:downtimePage.chart.empty")}</div>
    );
  }

  return (
    <div className="planned-idle-chart">
      <div className="planned-idle-chart-hint">
        {t("workReport:downtimePage.chart.thresholdHint", { days: threshold })}
      </div>
      {groups.map((group) => (
        <div key={group.prodType} className="planned-idle-chart-group">
          <div className="planned-idle-chart-group-title">
            {group.label}
            <span className="planned-idle-chart-group-count">（{group.list.length}）</span>
          </div>
          <ResponsiveContainer width="100%" height={Math.max(120, group.list.length * 30 + 36)}>
            <BarChart
              layout="vertical"
              data={group.list}
              margin={{ top: 4, right: 56, left: 4, bottom: 4 }}
            >
              <XAxis
                type="number"
                tickFormatter={(value: number) =>
                  t("workReport:downtimePage.chart.daysShort", { days: value })
                }
                fontSize={11}
              />
              <YAxis type="category" dataKey="machineId" width={52} fontSize={11} />
              <Tooltip
                cursor={{ fill: "rgba(0,0,0,0.04)" }}
                formatter={(_value, _name, item) => {
                  const record = item.payload as PlannedIdleMachineSummary;
                  return t("workReport:downtimePage.chart.tooltipLine", {
                    days: record.totalDays,
                    minutes: record.totalMinutes,
                    count: record.count,
                  });
                }}
                labelFormatter={(label) => String(label)}
              />
              <Bar dataKey="totalDays" radius={[0, 4, 4, 0]} barSize={16}>
                {group.list.map((machine) => (
                  <Cell
                    key={machine.machineId}
                    fill={machine.totalDays > threshold ? "#dc2626" : "#3b82f6"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ))}
    </div>
  );
}
