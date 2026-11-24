import { useEffect } from "react";
import { toast } from "sonner";
import { useBbNavigate, type ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import type { MachineView, UsageStatus } from "../../contract.js";
import { plain } from "../format.js";
import { useMachines } from "./hooks.js";

export const PANEL_PATH = "resources";
const RANK: Record<UsageStatus, number> = { ok: 0, warning: 1, critical: 2 };

function compactText(machine: MachineView): string {
  if (machine.memory !== null && machine.memory.status !== "ok")
    return `RAM ${Math.round(machine.memory.percent)}%`;
  const disk = machine.disks.find((candidate) => candidate.status !== "ok");
  if (disk !== undefined) return `Disk ${Math.round(disk.freePercent)}%`;
  return "CPU";
}

export function badgeFor(
  machines: readonly MachineView[],
): ExperimentalBadge | null {
  let worst: MachineView | null = null;
  for (const machine of machines)
    if (
      machine.online &&
      machine.status !== "ok" &&
      (worst === null || RANK[machine.status] > RANK[worst.status])
    )
      worst = machine;
  if (worst === null) return null;
  return {
    text: compactText(worst),
    tone: worst.status === "critical" ? "critical" : "warning",
    label: `${plain(worst.name)}: ${worst.reasons.join(", ")}`,
  };
}

export interface Crossing {
  hostId: string;
  status: UsageStatus;
  text: string;
}

export interface ToastMemory {
  seeded: boolean;
  seen: Map<string, UsageStatus>;
}

export function newToastMemory(): ToastMemory {
  return { seeded: false, seen: new Map() };
}

export function crossings(
  memory: ToastMemory,
  machines: readonly MachineView[],
): Crossing[] {
  const found: Crossing[] = [];
  for (const machine of machines) {
    const before = memory.seen.get(machine.hostId) ?? "ok";
    const now: UsageStatus = machine.online ? machine.status : "ok";
    memory.seen.set(machine.hostId, now);
    if (memory.seeded && RANK[now] > RANK[before])
      found.push({
        hostId: machine.hostId,
        status: now,
        text: `${plain(machine.name)}: ${machine.reasons.join(", ")}`,
      });
  }
  memory.seeded = true;
  return found;
}

const sessionMemory = newToastMemory();

export function useResourcesBadge(): ExperimentalBadge | null {
  const query = useMachines();
  const navigate = useBbNavigate();
  const machines = query.data?.machines;
  const toasts = query.data?.toasts ?? false;
  useEffect(() => {
    if (machines === undefined) return;
    for (const crossing of crossings(sessionMemory, machines)) {
      if (!toasts) continue;
      const show = crossing.status === "critical" ? toast.error : toast.warning;
      show(crossing.text, {
        id: `resources-${crossing.hostId}-${crossing.status}`,
        action: {
          label: "Open",
          onClick: () => navigate.toPluginPanel(PANEL_PATH),
        },
      });
    }
  }, [machines, toasts, navigate]);
  return machines === undefined || !toasts ? null : badgeFor(machines);
}
