import { HttpError } from "../../../utils/httpError";

export function resolveFieldMutationPrecondition<T>(input: {
  current: T;
  expected: T;
  intended: T;
  label: string;
}): "unchanged" | "write" {
  if (Object.is(input.current, input.intended)) return "unchanged";
  if (Object.is(input.current, input.expected)) return "write";
  throw new HttpError(
    409,
    `${input.label}已被其他操作修改，目前值為 ${input.current ?? "空白"}；請重新整理後確認。`,
    "ENTRY_FIELD_CONFLICT"
  );
}

export function assertFieldOrEntryPrecondition<T>(input: {
  current: T;
  expected: T | undefined;
  intended: T;
  label: string;
  expectedEntryLastUpdatedAt?: string;
  currentEntryLastUpdatedAt: string;
}): void {
  if (input.expected !== undefined) {
    resolveFieldMutationPrecondition({ ...input, expected: input.expected });
    return;
  }
  if (Object.is(input.current, input.intended)) return;
  const expected = String(input.expectedEntryLastUpdatedAt ?? "").trim();
  if (!expected) {
    throw new HttpError(409, `${input.label}缺少修改前的值，請重新整理後再試。`, "ENTRY_PRECONDITION_REQUIRED");
  }
  if (input.currentEntryLastUpdatedAt !== expected) {
    throw new HttpError(409, `${input.label}使用的工令版本已變更，請重新整理後再試。`, "ENTRY_CONFLICT");
  }
}
