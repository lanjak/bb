// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import type { PluginThreadActionTarget } from "@get-bb/plugin-sdk";
import { makeThread } from "@bb/test-helpers/domain-fixtures";
import { describe, expect, it, vi } from "vitest";
import { threadQueryKey } from "@/hooks/queries/query-keys";
import { CORE_THREAD_ACTIONS } from "./core-thread-actions";

const moveAction = CORE_THREAD_ACTIONS.find((action) => action.id === "move");

function moveItem(
  providerId: string,
  status: PluginThreadActionTarget["status"],
) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    threadQueryKey("thr_test"),
    makeThread({ providerId }),
  );
  const target: PluginThreadActionTarget = {
    id: "thr_test",
    projectId: "proj_test",
    parentThreadId: null,
    parentNotifications: "auto",
    archivedAt: null,
    pinnedAt: null,
    sectionId: null,
    isUnread: false,
    status,
    environment: null,
  };
  const requestMove = vi.fn();
  const item = moveAction?.item?.({
    thread: target,
    data: { queryClient, requestMove },
  } as never);
  return { item, requestMove };
}

describe("move thread action", () => {
  it("is offered for claude-code and codex threads", () => {
    expect(moveItem("claude-code", "idle").item?.disabled).toBe(false);
    expect(moveItem("codex", "idle").item?.label).toBe(
      "Move to another machine...",
    );
  });

  it("is hidden for other providers", () => {
    expect(moveItem("opencode", "idle").item).toBeNull();
  });

  it("is disabled with a reason while the thread is not idle", () => {
    const { item } = moveItem("claude-code", "active");
    expect(item?.disabled).toBe(true);
    expect(item?.detail).toBe("Available when the thread is idle");
  });
});
