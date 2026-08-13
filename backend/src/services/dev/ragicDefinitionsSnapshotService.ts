import { createHash, webcrypto } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir as mkdirAsync,
  readFile as readFileAsync,
  readdir as readdirAsync,
  rename as renameAsync,
  rm as rmAsync,
  stat as statAsync,
  writeFile as writeFileAsync,
} from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gunzip, gunzipSync, gzip, gzipSync } from "node:zlib";
import type {
  RagicDefinitionField,
  RagicDefinitionForm,
  RagicDefinitionFormDetail,
  RagicDefinitionFormula,
  RagicDefinitionManifest,
  RagicDefinitionWorkflow,
  RagicDefinitionsSnapshotDescriptor,
  RagicDefinitionsSnapshotHistoryItem,
  RagicDefinitionsSnapshotPayload,
} from "@shared-types/ragicDefinitions";

export const RAGIC_DEFINITIONS_REVISION_ALGORITHM =
  "sha256-path-content-v1" as const;
export const RAGIC_DEFINITIONS_SNAPSHOT_SCHEMA_VERSION = 1 as const;

const DEFAULT_RETAIN_COUNT = 10;
const MAX_RETAIN_COUNT = 100;
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const REVISION_PATTERN = /^sha256:([a-f0-9]{64})$/;
const SNAPSHOT_META_SUFFIX = ".meta.json";
const SNAPSHOT_DATA_SUFFIX = ".json.gz";
const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

interface DefinitionArtifact {
  relativePath: string;
  content: Buffer;
}

interface SnapshotMetadataFile {
  schemaVersion: 1;
  revision: string;
  revisionAlgorithm: typeof RAGIC_DEFINITIONS_REVISION_ALGORITHM;
  artifactCount: number;
  counts: RagicDefinitionManifest["counts"];
  namespaceFilter: RagicDefinitionManifest["namespaceFilter"] | null;
  materializedAt: string;
  compressedBytes: number;
  artifactSha256: string;
  payloadSha256: string;
}

function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface MaterializedRagicDefinitionsSnapshot {
  descriptor: RagicDefinitionsSnapshotHistoryItem;
  filePath: string;
}

export interface PreparedRagicDefinitionsSnapshot {
  descriptor: RagicDefinitionsSnapshotHistoryItem;
  filePath: string;
  publish(options?: { pruneAfter?: boolean }): MaterializedRagicDefinitionsSnapshot;
}

export interface LoadedRagicDefinitionsSnapshot {
  descriptor: RagicDefinitionsSnapshotHistoryItem;
  content: Buffer;
}

export interface RagicDefinitionsSnapshotServiceOptions {
  definitionsRoot: string;
  snapshotRoot?: string;
  retainCount?: number;
}

function workflowScope(fileName: string): string {
  return fileName.replace(/\.js$/i, "");
}

function isDefinitionArtifact(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized.startsWith("forms/")) return false;
  const fileName = basename(normalized);
  return (
    fileName === "form.json" ||
    fileName === "fields.json" ||
    fileName === "formulas.json" ||
    (normalized.includes("/workflows/") && fileName.endsWith(".js"))
  );
}

function listDefinitionArtifacts(definitionsRoot: string): DefinitionArtifact[] {
  const formsRoot = join(definitionsRoot, "forms");
  if (!existsSync(formsRoot) || !statSync(formsRoot).isDirectory()) {
    throw new Error(`definitions forms 目錄不存在：${formsRoot}`);
  }

  const artifacts: DefinitionArtifact[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(definitionsRoot, fullPath).split(sep).join("/");
      if (!isDefinitionArtifact(relativePath)) {
        throw new Error(`definitions 含有不支援的 artifact：${relativePath}`);
      }
      artifacts.push({
        relativePath,
        content: readFileSync(fullPath),
      });
    }
  };
  walk(formsRoot);
  return artifacts.sort((a, b) => compareOrdinal(a.relativePath, b.relativePath));
}

async function listDefinitionArtifactsAsync(
  definitionsRoot: string
): Promise<DefinitionArtifact[]> {
  const formsRoot = join(definitionsRoot, "forms");
  try {
    if (!(await statAsync(formsRoot)).isDirectory()) {
      throw new Error(`definitions forms 目錄不存在：${formsRoot}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`definitions forms 目錄不存在：${formsRoot}`);
    }
    throw error;
  }

  const artifacts: DefinitionArtifact[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdirAsync(dir, { withFileTypes: true });
    entries.sort((a, b) => compareOrdinal(a.name, b.name));
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(definitionsRoot, fullPath)
        .split(sep)
        .join("/");
      if (!isDefinitionArtifact(relativePath)) {
        throw new Error(`definitions 含有不支援的 artifact：${relativePath}`);
      }
      artifacts.push({
        relativePath,
        content: await readFileAsync(fullPath),
      });
    }
  };
  await walk(formsRoot);
  return artifacts.sort((a, b) => compareOrdinal(a.relativePath, b.relativePath));
}

function revisionForArtifacts(artifacts: DefinitionArtifact[]): string {
  const hash = createHash("sha256");
  const ordered = [...artifacts].sort((a, b) =>
    compareOrdinal(a.relativePath, b.relativePath)
  );
  for (const artifact of ordered) {
    const pathBytes = Buffer.from(artifact.relativePath, "utf-8");
    const lengthBytes = Buffer.from(String(artifact.content.length), "ascii");
    hash.update(pathBytes);
    hash.update(Buffer.from([0]));
    hash.update(lengthBytes);
    hash.update(Buffer.from([0]));
    hash.update(artifact.content);
    hash.update(Buffer.from([255]));
  }
  return `sha256:${hash.digest("hex")}`;
}

function normalizeNamespaceFilter(
  namespaceFilter: RagicDefinitionManifest["namespaceFilter"]
): RagicDefinitionManifest["namespaceFilter"] {
  if (!namespaceFilter) return undefined;
  if (namespaceFilter.mode === "all") return { mode: "all" };
  if (namespaceFilter.mode !== "include") {
    throw new Error(`不支援的 definitions namespace filter：${namespaceFilter.mode}`);
  }
  const namespaces = [...new Set(namespaceFilter.namespaces ?? [])].sort();
  return { mode: "include", namespaces };
}

function manifestContractArtifact(
  manifest: RagicDefinitionManifest
): DefinitionArtifact {
  return {
    relativePath: "manifest.contract.json",
    content: Buffer.from(
      `${JSON.stringify({
        snapshotSchemaVersion: RAGIC_DEFINITIONS_SNAPSHOT_SCHEMA_VERSION,
        namespaceFilter: normalizeNamespaceFilter(manifest.namespaceFilter) ?? null,
      })}\n`,
      "utf-8"
    ),
  };
}

function parseJson<T>(artifact: DefinitionArtifact): T {
  try {
    return JSON.parse(artifact.content.toString("utf-8")) as T;
  } catch (error) {
    throw new Error(
      `definitions JSON 無法解析：${artifact.relativePath}：${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function manifestCountsFromForms(
  forms: RagicDefinitionFormDetail[]
): RagicDefinitionManifest["counts"] {
  return forms.reduce(
    (counts, detail) => ({
      forms: counts.forms + 1,
      fields: counts.fields + detail.fields.length,
      formulas: counts.formulas + detail.formulas.length,
      workflows: counts.workflows + detail.workflows.length,
    }),
    { forms: 0, fields: 0, formulas: 0, workflows: 0 }
  );
}

function assertCountsEqual(
  actual: RagicDefinitionManifest["counts"],
  expected: RagicDefinitionManifest["counts"]
): void {
  for (const key of ["forms", "fields", "formulas", "workflows"] as const) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `definitions manifest counts 不一致：${key} expected=${expected[key]} actual=${actual[key]}`
      );
    }
  }
}

function formsFromArtifacts(artifacts: DefinitionArtifact[]): RagicDefinitionFormDetail[] {
  const byPath = new Map(artifacts.map((artifact) => [artifact.relativePath, artifact]));
  const formArtifacts = artifacts.filter((artifact) =>
    artifact.relativePath.endsWith("/form.json")
  );
  return formArtifacts
    .map((formArtifact) => {
      const form = parseJson<RagicDefinitionForm>(formArtifact);
      const basePath = formArtifact.relativePath.slice(0, -"/form.json".length);
      const fieldsArtifact = byPath.get(`${basePath}/fields.json`);
      const formulasArtifact = byPath.get(`${basePath}/formulas.json`);
      if (!fieldsArtifact || !formulasArtifact) {
        throw new Error(`definitions 表單缺少 fields/formulas artifact：${form.formPath}`);
      }
      const expectedBasePath = `forms/${form.formPath}`;
      if (basePath !== expectedBasePath) {
        throw new Error(
          `definitions formPath 與目錄不一致：${form.formPath} != ${basePath}`
        );
      }
      const workflows = artifacts
        .filter((artifact) =>
          artifact.relativePath.startsWith(`${basePath}/workflows/`)
        )
        .map<RagicDefinitionWorkflow>((artifact) => {
          const fileName = basename(artifact.relativePath);
          const content = artifact.content.toString("utf-8");
          return {
            scope: workflowScope(fileName),
            fileName,
            content,
            charCount: content.length,
          };
        })
        .sort((a, b) => compareOrdinal(a.fileName, b.fileName));
      const fields = parseJson<RagicDefinitionField[]>(fieldsArtifact);
      const formulas = parseJson<RagicDefinitionFormula[]>(formulasArtifact);
      if (
        form.counts.fields !== fields.length ||
        form.counts.formulas !== formulas.length ||
        form.counts.workflows !== workflows.length
      ) {
        throw new Error(`definitions form counts 不一致：${form.formPath}`);
      }
      return { form, fields, formulas, workflows };
    })
    .sort((a, b) => compareOrdinal(a.form.formPath, b.form.formPath));
}

function normalizeManifest(
  manifest: RagicDefinitionManifest,
  revision: string,
  artifactCount: number
): RagicDefinitionManifest {
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
    throw new Error(
      `不支援的 definitions manifest schemaVersion：${manifest.schemaVersion}`
    );
  }
  if (manifest.revision && manifest.revision !== revision) {
    throw new Error(
      `definitions manifest revision 不一致：expected=${manifest.revision} actual=${revision}`
    );
  }
  if (
    manifest.revisionAlgorithm &&
    manifest.revisionAlgorithm !== RAGIC_DEFINITIONS_REVISION_ALGORITHM
  ) {
    throw new Error(
      `不支援的 definitions revision algorithm：${manifest.revisionAlgorithm}`
    );
  }
  if (
    manifest.artifactCount !== undefined &&
    manifest.artifactCount !== artifactCount
  ) {
    throw new Error(
      `definitions artifactCount 不一致：expected=${manifest.artifactCount} actual=${artifactCount}`
    );
  }
  const normalized: RagicDefinitionManifest = {
    schemaVersion: 2,
    revision,
    revisionAlgorithm: RAGIC_DEFINITIONS_REVISION_ALGORITHM,
    artifactCount,
    counts: { ...manifest.counts },
  };
  const namespaceFilter = normalizeNamespaceFilter(manifest.namespaceFilter);
  if (namespaceFilter) normalized.namespaceFilter = namespaceFilter;
  return normalized;
}

function buildRagicDefinitionsSnapshotPayloadFromManifest(
  root: string,
  rawManifest: RagicDefinitionManifest
): RagicDefinitionsSnapshotPayload {
  const artifacts = listDefinitionArtifacts(root);
  const revision = revisionForArtifacts([
    manifestContractArtifact(rawManifest),
    ...artifacts,
  ]);
  const forms = formsFromArtifacts(artifacts);
  const counts = manifestCountsFromForms(forms);
  assertCountsEqual(counts, rawManifest.counts);
  const manifest = normalizeManifest(rawManifest, revision, artifacts.length);
  return {
    schemaVersion: RAGIC_DEFINITIONS_SNAPSHOT_SCHEMA_VERSION,
    revision,
    revisionAlgorithm: RAGIC_DEFINITIONS_REVISION_ALGORITHM,
    artifactCount: artifacts.length,
    manifest,
    forms,
  };
}

export function buildRagicDefinitionsSnapshotPayload(
  definitionsRoot: string
): RagicDefinitionsSnapshotPayload {
  const root = resolve(definitionsRoot);
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`definitions manifest 不存在：${manifestPath}`);
  }
  const rawManifest = JSON.parse(
    readFileSync(manifestPath, "utf-8")
  ) as RagicDefinitionManifest;
  return buildRagicDefinitionsSnapshotPayloadFromManifest(root, rawManifest);
}

export async function buildRagicDefinitionsSnapshotPayloadAsync(
  definitionsRoot: string
): Promise<RagicDefinitionsSnapshotPayload> {
  const root = resolve(definitionsRoot);
  const manifestPath = join(root, "manifest.json");
  let manifestContent: string;
  try {
    manifestContent = await readFileAsync(manifestPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`definitions manifest 不存在：${manifestPath}`);
    }
    throw error;
  }
  const rawManifest = JSON.parse(manifestContent) as RagicDefinitionManifest;
  const artifacts = await listDefinitionArtifactsAsync(root);
  const revision = revisionForArtifacts([
    manifestContractArtifact(rawManifest),
    ...artifacts,
  ]);
  const forms = formsFromArtifacts(artifacts);
  const counts = manifestCountsFromForms(forms);
  assertCountsEqual(counts, rawManifest.counts);
  const manifest = normalizeManifest(rawManifest, revision, artifacts.length);
  return {
    schemaVersion: RAGIC_DEFINITIONS_SNAPSHOT_SCHEMA_VERSION,
    revision,
    revisionAlgorithm: RAGIC_DEFINITIONS_REVISION_ALGORITHM,
    artifactCount: artifacts.length,
    manifest,
    forms,
  };
}

export function snapshotDescriptorFromPayload(
  payload: RagicDefinitionsSnapshotPayload,
  publishedAt: string | null
): RagicDefinitionsSnapshotDescriptor {
  return {
    schemaVersion: RAGIC_DEFINITIONS_SNAPSHOT_SCHEMA_VERSION,
    revision: payload.revision,
    revisionAlgorithm: payload.revisionAlgorithm,
    artifactCount: payload.artifactCount,
    counts: payload.manifest.counts,
    namespaceFilter: payload.manifest.namespaceFilter ?? null,
    publishedAt,
  };
}

function revisionHex(revision: string): string {
  const match = REVISION_PATTERN.exec(revision);
  if (!match) throw new Error(`不合法的 definitions revision：${revision}`);
  return match[1];
}

export function isRagicDefinitionsRevision(value: string): boolean {
  return REVISION_PATTERN.test(value);
}

export function readCurrentRagicDefinitionsSnapshotDescriptor(
  definitionsRoot: string
): RagicDefinitionsSnapshotDescriptor | null {
  return readCurrentRagicDefinitionsSnapshotPublication(definitionsRoot)?.descriptor ?? null;
}

export interface CurrentRagicDefinitionsSnapshotPublication {
  manifestFingerprint: string;
  descriptor: RagicDefinitionsSnapshotDescriptor;
}

export function readCurrentRagicDefinitionsSnapshotPublication(
  definitionsRoot: string
): CurrentRagicDefinitionsSnapshotPublication | null {
  const root = resolve(definitionsRoot);
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  let manifestContent: Buffer;
  try {
    manifestContent = readFileSync(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const manifest = JSON.parse(
    manifestContent.toString("utf-8")
  ) as RagicDefinitionManifest;
  const manifestFingerprint = createHash("sha256")
    .update(manifestContent)
    .digest("hex");
  const publishedAt = statSync(manifestPath).mtime.toISOString();
  if (
    manifest.revision &&
    manifest.revisionAlgorithm &&
    manifest.artifactCount !== undefined
  ) {
    revisionHex(manifest.revision);
    if (manifest.revisionAlgorithm !== RAGIC_DEFINITIONS_REVISION_ALGORITHM) {
      throw new Error(
        `不支援的 definitions revision algorithm：${manifest.revisionAlgorithm}`
      );
    }
    return {
      manifestFingerprint,
      descriptor: {
        schemaVersion: RAGIC_DEFINITIONS_SNAPSHOT_SCHEMA_VERSION,
        revision: manifest.revision,
        revisionAlgorithm: manifest.revisionAlgorithm,
        artifactCount: manifest.artifactCount,
        counts: manifest.counts,
        namespaceFilter: manifest.namespaceFilter ?? null,
        publishedAt,
      },
    };
  }
  if (!existsSync(join(root, "forms"))) return null;
  return {
    manifestFingerprint,
    descriptor: snapshotDescriptorFromPayload(
      buildRagicDefinitionsSnapshotPayloadFromManifest(root, manifest),
      publishedAt
    ),
  };
}

function snapshotDataPath(snapshotRoot: string, revision: string): string {
  return join(snapshotRoot, `${revisionHex(revision)}${SNAPSHOT_DATA_SUFFIX}`);
}

function snapshotMetaPath(snapshotRoot: string, revision: string): string {
  return join(snapshotRoot, `${revisionHex(revision)}${SNAPSHOT_META_SUFFIX}`);
}

function writeFileAtomic(filePath: string, content: Buffer | string): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, content);
    try {
      renameSync(tempPath, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      rmSync(filePath, { force: true });
      renameSync(tempPath, filePath);
    }
  } finally {
    rmSync(tempPath, { force: true });
  }
}

async function writeFileAtomicAsync(
  filePath: string,
  content: Buffer | string
): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  try {
    await writeFileAsync(tempPath, content);
    try {
      await renameAsync(tempPath, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await rmAsync(filePath, { force: true });
      await renameAsync(tempPath, filePath);
    }
  } finally {
    await rmAsync(tempPath, { force: true });
  }
}

function metadataFromPayload(
  payload: RagicDefinitionsSnapshotPayload,
  json: Buffer,
  compressed: Buffer,
  materializedAt: string
): SnapshotMetadataFile {
  return {
    schemaVersion: RAGIC_DEFINITIONS_SNAPSHOT_SCHEMA_VERSION,
    revision: payload.revision,
    revisionAlgorithm: payload.revisionAlgorithm,
    artifactCount: payload.artifactCount,
    counts: payload.manifest.counts,
    namespaceFilter: payload.manifest.namespaceFilter ?? null,
    materializedAt,
    compressedBytes: compressed.length,
    artifactSha256: createHash("sha256").update(compressed).digest("hex"),
    payloadSha256: createHash("sha256").update(json).digest("hex"),
  };
}

function historyItemFromMetadata(
  metadata: SnapshotMetadataFile,
  publishedAt: string | null = null
): RagicDefinitionsSnapshotHistoryItem {
  return {
    schemaVersion: metadata.schemaVersion,
    revision: metadata.revision,
    revisionAlgorithm: metadata.revisionAlgorithm,
    artifactCount: metadata.artifactCount,
    counts: metadata.counts,
    namespaceFilter: metadata.namespaceFilter,
    publishedAt,
    materializedAt: metadata.materializedAt,
    compressedBytes: metadata.compressedBytes,
    artifactSha256: metadata.artifactSha256,
    payloadSha256: metadata.payloadSha256,
  };
}

function parseSnapshotMetadata(content: string): SnapshotMetadataFile {
  const value = JSON.parse(content) as SnapshotMetadataFile;
  revisionHex(value.revision);
  if (value.revisionAlgorithm !== RAGIC_DEFINITIONS_REVISION_ALGORITHM) {
    throw new Error(`不支援的 snapshot metadata algorithm：${value.revisionAlgorithm}`);
  }
  if (!/^[a-f0-9]{64}$/.test(value.artifactSha256)) {
    throw new Error("snapshot metadata artifactSha256 不合法");
  }
  if (!/^[a-f0-9]{64}$/.test(value.payloadSha256)) {
    throw new Error("snapshot metadata payloadSha256 不合法");
  }
  return value;
}

function readSnapshotMetadata(filePath: string): SnapshotMetadataFile {
  return parseSnapshotMetadata(readFileSync(filePath, "utf-8"));
}

async function sha256Async(content: Buffer): Promise<string> {
  const digest = await webcrypto.subtle.digest(
    "SHA-256",
    new Uint8Array(content)
  );
  return Buffer.from(digest).toString("hex");
}

function statFingerprint(current: Awaited<ReturnType<typeof statAsync>>): string {
  return [
    current.dev,
    current.ino,
    current.size,
    current.mtimeMs,
    current.ctimeMs,
  ].join(":");
}

async function snapshotFilesFingerprint(
  dataPath: string,
  metaPath: string
): Promise<string | null> {
  try {
    const [dataStat, metaStat] = await Promise.all([
      statAsync(dataPath),
      statAsync(metaPath),
    ]);
    return `${statFingerprint(dataStat)}|${statFingerprint(metaStat)}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function snapshotArtifactMatches(
  dataPath: string,
  metadata: SnapshotMetadataFile
): boolean {
  if (!existsSync(dataPath)) return false;
  try {
    const content = readFileSync(dataPath);
    if (
      content.length !== metadata.compressedBytes ||
      createHash("sha256").update(content).digest("hex") !==
        metadata.artifactSha256
    ) {
      return false;
    }
    return (
      createHash("sha256").update(gunzipSync(content)).digest("hex") ===
      metadata.payloadSha256
    );
  } catch {
    return false;
  }
}

function retainCountFromEnv(): number {
  const parsed = Number(process.env.RAGIC_DEFINITIONS_SNAPSHOT_RETAIN_COUNT);
  if (!Number.isFinite(parsed)) return DEFAULT_RETAIN_COUNT;
  return Math.max(1, Math.min(MAX_RETAIN_COUNT, Math.trunc(parsed)));
}

export function defaultRagicDefinitionsSnapshotRoot(
  definitionsRoot: string
): string {
  return join(resolve(definitionsRoot), ".snapshots");
}

export function createRagicDefinitionsSnapshotService(
  options: RagicDefinitionsSnapshotServiceOptions
) {
  const definitionsRoot = resolve(options.definitionsRoot);
  const snapshotRoot = resolve(
    options.snapshotRoot ?? defaultRagicDefinitionsSnapshotRoot(definitionsRoot)
  );
  const retainCount = Math.max(
    1,
    Math.min(MAX_RETAIN_COUNT, Math.trunc(options.retainCount ?? retainCountFromEnv()))
  );
  const verifiedCache = new Map<
    string,
    { fingerprint: string; value: LoadedRagicDefinitionsSnapshot }
  >();
  const verificationInFlight = new Map<
    string,
    Promise<LoadedRagicDefinitionsSnapshot | null>
  >();

  function listMetadata(): RagicDefinitionsSnapshotHistoryItem[] {
    if (!existsSync(snapshotRoot)) return [];
    const items: RagicDefinitionsSnapshotHistoryItem[] = [];
    for (const entry of readdirSync(snapshotRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(SNAPSHOT_META_SUFFIX)) continue;
      try {
        const metadata = readSnapshotMetadata(join(snapshotRoot, entry.name));
        const dataPath = snapshotDataPath(snapshotRoot, metadata.revision);
        if (
          !existsSync(dataPath) ||
          statSync(dataPath).size !== metadata.compressedBytes
        ) {
          continue;
        }
        items.push(historyItemFromMetadata(metadata));
      } catch {
        continue;
      }
    }
    return items.sort(
      (a, b) =>
        compareOrdinal(b.materializedAt, a.materializedAt) ||
        compareOrdinal(a.revision, b.revision)
    );
  }

  function list(): RagicDefinitionsSnapshotHistoryItem[] {
    if (!existsSync(snapshotRoot)) return [];
    const items: RagicDefinitionsSnapshotHistoryItem[] = [];
    for (const entry of readdirSync(snapshotRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(SNAPSHOT_META_SUFFIX)) continue;
      try {
        const metadata = readSnapshotMetadata(join(snapshotRoot, entry.name));
        const dataPath = snapshotDataPath(snapshotRoot, metadata.revision);
        if (!snapshotArtifactMatches(dataPath, metadata)) continue;
        items.push(historyItemFromMetadata(metadata));
      } catch {
        continue;
      }
    }
    return items.sort(
      (a, b) =>
        compareOrdinal(b.materializedAt, a.materializedAt) ||
        compareOrdinal(a.revision, b.revision)
    );
  }

  function describe(
    revision: string
  ): RagicDefinitionsSnapshotHistoryItem | null {
    revisionHex(revision);
    const metaPath = snapshotMetaPath(snapshotRoot, revision);
    const dataPath = snapshotDataPath(snapshotRoot, revision);
    if (!existsSync(metaPath) || !existsSync(dataPath)) return null;
    try {
      const metadata = readSnapshotMetadata(metaPath);
      if (
        metadata.revision !== revision ||
        statSync(dataPath).size !== metadata.compressedBytes
      ) {
        return null;
      }
      return historyItemFromMetadata(metadata);
    } catch {
      return null;
    }
  }

  function prune(protectedRevision: string): void {
    const items = listMetadata();
    const knownRevisions = new Set(items.map((item) => item.revision));
    const keep = new Set(
      items.slice(0, retainCount).map((item) => item.revision)
    );
    keep.add(protectedRevision);
    const activeRevision = readCurrentRagicDefinitionsSnapshotDescriptor(
      definitionsRoot
    )?.revision;
    if (activeRevision) keep.add(activeRevision);
    for (const item of items) {
      if (keep.has(item.revision)) continue;
      verifiedCache.delete(item.revision);
      rmSync(snapshotDataPath(snapshotRoot, item.revision), { force: true });
      rmSync(snapshotMetaPath(snapshotRoot, item.revision), { force: true });
    }
    if (!existsSync(snapshotRoot)) return;
    const orphanRevisions = new Set<string>();
    for (const entry of readdirSync(snapshotRoot, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = /^([a-f0-9]{64})\.(?:json\.gz|meta\.json)$/.exec(entry.name);
      if (match) orphanRevisions.add(`sha256:${match[1]}`);
    }
    const now = Date.now();
    for (const revision of orphanRevisions) {
      if (
        revision === protectedRevision ||
        knownRevisions.has(revision)
      ) {
        continue;
      }
      const paths = [
        snapshotDataPath(snapshotRoot, revision),
        snapshotMetaPath(snapshotRoot, revision),
      ];
      const mtimes = paths.flatMap((filePath) => {
        try {
          return [statSync(filePath).mtimeMs];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      });
      if (
        mtimes.length === 0 ||
        now - Math.max(...mtimes) < ORPHAN_GRACE_MS
      ) {
        continue;
      }
      verifiedCache.delete(revision);
      rmSync(paths[0], { force: true });
      rmSync(paths[1], { force: true });
    }
  }

  async function loadVerifiedInternal(
    revision: string
  ): Promise<LoadedRagicDefinitionsSnapshot | null> {
    revisionHex(revision);
    const metaPath = snapshotMetaPath(snapshotRoot, revision);
    const dataPath = snapshotDataPath(snapshotRoot, revision);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fingerprint = await snapshotFilesFingerprint(dataPath, metaPath);
      if (!fingerprint) {
        verifiedCache.delete(revision);
        return null;
      }
      const cached = verifiedCache.get(revision);
      if (cached?.fingerprint === fingerprint) return cached.value;
      try {
        const [metadataText, content] = await Promise.all([
          readFileAsync(metaPath, "utf-8"),
          readFileAsync(dataPath),
        ]);
        const metadata = parseSnapshotMetadata(metadataText);
        if (
          metadata.revision !== revision ||
          content.length !== metadata.compressedBytes ||
          (await sha256Async(content)) !== metadata.artifactSha256
        ) {
          verifiedCache.delete(revision);
          return null;
        }
        const payload = await gunzipAsync(content);
        if ((await sha256Async(payload)) !== metadata.payloadSha256) {
          verifiedCache.delete(revision);
          return null;
        }
        const confirmedFingerprint = await snapshotFilesFingerprint(
          dataPath,
          metaPath
        );
        if (confirmedFingerprint !== fingerprint) continue;
        const value = {
          descriptor: historyItemFromMetadata(metadata),
          content,
        };
        verifiedCache.set(revision, { fingerprint, value });
        return value;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" && attempt === 0) continue;
        verifiedCache.delete(revision);
        return null;
      }
    }
    verifiedCache.delete(revision);
    return null;
  }

  function loadVerified(
    revision: string
  ): Promise<LoadedRagicDefinitionsSnapshot | null> {
    revisionHex(revision);
    const existing = verificationInFlight.get(revision);
    if (existing) return existing;
    const tracked = loadVerifiedInternal(revision).finally(() => {
      if (verificationInFlight.get(revision) === tracked) {
        verificationInFlight.delete(revision);
      }
    });
    verificationInFlight.set(revision, tracked);
    return tracked;
  }

  async function listVerified(): Promise<RagicDefinitionsSnapshotHistoryItem[]> {
    let entries;
    try {
      entries = await readdirAsync(snapshotRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const items: RagicDefinitionsSnapshotHistoryItem[] = [];
    for (const entry of entries) {
      const match = /^([a-f0-9]{64})\.meta\.json$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const loaded = await loadVerified(`sha256:${match[1]}`);
      if (loaded) items.push(loaded.descriptor);
    }
    return items.sort(
      (a, b) =>
        compareOrdinal(b.materializedAt, a.materializedAt) ||
        compareOrdinal(a.revision, b.revision)
    );
  }

  function preparePayload(
    payload: RagicDefinitionsSnapshotPayload,
    options: { publishedAt?: string | null } = {}
  ): PreparedRagicDefinitionsSnapshot {
    mkdirSync(snapshotRoot, { recursive: true });
    const dataPath = snapshotDataPath(snapshotRoot, payload.revision);
    const metaPath = snapshotMetaPath(snapshotRoot, payload.revision);
    let metadata: SnapshotMetadataFile | null = null;
    const json = Buffer.from(`${JSON.stringify(payload)}\n`, "utf-8");
    const payloadSha256 = createHash("sha256").update(json).digest("hex");

    if (existsSync(dataPath) && existsSync(metaPath)) {
      try {
        const existing = readSnapshotMetadata(metaPath);
        if (
          existing.revision === payload.revision &&
          existing.payloadSha256 === payloadSha256 &&
          snapshotArtifactMatches(dataPath, existing)
        ) {
          metadata = existing;
        }
      } catch {
        metadata = null;
      }
    }

    if (!metadata) {
      const compressed = gzipSync(json, { level: 9 });
      const materializedAt = new Date().toISOString();
      metadata = metadataFromPayload(payload, json, compressed, materializedAt);
      verifiedCache.delete(payload.revision);
      writeFileAtomic(dataPath, compressed);
    }

    const preparedDescriptor = historyItemFromMetadata(
      metadata,
      options.publishedAt ?? null
    );
    return {
      descriptor: preparedDescriptor,
      filePath: dataPath,
      publish(publishOptions = {}) {
        verifiedCache.delete(payload.revision);
        writeFileAtomic(metaPath, `${JSON.stringify(metadata, null, 2)}\n`);
        if (publishOptions.pruneAfter !== false) {
          prune(payload.revision);
        }
        return {
          descriptor: preparedDescriptor,
          filePath: dataPath,
        };
      },
    };
  }

  function materializePayload(
    payload: RagicDefinitionsSnapshotPayload,
    options: { publishedAt?: string | null; pruneAfter?: boolean } = {}
  ): MaterializedRagicDefinitionsSnapshot {
    return preparePayload(payload, {
      publishedAt: options.publishedAt,
    }).publish({ pruneAfter: options.pruneAfter });
  }

  function materializeCurrent(options: { pruneAfter?: boolean } = {}) {
    const payload = buildRagicDefinitionsSnapshotPayload(definitionsRoot);
    const manifestPath = join(definitionsRoot, "manifest.json");
    const publishedAt = existsSync(manifestPath)
      ? statSync(manifestPath).mtime.toISOString()
      : null;
    return materializePayload(payload, {
      publishedAt,
      pruneAfter: options.pruneAfter,
    });
  }

  async function materializeCurrentAsync(): Promise<LoadedRagicDefinitionsSnapshot> {
    const payload = await buildRagicDefinitionsSnapshotPayloadAsync(
      definitionsRoot
    );
    const existing = await loadVerified(payload.revision);
    if (existing) return existing;

    await mkdirAsync(snapshotRoot, { recursive: true });
    const dataPath = snapshotDataPath(snapshotRoot, payload.revision);
    const metaPath = snapshotMetaPath(snapshotRoot, payload.revision);
    const json = Buffer.from(`${JSON.stringify(payload)}\n`, "utf-8");
    const compressed = await gzipAsync(json, { level: 9 });
    const materializedAt = new Date().toISOString();
    const metadata: SnapshotMetadataFile = {
      schemaVersion: RAGIC_DEFINITIONS_SNAPSHOT_SCHEMA_VERSION,
      revision: payload.revision,
      revisionAlgorithm: payload.revisionAlgorithm,
      artifactCount: payload.artifactCount,
      counts: payload.manifest.counts,
      namespaceFilter: payload.manifest.namespaceFilter ?? null,
      materializedAt,
      compressedBytes: compressed.length,
      artifactSha256: await sha256Async(compressed),
      payloadSha256: await sha256Async(json),
    };
    verifiedCache.delete(payload.revision);
    await writeFileAtomicAsync(dataPath, compressed);
    await writeFileAtomicAsync(
      metaPath,
      `${JSON.stringify(metadata, null, 2)}\n`
    );
    const loaded = await loadVerified(payload.revision);
    if (!loaded) {
      throw new Error("RAGIC_DEFINITIONS_SNAPSHOT_MATERIALIZE_VERIFY_FAILED");
    }
    return loaded;
  }

  function open(revision: string): MaterializedRagicDefinitionsSnapshot | null {
    revisionHex(revision);
    const metaPath = snapshotMetaPath(snapshotRoot, revision);
    const dataPath = snapshotDataPath(snapshotRoot, revision);
    if (!existsSync(metaPath) || !existsSync(dataPath)) return null;
    try {
      const metadata = readSnapshotMetadata(metaPath);
      if (
        metadata.revision !== revision ||
        !snapshotArtifactMatches(dataPath, metadata)
      ) {
        return null;
      }
      return {
        descriptor: historyItemFromMetadata(metadata),
        filePath: dataPath,
      };
    } catch {
      return null;
    }
  }

  return {
    definitionsRoot,
    snapshotRoot,
    retainCount,
    list,
    describe,
    listVerified,
    prune,
    preparePayload,
    materializePayload,
    materializeCurrent,
    materializeCurrentAsync,
    open,
    loadVerified,
  };
}

export type RagicDefinitionsSnapshotService = ReturnType<
  typeof createRagicDefinitionsSnapshotService
>;
