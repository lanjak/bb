import type { useStore } from "jotai";

export async function readLocalHostId(
  store: ReturnType<typeof useStore>,
): Promise<string | null> {
  const { localHostIdAtom } = await import("@/lib/system-config-atoms");
  return store.get(localHostIdAtom);
}
