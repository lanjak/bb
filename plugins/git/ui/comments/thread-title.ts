import { useEffect, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";

const titles = new Map<string, string | null>();

export function useThreadTitle(threadId: string | null): string | null {
  const sdk = useSdk();
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (threadId === null || titles.has(threadId)) return;
    let cancelled = false;
    sdk.threads.get({ threadId }).then(
      (thread) => {
        titles.set(threadId, thread.title);
        if (!cancelled) setVersion((version) => version + 1);
      },
      () => {
        titles.set(threadId, null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sdk, threadId]);
  return threadId === null ? null : (titles.get(threadId) ?? null);
}
