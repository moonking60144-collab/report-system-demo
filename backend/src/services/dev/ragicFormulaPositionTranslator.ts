/**
 * 公式位置翻譯器：把來源表單公式裡的 cell ref（A6、BR5…）翻譯成目標版本表單
 * 上「同 fieldId 欄位」的對應位置。多版本表單共享 fieldId 但佈局（position）
 * 不同，公式照抄會指到錯的欄位，必須逐 ref 重新映射。
 *
 * 純函式：position↔fieldId 對應表由 caller 準備（來源 ragic_field_index），
 * 這裡不碰 DB / 檔案。
 *
 * Tokenizer 規則（由全專案 11,571 條公式取樣歸納）：
 *   - cell ref = [A-Z]{1,3}\d{1,4}，前後不得是英數字或 _（寬表單有 AC9/BR5 雙字母）
 *   - 字串字面值 "..." / '...' 內的內容一律不動
 *   - token 後緊跟 "(" 視為函式呼叫（防 LOG10( 這類「字母+數字」函式名誤抓）
 *   - XN.RAW 語法：ref 部分翻譯、.RAW 後綴自然保留（RAW 無數字不會被當 ref）
 *   - "$" 絕對參照（全專案僅 2 處）不支援：含 $ 的 ref 直接標不可譯
 *
 * 拒譯原則：任何一個 ref 對不到（來源查無此位置欄位 / 該欄位不存在於目標表）
 * → translated 回 null，寧可整條退回手動，不給看似可用實則錯位的公式。
 */

export interface TranslatorFieldInfo {
  fieldId: string;
  fieldName: string;
}

export interface TranslateFormulaInput {
  formula: string;
  /** 來源表單 position → 欄位（同表內 position 唯一） */
  sourceByPosition: ReadonlyMap<string, TranslatorFieldInfo>;
  /** 目標表單 fieldId → position；ambiguous 表示同 fieldId 對到多個位置，不可自動套用 */
  targetPositionByFieldId: ReadonlyMap<
    string,
    { position: string; fieldName: string; ambiguous?: boolean; positions?: string[] }
  >;
}

export interface TranslateFormulaMappingItem {
  from: string;
  to: string;
  fieldId: string;
  fieldName: string;
}

export interface TranslateFormulaUntranslatableItem {
  token: string;
  reason: string;
}

export interface TranslateFormulaResult {
  /** 全部 ref 都成功映射才有值；任一失敗為 null */
  translated: string | null;
  mapping: TranslateFormulaMappingItem[];
  untranslatable: TranslateFormulaUntranslatableItem[];
}

const CELL_REF_PATTERN = /^[A-Z]{1,3}\d{1,4}$/;

interface FormulaToken {
  text: string;
  isCellRef: boolean;
  invalidReason?: string;
}

function isRefLikeToken(value: string): boolean {
  return /^[A-Z]+\d+$/.test(value);
}

function containsUnsupportedAbsoluteReference(formula: string): boolean {
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (ch === '"' || ch === "'") {
      const end = formula.indexOf(ch, i + 1);
      i = end === -1 ? formula.length : end + 1;
      continue;
    }
    if (ch === "$") {
      const prev = i > 0 ? formula[i - 1] : "";
      const next = i + 1 < formula.length ? formula[i + 1] : "";
      if (/[A-Z0-9]/.test(prev) || /[A-Z]/.test(next)) {
        return true;
      }
    }
    i += 1;
  }
  return false;
}

/**
 * 把公式切成「cell ref token」與「其他文字」的序列。
 * 字串字面值整段視為其他文字；ref 的前後字元邊界與函式呼叫排除在此處理。
 */
export function tokenizeFormula(formula: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  let plain = "";
  let i = 0;

  const flushPlain = () => {
    if (plain) {
      tokens.push({ text: plain, isCellRef: false });
      plain = "";
    }
  };

  while (i < formula.length) {
    const ch = formula[i];

    // 字串字面值：吃到下一個同 quote 為止（Ragic 公式字串無跳脫語法）
    if (ch === '"' || ch === "'") {
      const end = formula.indexOf(ch, i + 1);
      const literal = end === -1 ? formula.slice(i) : formula.slice(i, end + 1);
      plain += literal;
      i += literal.length;
      continue;
    }

    if (ch >= "A" && ch <= "Z") {
      // 前一個字元是英數字或 _ → 這段字母是長識別字的一部分，不是 ref 開頭
      const prev = i > 0 ? formula[i - 1] : "";
      const prevIsWordChar = /[A-Za-z0-9_$]/.test(prev);

      let j = i;
      while (j < formula.length && formula[j] >= "A" && formula[j] <= "Z") j += 1;
      let k = j;
      while (k < formula.length && formula[k] >= "0" && formula[k] <= "9") k += 1;

      const candidate = formula.slice(i, k);
      const next = k < formula.length ? formula[k] : "";
      const nextIsWordChar = /[A-Za-z0-9_$]/.test(next);
      const isFunctionCall = next === "(";

      if (
        !prevIsWordChar &&
        !nextIsWordChar &&
        !isFunctionCall &&
        CELL_REF_PATTERN.test(candidate)
      ) {
        flushPlain();
        tokens.push({ text: candidate, isCellRef: true });
        i = k;
        continue;
      }

      if (
        !prevIsWordChar &&
        !nextIsWordChar &&
        !isFunctionCall &&
        isRefLikeToken(candidate)
      ) {
        flushPlain();
        tokens.push({
          text: candidate,
          isCellRef: false,
          invalidReason: "cell ref 超出自動推估支援範圍",
        });
        i = k;
        continue;
      }

      // 不是 ref：整段（字母+數字）當一般文字吞掉，避免下一輪從中間誤判
      plain += candidate;
      i = k;
      continue;
    }

    plain += ch;
    i += 1;
  }

  flushPlain();
  return tokens;
}

export function translateFormulaPositions(
  input: TranslateFormulaInput
): TranslateFormulaResult {
  const tokens = tokenizeFormula(input.formula);
  const mapping: TranslateFormulaMappingItem[] = [];
  const mappingByFrom = new Map<string, TranslateFormulaMappingItem>();
  const untranslatable: TranslateFormulaUntranslatableItem[] = [];
  const seenUntranslatable = new Set<string>();

  const pushUntranslatable = (token: string, reason: string) => {
    if (seenUntranslatable.has(token)) return;
    seenUntranslatable.add(token);
    untranslatable.push({ token, reason });
  };

  // 含 $ 的絕對參照：tokenizer 不會把它切成 ref（$ 視為 word char），
  // 但要主動告知使用者這條公式有不支援的語法
  if (containsUnsupportedAbsoluteReference(input.formula)) {
    pushUntranslatable("$", "公式含 $ 絕對參照，不支援自動推估");
  }

  const pieces: string[] = [];
  for (const token of tokens) {
    if (!token.isCellRef) {
      if (token.invalidReason) {
        pushUntranslatable(token.text, token.invalidReason);
      }
      pieces.push(token.text);
      continue;
    }

    const cached = mappingByFrom.get(token.text);
    if (cached) {
      pieces.push(cached.to);
      continue;
    }

    const sourceField = input.sourceByPosition.get(token.text);
    if (!sourceField) {
      pushUntranslatable(token.text, `來源表單沒有位置 ${token.text} 的欄位`);
      pieces.push(token.text);
      continue;
    }

    const targetField = input.targetPositionByFieldId.get(sourceField.fieldId);
    if (!targetField) {
      pushUntranslatable(
        token.text,
        `欄位「${sourceField.fieldName}」(${sourceField.fieldId}) 不存在於目標表單`
      );
      pieces.push(token.text);
      continue;
    }
    if (targetField.ambiguous) {
      pushUntranslatable(
        token.text,
        `欄位「${sourceField.fieldName}」(${sourceField.fieldId}) 在目標表單有多個位置：${
          targetField.positions?.join(" / ") ?? "unknown"
        }，請手動確認`
      );
      pieces.push(token.text);
      continue;
    }

    const item: TranslateFormulaMappingItem = {
      from: token.text,
      to: targetField.position,
      fieldId: sourceField.fieldId,
      fieldName: sourceField.fieldName,
    };
    mapping.push(item);
    mappingByFrom.set(token.text, item);
    pieces.push(targetField.position);
  }

  return {
    translated: untranslatable.length === 0 ? pieces.join("") : null,
    mapping,
    untranslatable,
  };
}
