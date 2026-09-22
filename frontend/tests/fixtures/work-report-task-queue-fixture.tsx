/* eslint-disable react-refresh/only-export-components */
import { StrictMode, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ConfigProvider } from "antd";
import zhTW from "antd/locale/zh_TW";
import "antd/dist/reset.css";
import "../../src/index.css";
import "../../src/App.css";
import "../../src/i18n";
import "../../src/features/work-report/styles/task-queue.css";
import { WorkReportTaskQueueDrawer } from "../../src/features/work-report/components/WorkReportTaskQueueDrawer";
import { useTaskQueueQuery } from "../../src/features/work-report/hooks/useTaskQueueQuery";

function DeferredRefreshFixture() {
  const [open, setOpen] = useState(true);
  const [mine, setMine] = useState(true);
  const query = useMemo(() => mine ? { actorClientId: "mine", limit: 50 } : { limit: 50 }, [mine]);
  const { tasks, loadTasks } = useTaskQueueQuery({ open, formId: "901", query });
  const deferred = useRef<(() => Promise<void>) | null>(null);
  return <>
    <button onClick={() => { deferred.current = loadTasks; }}>保留更新回呼</button>
    <button onClick={() => setMine(false)}>切換全部</button>
    <button onClick={() => setOpen(false)}>關閉查詢</button>
    <button onClick={() => void deferred.current?.()}>完成延遲操作</button>
    <div role="status">{tasks.map((task) => task.taskId).join(",")}</div>
  </>;
}

function TaskQueueFixture() {
  const [open, setOpen] = useState(false);
  const [formId, setFormId] = useState("901");
  return (
    <MemoryRouter>
      <button onClick={() => setOpen(true)}>開啟任務中心</button>
      <button onClick={() => setFormId((current) => current === "901" ? "902" : "901")}>
        切換表單
      </button>
      <WorkReportTaskQueueDrawer
        open={open}
        context="list"
        formId={formId}
        entryId={null}
        onClose={() => setOpen(false)}
      />
    </MemoryRouter>
  );
}

export function mountTaskQueueFixture(element: HTMLElement) {
  createRoot(element).render(<StrictMode><ConfigProvider locale={zhTW}>
    {window.location.search.includes("deferred") ? <DeferredRefreshFixture /> : <TaskQueueFixture />}
  </ConfigProvider></StrictMode>);
}
