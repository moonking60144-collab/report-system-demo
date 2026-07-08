export interface RagicDefinitionsEntryScope {
  path: string;
  formPath: string | null;
}

function extractPathFromPorcelainLine(raw: string): string {
  const rawPath = raw.length >= 4 ? raw.slice(3).trim() : raw.trim();
  return rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
}

export function normalizeRagicFormPath(raw: string): string | null {
  const formPath = String(raw ?? "").trim().replace(/^\/+|\/+$/g, "");
  const parts = formPath.split("/");
  if (parts.length < 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
    return null;
  }
  return parts.join("/");
}

export function getDefinitionsEntryFormPath(
  path: string,
  definitionsPathspec = "ragic-definitions"
): string | null {
  const prefix = `${definitionsPathspec}/`;
  const relativePath =
    path === definitionsPathspec
      ? ""
      : path.startsWith(prefix)
        ? path.slice(prefix.length)
        : path;
  const parts = relativePath.split("/").filter(Boolean);
  if (parts[0] !== "forms" || parts.length < 5) {
    return null;
  }

  const last = parts.at(-1) ?? "";
  const formParts =
    parts.at(-2) === "workflows" && last.endsWith(".js")
      ? parts.slice(1, -2)
      : parts.slice(1, -1);
  return normalizeRagicFormPath(formParts.join("/"));
}

export function getDefinitionsEntryScope(
  rawOrPath: string,
  definitionsPathspec = "ragic-definitions"
): RagicDefinitionsEntryScope {
  const path = rawOrPath.length >= 4 && rawOrPath[2] === " "
    ? extractPathFromPorcelainLine(rawOrPath)
    : rawOrPath.trim();
  return {
    path,
    formPath: getDefinitionsEntryFormPath(path, definitionsPathspec),
  };
}

export function buildFormDefinitionsPathspec(
  definitionsPathspec: string,
  formPath: string
): string | null {
  const normalized = normalizeRagicFormPath(formPath);
  return normalized ? `${definitionsPathspec}/forms/${normalized}` : null;
}

export function normalizeScopedFormPaths(formPaths: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of formPaths ?? []) {
    const normalized = normalizeRagicFormPath(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function splitDefinitionsEntriesByFormScope<T extends { path: string }>(
  entries: readonly T[],
  scopedFormPaths: readonly string[],
  definitionsPathspec = "ragic-definitions"
): { scopedEntries: T[]; retainedEntries: T[] } {
  const scopedSet = new Set(scopedFormPaths);
  const scopedEntries: T[] = [];
  const retainedEntries: T[] = [];
  for (const entry of entries) {
    const formPath = getDefinitionsEntryFormPath(entry.path, definitionsPathspec);
    if (formPath && scopedSet.has(formPath)) {
      scopedEntries.push(entry);
    } else {
      retainedEntries.push(entry);
    }
  }
  return { scopedEntries, retainedEntries };
}

export function splitRawDefinitionsEntriesByFormScope(
  entries: readonly string[],
  scopedFormPaths: readonly string[],
  definitionsPathspec = "ragic-definitions"
): { scopedEntries: string[]; retainedEntries: string[] } {
  const scopedSet = new Set(scopedFormPaths);
  const scopedEntries: string[] = [];
  const retainedEntries: string[] = [];
  for (const entry of entries) {
    const scope = getDefinitionsEntryScope(entry, definitionsPathspec);
    if (scope.formPath && scopedSet.has(scope.formPath)) {
      scopedEntries.push(entry);
    } else {
      retainedEntries.push(entry);
    }
  }
  return { scopedEntries, retainedEntries };
}
