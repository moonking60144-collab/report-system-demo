/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Table } from "antd";
import "antd/dist/reset.css";
import "../../src/index.css";
import "../../src/App.css";
import "../../src/i18n";
import type { WorkReportRecord } from "../../src/api/workReport";
import { WorkReportSortOrderCell } from "../../src/features/work-report/components/WorkReportSortOrderCell";
import { SystemNoticePanelHeader } from "../../src/features/work-report/components/system-notice/SystemNoticePanelHeader";
import { useSqliteAutoSyncStatus } from "../../src/features/work-report/hooks/useSqliteAutoSyncStatus";

function Fixture() {
  const [records, setRecords] = useState<WorkReportRecord[]>([]);
  const [syncing, setSyncing] = useState<string | null>(null);
  const autoSyncForms = useSqliteAutoSyncStatus();
  useEffect(() => { void fetch("/api/fixture-records").then(r => r.json()).then(setRecords); }, []);
  return <main style={{ padding: 24 }}>
    <SystemNoticePanelHeader autoSyncForms={autoSyncForms} noticeExists activeState={false}
      shouldShowHeaderActions={false} showDismissButton={false} dismissButtonText="" editing={false}
      inlineStatusMessage="目前畫面資料時間：09/11 16:56:56。" inlineStatusType="success"
      isInlineStatusSpinning={false} onDismissToggle={() => {}} onEditToggle={() => {}} />
    <div style={{ height: 250 }} />
    <Table<WorkReportRecord> className="ragic-table" rowKey="id" pagination={false}
      scroll={{ x: 900 }} dataSource={records} columns={[
        { title: "工令單號", dataIndex: "workOrderNo" },
        { title: "排序", render: (_, record) => <WorkReportSortOrderCell
          record={record} value={record.sortOrder} displayValue={record.sortOrder}
          syncing={syncing === String(record.id)} onSubmit={async () => {
            setSyncing(String(record.id));
            const next = await fetch("/api/fixture-records", { method: "PUT" }).then(r => r.json());
            setRecords(next);
            setSyncing(null);
          }} /> },
      ]} />
    <p>顯示 1–23 · 第 1 頁</p>
  </main>;
}

export function mountSortSettlementFixture(root: HTMLElement) {
  createRoot(root).render(<Fixture />);
}
