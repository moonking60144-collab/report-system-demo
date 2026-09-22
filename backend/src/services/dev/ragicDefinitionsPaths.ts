import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export function findExistingDefinitionsRoot(): string {
  const explicit = process.env.RAGIC_DEFINITIONS_PATH?.trim();
  if (explicit) return resolve(explicit);

  const candidates = [
    resolve(process.cwd(), "../ragic-definitions"),
    resolve(process.cwd(), "ragic-definitions"),
  ];
  return candidates.find((path) => existsSync(path)) ?? candidates[0];
}

export function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

export function normalizeDefinitionsPathspec(
  repoRoot: string,
  definitionsRoot: string
): string {
  const rel = relative(resolve(repoRoot), resolve(definitionsRoot)).replace(/\\/g, "/");
  return rel || ".";
}

export function isAllowedDefinitionsPathspec(pathspec: string): boolean {
  return pathspec === "ragic-definitions" || pathspec.endsWith("/ragic-definitions");
}
