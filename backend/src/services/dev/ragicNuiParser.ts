export interface RawAttr {
  key: string;
  rawValue: string | null;
  decodedValue: string;
}

export interface ParsedNuiFieldLine {
  kind: string;
  column: number;
  row: number;
  position: string;
  fieldId: string;
  fieldName: string;
  rawAttrs: string;
  attrs: RawAttr[];
  sourceLine: number;
  parts: string[];
}

export function splitFirstCommas(line: string, count: number): string[] | null {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < count; i += 1) {
    const comma = line.indexOf(",", start);
    if (comma < 0) return null;
    parts.push(line.slice(start, comma));
    start = comma + 1;
  }
  parts.push(line.slice(start));
  return parts;
}

function colToLetters(col: number): string {
  let n = col;
  let out = "";
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out || "?";
}

export function decodeAttrValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseRawAttrs(raw: string): RawAttr[] {
  if (!raw) return [];
  return raw.split("&").map((part) => {
    const eq = part.indexOf("=");
    if (eq < 0) {
      return { key: part, rawValue: null, decodedValue: "" };
    }
    const key = part.slice(0, eq);
    const rawValue = part.slice(eq + 1);
    return { key, rawValue, decodedValue: decodeAttrValue(rawValue) };
  });
}

export function parseNuiFieldLine(
  line: string,
  sourceLine: number
): ParsedNuiFieldLine | null {
  if (!/^[A-Z],/.test(line)) return null;
  const parts = splitFirstCommas(line, 5);
  if (!parts || parts.length < 6) return null;
  const [kind, colRaw, rowRaw, fieldId, fieldName, rawAttrs] = parts;
  if (kind !== "D" && kind !== "L") return null;
  if (!fieldId || !/^\d+$/.test(fieldId)) return null;
  const column = Number(colRaw);
  const row = Number(rowRaw);
  if (!Number.isFinite(column) || !Number.isFinite(row)) return null;
  return {
    kind,
    column,
    row,
    position: `${colToLetters(column)}${row}`,
    fieldId,
    fieldName,
    rawAttrs,
    attrs: parseRawAttrs(rawAttrs),
    sourceLine,
    parts,
  };
}
