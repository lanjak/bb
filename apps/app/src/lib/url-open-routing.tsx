import { parseApplicationUrl } from "@bb/domain/application-url";
import { openApplicationUrl } from "./application-url";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { getBbDesktopInfo, isDesktopBrowserAvailable } from "@/lib/bb-desktop";
import { shellOpenExternal } from "@/lib/native-shell";
import {
  openUrlByPreference,
  useOpenLinksInAppBrowserPreference,
} from "@/lib/in-app-browser-link-preference";
import {
  AppNavigationHostProvider,
  type AppHostPortOpenIntent,
} from "@/lib/app-navigation-host";
import { useStore } from "jotai";
import { sdk } from "@/lib/sdk";
import { resolveHostPort, type HostPortOpenResult } from "@/lib/host-port-open";
import { readLocalHostId } from "@/lib/local-host-id";

type OpenInAppBrowserUrl = (url: string) => void;

interface UrlOpenRoutingProviderProps {
  children: ReactNode;
  openInAppBrowser: OpenInAppBrowserUrl | null;
}

type UrlAnchorClickHandler = (
  event: ReactMouseEvent<HTMLAnchorElement>,
) => void;

const InAppBrowserUrlOpenContext = createContext<OpenInAppBrowserUrl | null>(
  null,
);

export function openUrlInExternalBrowser(url: string): void {
  if (parseApplicationUrl(url) !== null) {
    openApplicationUrl(url);
    return;
  }
  const desktopInfo = getBbDesktopInfo();
  if (desktopInfo !== null) {
    desktopInfo.openExternalUrl(url);
    return;
  }
  if (shellOpenExternal(url)) return;
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function UrlOpenRoutingProvider({
  children,
  openInAppBrowser,
}: UrlOpenRoutingProviderProps) {
  return (
    <InAppBrowserUrlOpenContext.Provider value={openInAppBrowser}>
      <AppNavigationUrlHost>{children}</AppNavigationUrlHost>
    </InAppBrowserUrlOpenContext.Provider>
  );
}

export function AppNavigationUrlHost({ children }: { children: ReactNode }) {
  const openUrl = useOpenUrlByPreference();
  const openHostPort = useOpenHostPort(openUrl);
  const capabilities = useMemo(
    () => ({
      openUrl: ({ url }: { url: string }) => openUrl(url),
      openHostPort,
    }),
    [openUrl, openHostPort],
  );
  return (
    <AppNavigationHostProvider capabilities={capabilities}>
      {children}
    </AppNavigationHostProvider>
  );
}

function useOpenHostPort(
  openUrl: (url: string) => boolean,
): (intent: AppHostPortOpenIntent) => Promise<HostPortOpenResult> {
  const store = useStore();
  return useCallback(
    async (intent) => {
      const localHostId = await readLocalHostId(store);
      const result = await resolveHostPort(
        {
          localHostId,
          desktopHostPorts: getBbDesktopInfo()?.hostPorts ?? null,
          relayUrl: ({ hostId, port }) =>
            sdk.hosts.experimental_portRelayUrl({ hostId, port }),
        },
        intent,
      );
      if (result.via === "unreachable") return result;
      if (intent.target === "external") openUrlInExternalBrowser(result.url);
      else openUrl(result.url);
      return result;
    },
    [store, openUrl],
  );
}

function useOpenUrlByPreference(): (url: string) => boolean {
  const openInAppBrowser = useContext(InAppBrowserUrlOpenContext);
  const [openLinksInAppBrowser] = useOpenLinksInAppBrowserPreference();
  const desktopBrowserAvailable =
    openInAppBrowser !== null && isDesktopBrowserAvailable();

  return useCallback(
    (url: string) => {
      return openUrlByPreference({
        desktopBrowserAvailable,
        openExternalBrowser: openUrlInExternalBrowser,
        openInAppBrowser: openInAppBrowser ?? openUrlInExternalBrowser,
        openLinksInAppBrowser,
        url,
      });
    },
    [desktopBrowserAvailable, openInAppBrowser, openLinksInAppBrowser],
  );
}

export function useUrlAnchorClickHandler(
  url: string | undefined,
): UrlAnchorClickHandler {
  const openUrl = useOpenUrlByPreference();

  return useCallback(
    (event) => {
      if (event.defaultPrevented || event.button !== 0 || url === undefined) {
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      if (openUrl(url)) {
        event.preventDefault();
      }
    },
    [openUrl, url],
  );
}
