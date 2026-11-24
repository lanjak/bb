import type { BbDesktopHostPortForward } from "@bb/desktop-contract";
import { PortForwardsList } from "./PortForwardsSettings";
import { StoryCard } from "../../../.ladle/story-card";

export default {
  title: "settings/Port forwards",
};

const origin = "http://127.0.0.1:38886";

const forwards: BbDesktopHostPortForward[] = [
  {
    hostId: "host_build",
    port: 5173,
    localPort: 54321,
    connections: 2,
    serverOrigin: origin,
  },
  {
    hostId: "host_build",
    port: 5432,
    localPort: 5432,
    connections: 0,
    serverOrigin: origin,
  },
  {
    hostId: "host_sandbox",
    port: 48231,
    localPort: 48231,
    connections: 1,
    serverOrigin: origin,
  },
];

const names: Record<string, string> = {
  host_build: "build-box",
  host_sandbox: "Modal sandbox 3f9a",
};

export const Forwards = () => (
  <StoryCard>
    <PortForwardsList
      forwards={forwards}
      machineName={(hostId) => names[hostId] ?? hostId}
      onStop={() => {}}
    />
  </StoryCard>
);
