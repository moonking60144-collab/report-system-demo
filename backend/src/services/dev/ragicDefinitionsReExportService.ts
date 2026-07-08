import {
  exportRagicDefinitions,
  type RagicDefinitionsExportResult,
} from "./ragicDefinitionsExportService";
import {
  ragicDefinitionsReadService,
  type RagicDefinitionManifest,
  type RagicDefinitionsReadService,
  type RagicDefinitionsState,
} from "./ragicDefinitionsReadService";
import {
  createRagicDefinitionsVersionControlService,
  type RagicDefinitionsVersionControlService,
  type RagicDefinitionsVersionControlStatus,
} from "./ragicDefinitionsVersionControlService";
import { withDefinitionsWriteLock } from "./ragicDefinitionsIoLock";

export interface RagicDefinitionsReExportResult {
  exported: boolean;
  message: string;
  summary: RagicDefinitionsExportResult;
  state: RagicDefinitionsState;
  versionStatus: RagicDefinitionsVersionControlStatus;
}

export interface RagicDefinitionsReExportServiceOptions {
  definitionsService?: RagicDefinitionsReadService;
  versionControlService?: RagicDefinitionsVersionControlService;
  builderRoot?: string;
  exportDefinitions?: (params: {
    builderRoot: string;
    definitionsRoot: string;
    namespaces: string;
  }) => RagicDefinitionsExportResult | Promise<RagicDefinitionsExportResult>;
}

function namespacesFromManifest(manifest: RagicDefinitionManifest | null): string {
  if (!manifest?.namespaceFilter) return process.env.RAGIC_DEFINITION_NAMESPACES || "default";
  if (manifest.namespaceFilter.mode === "all") return "*";
  const namespaces = manifest.namespaceFilter.namespaces?.filter(Boolean) ?? [];
  return namespaces.length
    ? namespaces.join(",")
    : process.env.RAGIC_DEFINITION_NAMESPACES || "default";
}

function hasDefinitionsDiff(status: RagicDefinitionsVersionControlStatus): boolean {
  return status.definitionsEntries.length > 0 || (status.gitAvailable && !status.definitionsClean);
}

async function defaultExportDefinitions({
  builderRoot,
  definitionsRoot,
  namespaces,
}: {
  builderRoot: string;
  definitionsRoot: string;
  namespaces: string;
}): Promise<RagicDefinitionsExportResult> {
  return exportRagicDefinitions({
    builderRoot,
    outDir: definitionsRoot,
    namespaces,
    ragicNuiEncoding: process.env.RAGIC_NUI_ENCODING,
  });
}

export function createRagicDefinitionsReExportService(
  options: RagicDefinitionsReExportServiceOptions = {}
) {
  const definitionsService = options.definitionsService ?? ragicDefinitionsReadService;
  const versionControlService =
    options.versionControlService ?? createRagicDefinitionsVersionControlService();
  const builderRoot = options.builderRoot ?? process.env.RAGIC_BUILDER_PATH ?? "";
  const exportDefinitions = options.exportDefinitions ?? defaultExportDefinitions;

  async function reExport(): Promise<RagicDefinitionsReExportResult> {
    const before = await definitionsService.getState();
    const summary = await withDefinitionsWriteLock(async () => {
      const exported = await Promise.resolve(
        exportDefinitions({
          builderRoot,
          definitionsRoot: before.definitionsRoot,
          namespaces: namespacesFromManifest(before.manifest),
        })
      );
      definitionsService.invalidateCache();
      return exported;
    });

    const [state, versionStatus] = await Promise.all([
      definitionsService.getState(),
      versionControlService.getStatus(),
    ]);
    const message = hasDefinitionsDiff(versionStatus)
      ? "已同步 Ragic 現況，definitions 有差異"
      : "已同步，baseline 無差異";

    return {
      exported: true,
      message,
      summary,
      state,
      versionStatus,
    };
  }

  return {
    reExport,
  };
}

export type RagicDefinitionsReExportService = ReturnType<
  typeof createRagicDefinitionsReExportService
>;

export const ragicDefinitionsReExportService = createRagicDefinitionsReExportService();
