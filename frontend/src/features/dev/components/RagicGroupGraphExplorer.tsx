import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, ConfigProvider, theme as antdTheme } from "antd";
import {
  fetchRagicGroupGraph,
  type RagicGroupGraph,
  type RagicGroupEdgeType,
} from "../../../api/devRagicFieldIndex";
import { extractErrorMessage, isUnauthorized } from "../../../api/apiErrors";

interface RagicGroupGraphExplorerProps {
  token: string;
  onAuthFailure: () => void;
}

const EDGE_META: Record<RagicGroupEdgeType, { label: string; color: string; tip: string }> = {
  fk: { label: "外鍵連結", color: "#4aa3df", tip: "外鍵（FK）：欄位連到別張表的某一筆（Ragic 的連結與載入）" },
  workflow: { label: "程式查詢", color: "#e0a458", tip: "Workflow JS 裡 getAPIQuery 跨表抓資料（欄位層看不到的依賴）" },
  subtable: { label: "子表明細", color: "#b07cd6", tip: "一張單據底下掛一排明細列（1:N），拆了要動表結構" },
};
const EDGE_TYPES: RagicGroupEdgeType[] = ["fk", "workflow", "subtable"];

// 群代號（Ragic 資料夾）→ 業務名，讓矩陣軸顯示業務模組而非 forms8/d4 這種代號。
// 從每群成員表單判讀出來；沒對到的群（新群等）fallback 顯示原代號。
const GROUP_LABEL: Record<string, string> = {
  forms12: "料品主檔",
  forms8: "工令報工",
  mis: "舊系統",
  forms31: "訂單交貨",
  lvvp: "越南採購",
  forms4: "庫存",
  d5: "盤點2022",
  d12: "盤點歷史",
  d4: "生產計畫",
  c1: "生產報工",
  mis6: "MIS鍛造",
  forms9: "製程設計",
  forms3: "品檢",
  forms: "試作設變",
  ragicrd: "研發知識",
  forms16: "採購舊版",
  forms19: "財務會計",
  ragicforms12: "報價應收付",
  forms14: "出納付款",
  ragicforms4: "人事組織",
  forms20: "出勤請假",
  forms27: "績效考核",
  ragicadministration: "行政",
  forms11: "總務",
  forms2: "文件管理",
  it: "IT資產",
  other: "其他小群",
};
function displayName(g: string): string {
  return GROUP_LABEL[g] ?? g;
}

// 拆的難度權重：子表 1:N 是結構性硬耦合（拆了要動 schema），FK 次之，Workflow 查詢最軟（可改 API／快取繞過）
const EDGE_WEIGHT: Record<RagicGroupEdgeType, number> = { subtable: 3, fk: 2, workflow: 1 };

type SortMode = "cluster" | "degree" | "alpha";
// [key, 按鈕白話標籤, 滑過解釋]：把演算法名詞（Fiedler／耦合）降級到 tooltip，按鈕只放看得懂的詞
const SORT_MODES: Array<[SortMode, string, string]> = [
  ["cluster", "成團", "關係最密的群排在一起，對角線浮現的方塊＝該一起整理的模組（技術：Fiedler 譜排序）"],
  ["degree", "數量", "關係總數最多的群排前面"],
  ["alpha", "名稱", "群名字母序，方便固定查找"],
];

interface HoverCell {
  src: string;
  dst: string;
  count: number;
  self: boolean;
}

/**
 * Fiedler 譜排序 seriation：DSM 的核心操作——把 row/col 用同一組順序同步重排，讓高耦合對聚到對角線
 * 形成方塊（＝該一起正規化的模組）。取對稱化加權圖 Laplacian L=D−W 的第二小特徵向量（Fiedler vector），
 * 用 (σI−L) 去均值 power iteration 求得（每步正交於 trivial 全 1 向量）。零依賴、deterministic。
 * 用 Float64Array 攤平 W：TypedArray 索引型別恆為 number，避開二維陣列的逐格 undefined 檢查。
 */
function clusterOrder(groups: string[], matrix: Map<string, number>): string[] {
  const n = groups.length;
  if (n <= 2) return [...groups];
  const idx = new Map(groups.map((g, i) => [g, i] as const));
  const W = new Float64Array(n * n);
  for (const [k, c] of matrix) {
    const [s, d] = k.split("|");
    const i = idx.get(s);
    const j = idx.get(d);
    if (i === undefined || j === undefined) continue;
    W[i * n + j] += c;
    W[j * n + i] += c;
  }
  const deg = new Float64Array(n);
  let maxDeg = 1;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += W[i * n + j];
    deg[i] = s;
    if (s > maxDeg) maxDeg = s;
  }
  const sigma = 2 * maxDeg + 1;
  const recenter = (x: Float64Array) => {
    let m = 0;
    for (let i = 0; i < n; i++) m += x[i];
    m /= n;
    for (let i = 0; i < n; i++) x[i] -= m;
  };
  const normalize = (x: Float64Array) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += x[i] * x[i];
    const nrm = Math.sqrt(s);
    if (nrm > 1e-12) for (let i = 0; i < n; i++) x[i] /= nrm;
  };
  let v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = Math.sin(i + 1);
  recenter(v);
  normalize(v);
  for (let iter = 0; iter < 120; iter++) {
    const u = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let wv = 0;
      for (let j = 0; j < n; j++) wv += W[i * n + j] * v[j];
      u[i] = sigma * v[i] - (deg[i] * v[i] - wv);
    }
    recenter(u);
    normalize(u);
    v = u;
  }
  return groups
    .map((g, i) => ({ g, f: v[i] }))
    .sort((a, b) => a.f - b.f)
    .map((x) => x.g);
}

/**
 * 模組群耦合矩陣（adjacency heatmap）：把 874 張表 / 650 實體收斂成 27 個 form group（+ other），
 * 行＝來源群、列＝目標群，格子亮度＝跨群關係數。行列按耦合度排序，重耦合的群擠到左上角 →
 * 一眼鎖定「哪兩群纏在一起、該優先正規化」。比弦圖好讀的地方：沒有交錯的線，每格起終點零歧義。
 */
export function RagicGroupGraphExplorer({ token, onAuthFailure }: RagicGroupGraphExplorerProps) {
  const [graph, setGraph] = useState<RagicGroupGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<RagicGroupEdgeType, boolean>>({
    fk: true,
    workflow: true,
    subtable: true,
  });
  const [hover, setHover] = useState<HoverCell | null>(null);
  const [selected, setSelected] = useState<{ src: string; dst: string } | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("cluster");

  const onAuthFailureRef = useRef(onAuthFailure);
  useEffect(() => {
    onAuthFailureRef.current = onAuthFailure;
  }, [onAuthFailure]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      setGraph(await fetchRagicGroupGraph(token));
    } catch (e) {
      if (isUnauthorized(e)) {
        onAuthFailureRef.current();
        return;
      }
      setError(extractErrorMessage(e, "載入群組耦合矩陣失敗（邊表可能還沒 rebuild，先做一次重新抓取）"));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // 開啟圖層的 src×dst 加權耦合度（子表×3 FK×2 wf×1）→ 亮度與聚類都反映「拆的難度」而非連線根數
  const matrix = useMemo(() => {
    const m = new Map<string, number>();
    if (!graph) return m;
    for (const e of graph.edges) {
      if (!layers[e.type]) continue;
      const k = `${e.src}|${e.dst}`;
      m.set(k, (m.get(k) ?? 0) + e.count * EDGE_WEIGHT[e.type]);
    }
    return m;
  }, [graph, layers]);

  const selfOf = useMemo(() => {
    const m = new Map<string, number>();
    if (graph) for (const n of graph.nodes) m.set(n.group, n.selfEdges);
    return m;
  }, [graph]);

  const nodeByGroup = useMemo(() => {
    const m = new Map<string, RagicGroupGraph["nodes"][number]>();
    if (graph) for (const n of graph.nodes) m.set(n.group, n);
    return m;
  }, [graph]);

  // 群代號 → 「forms12（52 表）：客戶管理、訂單…」，滑過標籤就知道是哪些實際 Ragic 表單
  const groupTitle = (g: string): string => {
    const node = nodeByGroup.get(g);
    const label = displayName(g);
    if (!node) return label;
    const names = node.forms.slice(0, 8).map((f) => f.formName).join("、");
    const more = node.forms.length > 8 ? ` …等 ${node.forms.length} 張` : "";
    return `${label}（${g} · ${node.formCount} 表）：${names}${more}`;
  };

  // DSM 重排：row/col 用同一組順序同步重排。三策略——聚類（密格聚對角方塊、找模組）、
  // 耦合量（誰連最多）、字母（穩定查找）。預設聚類，這才是讓矩陣能下決策的排法。
  const order = useMemo(() => {
    if (!graph) return [];
    const groups = graph.nodes.map((n) => n.group);
    if (sortMode === "alpha") return [...groups].sort((a, b) => a.localeCompare(b));
    if (sortMode === "degree") {
      const deg = new Map<string, number>();
      for (const [k, c] of matrix) {
        const [s, d] = k.split("|");
        deg.set(s, (deg.get(s) ?? 0) + c);
        deg.set(d, (deg.get(d) ?? 0) + c);
      }
      return [...groups].sort(
        (a, b) => (deg.get(b) ?? 0) - (deg.get(a) ?? 0) || a.localeCompare(b)
      );
    }
    return clusterOrder(groups, matrix);
  }, [graph, matrix, sortMode]);

  // log scale：count 跨度 1~1300，線性會讓多數弱耦合格全黑、看不出層次
  const logMax = useMemo(() => {
    let mx = 1;
    for (const c of matrix.values()) if (c > mx) mx = c;
    return Math.log2(mx + 1);
  }, [matrix]);

  const colorFor = (count: number): string => {
    if (count <= 0) return "transparent";
    const t = Math.log2(count + 1) / logMax;
    return `rgba(88,166,255,${(0.1 + t * 0.82).toFixed(3)})`;
  };
  const selfColor = (count: number): string => {
    if (count <= 0) return "transparent";
    const t = Math.log2(count + 1) / logMax;
    return `rgba(139,150,165,${(0.12 + t * 0.5).toFixed(3)})`;
  };

  const pair = useMemo(() => {
    if (!selected || !graph) return null;
    const fwd = graph.edges.filter((e) => e.src === selected.src && e.dst === selected.dst);
    const bwd = graph.edges.filter((e) => e.src === selected.dst && e.dst === selected.src);
    return { fwd, bwd };
  }, [selected, graph]);

  return (
    <div className="dev-grp">
      <div className="dev-grp__toolbar">
        <div className="dev-grp__toolbar-row">
          <span className="dev-grp__count">
            {graph ? `${graph.nodes.length} 群 · ${matrix.size} 條耦合` : "—"}
          </span>
          <button
            type="button"
            className="dev-mode-button dev-grp__reload"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "載入中…" : "重新載入"}
          </button>
        </div>
        <div className="dev-grp__toolbar-row">
          <span className="dev-grp__sort">
            <span className="dev-grp__sortlabel">排序</span>
            {SORT_MODES.map(([k, label, tip]) => (
              <button
                key={k}
                type="button"
                title={tip}
                className={`dev-grp__sortbtn${sortMode === k ? " is-on" : ""}`}
                onClick={() => setSortMode(k)}
              >
                {label}
              </button>
            ))}
          </span>
          <span className="dev-grp__legend">
            <span className="dev-grp__sortlabel">顯示</span>
            {EDGE_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                title={EDGE_META[t].tip}
                className={`dev-grp__layer${layers[t] ? " is-on" : ""}`}
                onClick={() => setLayers((p) => ({ ...p, [t]: !p[t] }))}
                style={{ ["--grp-edge-color" as string]: EDGE_META[t].color }}
              >
                <span className="dev-grp__swatch" />
                {EDGE_META[t].label}
              </button>
            ))}
          </span>
        </div>
      </div>

      {error ? <p className="dev-mode-error">{error}</p> : null}

      <p className="dev-grp__readout">
        {hover
          ? hover.self
            ? `${hover.src}：群內耦合 ${hover.count}（同群的表彼此相連，整理時群內自己消化）`
            : `${hover.src} → ${hover.dst}：加權耦合 ${hover.count}`
          : sortMode === "cluster"
            ? "已自動把耦合密的群排在一起 → 對角線上靠成方塊的，就是彼此耦合深、適合一起整理的模組（子表×3、外鍵×2、Workflow×1）。點格看兩群耦合、點群名看它含哪些表單。"
            : "直排＝來源群、橫排＝被依賴的群；顏色越亮＝耦合越深（子表×3、外鍵×2、Workflow×1）。點格看明細、點群名看它含哪些表單。"}
      </p>

      {graph ? (
        <div className="dev-grp__matrixwrap">
          <div
            className="dev-grp__matrix"
            style={{ gridTemplateColumns: `var(--grp-rowlabel) repeat(${order.length}, var(--grp-cell))` }}
          >
            <div className="dev-grp__corner" />
            {order.map((col) => (
              <div
                key={col}
                className={`dev-grp__collabel${hover?.dst === col ? " is-hot" : ""}`}
                title={groupTitle(col)}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedGroup(col)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedGroup(col);
                  }
                }}
              >
                <span>{displayName(col)}</span>
              </div>
            ))}
            {order.map((row) => (
              <Fragment key={row}>
                <div
                  className={`dev-grp__rowlabel${hover?.src === row ? " is-hot" : ""}`}
                  title={groupTitle(row)}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedGroup(row)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedGroup(row);
                    }
                  }}
                >
                  {displayName(row)}
                </div>
                {order.map((col) => {
                  const self = row === col;
                  const count = self
                    ? selfOf.get(row) ?? 0
                    : matrix.get(`${row}|${col}`) ?? 0;
                  return (
                    <div
                      key={col}
                      className={`dev-grp__cell${self ? " is-self" : ""}`}
                      style={{ background: self ? selfColor(count) : colorFor(count) }}
                      onMouseEnter={() => setHover({ src: row, dst: col, count, self })}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => {
                        if (!self && count > 0) setSelected({ src: row, dst: col });
                      }}
                    />
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>
      ) : loading ? (
        <p className="dev-ent__hint ragic-loading-inline">載入中…</p>
      ) : null}

      {pair && selected ? (
        <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
          <Modal
            open
            onCancel={() => setSelected(null)}
            footer={null}
            width="48vw"
            title={`${displayName(selected.src)} ↔ ${displayName(selected.dst)}`}
            styles={{ body: { maxHeight: "60vh", overflow: "auto" } }}
          >
            <div className="dev-modal-scope dev-grp__detail">
              <PairTable title={`${displayName(selected.src)} → ${displayName(selected.dst)}（前者依賴後者）`} edges={pair.fwd} />
              <PairTable title={`${displayName(selected.dst)} → ${displayName(selected.src)}（反向依賴）`} edges={pair.bwd} />
              <GroupMembers group={displayName(selected.src)} node={nodeByGroup.get(selected.src)} />
              <GroupMembers group={displayName(selected.dst)} node={nodeByGroup.get(selected.dst)} />
            </div>
          </Modal>
        </ConfigProvider>
      ) : null}

      {selectedGroup ? (
        <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
          <Modal
            open
            onCancel={() => setSelectedGroup(null)}
            footer={null}
            width="48vw"
            title={`群「${displayName(selectedGroup)}」含哪些表單`}
            styles={{ body: { maxHeight: "60vh", overflow: "auto" } }}
          >
            <div className="dev-modal-scope dev-grp__detail">
              <GroupMembers group={displayName(selectedGroup)} node={nodeByGroup.get(selectedGroup)} />
            </div>
          </Modal>
        </ConfigProvider>
      ) : null}
    </div>
  );
}

function PairTable({ title, edges }: { title: string; edges: RagicGroupGraph["edges"] }) {
  return (
    <div className="dev-grp__edges">
      <span className="dev-ent__views-label">{title}：</span>
      {edges.length ? (
        <table className="dev-ent__fields">
          <thead>
            <tr>
              <th>關係型</th>
              <th>數量</th>
            </tr>
          </thead>
          <tbody>
            {edges.map((e) => (
              <tr key={e.type}>
                <td>
                  <span
                    className="dev-ent__mark"
                    title={EDGE_META[e.type].tip}
                    style={{ ["--grp-edge-color" as string]: EDGE_META[e.type].color, color: EDGE_META[e.type].color }}
                  >
                    {EDGE_META[e.type].label}
                  </span>
                </td>
                <td className="dev-grp__num">{e.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="dev-ent__hint">無</p>
      )}
    </div>
  );
}

function GroupMembers({
  group,
  node,
}: {
  group: string;
  node?: RagicGroupGraph["nodes"][number];
}) {
  const forms = node?.forms ?? [];
  return (
    <div className="dev-grp__members">
      <span className="dev-ent__views-label">
        群「{group}」含 {forms.length} 張表（點開連到 Ragic）：
      </span>
      <div className="dev-grp__memberlist">
        {forms.map((f) => (
          <a
            key={f.formPath}
            className="dev-deps__node-link"
            href={f.ragicUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {f.formName || f.formPath} ↗
          </a>
        ))}
      </div>
    </div>
  );
}
