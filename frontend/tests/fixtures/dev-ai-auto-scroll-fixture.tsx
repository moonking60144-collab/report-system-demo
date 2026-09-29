/* eslint-disable react-refresh/only-export-components */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useDevAiAutoScroll } from "../../src/features/dev/utils/useDevAiAutoScroll";

function ConversationFixture() {
  const [threadId, setThreadId] = useState("first");
  const [messageCount, setMessageCount] = useState(30);
  const autoScroll = useDevAiAutoScroll(threadId, messageCount, 0);

  return <>
    <button type="button" onClick={() => setMessageCount(value => value + 1)}>新增訊息</button>
    <button type="button" onClick={() => setThreadId("second")}>切換對話</button>
    <div {...autoScroll} data-testid="conversation" style={{ height: 120, overflowY: "auto" }}>
      {Array.from({ length: messageCount }, (_, index) =>
        <div key={`${threadId}-${index}`} style={{ height: 28 }}>{threadId}：{index}</div>
      )}
    </div>
  </>;
}

export function mountDevAiAutoScrollFixture(root: HTMLElement): void {
  createRoot(root).render(<ConversationFixture />);
}
