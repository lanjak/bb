import { useCallback, useEffect, useRef } from "react";
import { useStore } from "jotai";
import { appToast } from "@/components/ui/app-toast";
import type { ResolvedAppNavigationHostCapabilities } from "@/lib/app-navigation-host";
import { parseLoopbackUrl } from "@/lib/host-port-open";
import { readLocalHostId } from "@/lib/local-host-id";

export function openLoopbackLink(
  navigation: Pick<ResolvedAppNavigationHostCapabilities, "openHostPort">,
  hostId: string,
  href: string,
): boolean {
  const target = parseLoopbackUrl(href);
  if (target === null) return false;
  void navigation.openHostPort({ hostId, ...target }).then((result) => {
    if (result.via === "unreachable") appToast.error(result.reason);
  });
  return true;
}

export function useIsThisDevice(hostId: string): () => boolean {
  const store = useStore();
  const localHostId = useRef<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void readLocalHostId(store)
      .then((id) => {
        if (!controller.signal.aborted) localHostId.current = id;
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [store, hostId]);
  return useCallback(() => localHostId.current === hostId, [hostId]);
}
