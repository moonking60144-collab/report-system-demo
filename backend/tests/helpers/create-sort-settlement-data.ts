import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../../src/config/env";
import { sqliteClient } from "../../src/storage/sqlite/sqliteClient";
import { READ_MODEL_SCHEMA_VERSION } from "../../src/storage/sqlite/readModelSchema";
import { workReportSqliteRepository as repository } from "../../src/storage/sqlite/workReportSqliteRepository";

async function main() {
  const root = await mkdtemp(join(tmpdir(), "scroll-settlement-"));
  Object.assign(env, { SQLITE_ENABLED: true, SQLITE_DB_FILE: join(root, "test.sqlite3") });
  try {
    const records = Array.from({ length: 23 }, (_, i) => ({
      id: String(i), workOrderNo: `WO-test-${i}`, sortOrder: i + 1, status: "未結案", reports: [],
    }));
    await repository.replaceFormSnapshot("901", records, "fixture");
    await repository.upsertSyncState({
      formId: "901", status: "success", snapshotAt: "fixture", activeGenerationId: "fixture",
      readModelVersion: READ_MODEL_SCHEMA_VERSION, totalEntries: 23, totalRows: 0,
    });
    const before = (await repository.getReports("901", { limit: 25, offset: 0 })).data;
    await repository.upsertEntrySnapshot("901", { ...records[10]!, sortOrder: 6 }, "updated");
    const after = (await repository.getReports("901", { limit: 25, offset: 0 })).data;
    console.log(`FIXTURE:${JSON.stringify({ before, after })}`);
  } finally {
    await sqliteClient.close();
    await rm(root, { recursive: true, force: true });
  }
}
void main();
