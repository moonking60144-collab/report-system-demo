import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { activityLogPivotAnalysisExportService } from "../../src/services/activityLog/activityLogPivotAnalysisExportService";
import { createRagicDefinitionsReadService } from "../../src/services/dev/ragicDefinitionsReadService";

test("Docker runtime COPY 對應的獨立目錄可載入 XLSX 範本與表單定義", async () => {
  const backend = process.cwd();
  const dockerfile = await readFile(resolve(backend, "../Dockerfile"), "utf8");
  assert.match(dockerfile, /COPY --from=backend-builder \/app\/backend\/templates \.\/templates/);
  assert.match(dockerfile, /COPY ragic-definitions\/ \/app\/ragic-definitions\//);
  const app = await mkdtemp(join(tmpdir(), "runtime-assets-"));
  const runtime = join(app, "backend"); await mkdir(runtime);
  await cp(resolve(backend, "templates"), join(runtime, "templates"), { recursive: true });
  await cp(resolve(backend, "../ragic-definitions"), join(app, "ragic-definitions"), { recursive: true });
  try {
    process.chdir(runtime);
    const template = await activityLogPivotAnalysisExportService.loadTemplateBundle();
    assert.equal(template.body.subarray(0, 2).toString(), "PK");
    const definitions = createRagicDefinitionsReadService({ definitionsRoot: join(app, "ragic-definitions"), repoRoot: app });
    const forms = await definitions.listForms();
    assert.ok(forms.data.length > 0, "DEPLOYED_DEFINITIONS_REQUIRED");
  } finally { process.chdir(backend); }
});
