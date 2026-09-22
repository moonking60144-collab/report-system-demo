import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const self = "scripts/check-publication-boundary.mjs";
const excludedFiles = new Set([
  self,
  "backend/package-lock.json",
  "frontend/package-lock.json",
  "services/meeting-stt/uv.lock",
]);

const fromCodePoints = (...points) => String.fromCodePoint(...points);
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exactAlternatives = (values, flags = "u") =>
  new RegExp(values.map(escapeRegExp).join("|"), flags);

// Keep sensitive fingerprints out of the public source while still rejecting
// accidental reintroduction of the original names and vocabulary.
const concealedTerms = {
  companyNames: [
    fromCodePoints(0x46, 0x75, 0x6e, 0x64, 0x61),
    fromCodePoints(0x5b8f, 0x5f97),
  ],
  legacyFormSymbol: fromCodePoints(0x66, 0x6f, 0x72, 0x6d, 0x31, 0x36),
  legacyProcesses: [
    fromCodePoints(0x6413, 0x7259),
    fromCodePoints(0x6253, 0x982d),
  ],
  legacyEmployeePrefix: fromCodePoints(0x46, 0x44),
  legacyOperator: fromCodePoints(0x7f85, 0x667a, 0x52a0),
  legacyUpstreamField: fromCodePoints(
    0x64, 0x65, 0x6d, 0x6f, 0x5f, 0x6d, 0x69, 0x73, 0x5f, 0x63, 0x6c, 0x6f, 0x73, 0x65, 0x5f, 0x73, 0x74, 0x61, 0x74, 0x75, 0x73
  ),
};

const forbidden = [
  ["company name", exactAlternatives(concealedTerms.companyNames, "iu")],
  ["company host", /https?:\/\/(?:api\.)?[a-z0-9-]+\.app\b/iu],
  ["developer home", /\/Users\/[^/\s]+/u],
  ["production write target", /RAGIC_WRITE_TARGET\s*=\s*prod/iu],
  ["production deploy directory", /[A-Z]:\\sites\\[^\s"']+/iu],
  ["legacy form path", /\/default\/forms(?:[1-9]|[1-9]\d)\/\d+|\/forms[1-9]\/\d+|\/default\/c\d+\/\d+/iu],
  ["legacy field ID", /\b10[0-2]\d{4}\b/u],
  ["legacy subtable ID", /_subtable_10[0-2]\d{4}\b/u],
  ["legacy form symbols", new RegExp(escapeRegExp(concealedTerms.legacyFormSymbol), "iu")],
  ["legacy process vocabulary", exactAlternatives(concealedTerms.legacyProcesses, "u")],
  ["legacy employee prefix", new RegExp(`\\b${escapeRegExp(concealedTerms.legacyEmployeePrefix)}\\d{3,}\\b`, "u")],
  ["legacy operator identity", new RegExp(escapeRegExp(concealedTerms.legacyOperator), "u")],
  ["legacy material fixture", /\b(?:5203|5701|VN-\d{3})[A-Z0-9-]{8,}\b/u],
  ["legacy upstream field", new RegExp(escapeRegExp(concealedTerms.legacyUpstreamField), "u")],
  ["production-looking work order", /\bWO-\d{6,}\b/u],
  ["production action script", /ragic-action-button-id-\d+|run-backend-server\.cmd/u],
];

function listGitFiles(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

const tracked = [
  ...listGitFiles(["ls-files", "-z"]),
  ...listGitFiles(["ls-files", "--others", "--exclude-standard", "-z"]),
].filter((file, index, all) => all.indexOf(file) === index && !excludedFiles.has(file));

const findings = [];
for (const file of tracked) {
  const absolutePath = path.join(repoRoot, file);
  let content;
  try {
    content = readFileSync(absolutePath, "utf8");
  } catch {
    continue;
  }
  if (content.includes("\0")) continue;

  for (const [label, pattern] of forbidden) {
    const match = content.match(pattern);
    if (!match || match.index === undefined) continue;
    const line = content.slice(0, match.index).split("\n").length;
    findings.push(`${file}:${line}: ${label}: ${JSON.stringify(match[0])}`);
  }
}

if (findings.length > 0) {
  console.error("Publication boundary check failed:\n" + findings.join("\n"));
  process.exit(1);
}

console.log(`Publication boundary check passed for ${tracked.length} tracked and untracked files.`);
