import { useLayoutEffect, useRef } from "react";

export function useDevAiAutoScroll(
  threadId: string | undefined,
  detailRevision: unknown,
  activityRevision: unknown
) {
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const previousThread = useRef(threadId);
  const onScroll = () => {
    const element = ref.current;
    if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
  };

  useLayoutEffect(() => {
    if (previousThread.current !== threadId) {
      previousThread.current = threadId;
      following.current = true;
    }
    const element = ref.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [activityRevision, detailRevision, threadId]);

  return { ref, onScroll };
}
