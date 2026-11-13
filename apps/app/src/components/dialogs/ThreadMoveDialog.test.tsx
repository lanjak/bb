// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  makeEnvironment,
  makeHost,
  makeThread,
} from "@bb/test-helpers/domain-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { ThreadMoveDialog } from "./ThreadMoveDialog";

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { experimental_move: vi.fn() } },
}));

const environments = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock("@/hooks/queries/environment-queries", () => ({
  useEnvironment: () => ({
    data: { hostId: "host_a" },
    isPending: false,
  }),
  useProjectEnvironments: () => ({
    data: environments.list,
    isPending: false,
  }),
}));

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({
    data: [
      makeHost({ id: "host_a", name: "Alpha" }),
      makeHost({ id: "host_b", name: "Bravo" }),
      makeHost({ id: "host_c", name: "Charlie" }),
    ],
    isPending: false,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog() {
  environments.list = [
    makeEnvironment({
      id: "env_local",
      hostId: "host_a",
      path: "/alpha/repo",
    }),
    makeEnvironment({
      id: "env_b",
      hostId: "host_b",
      path: "/bravo/repo",
      branchName: "feature/b",
    }),
    makeEnvironment({
      id: "env_c_error",
      hostId: "host_c",
      path: "/charlie/repo",
      status: "error",
    }),
  ];
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ThreadMoveDialog
        thread={makeThread({ environmentId: "env_local" })}
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe("ThreadMoveDialog", () => {
  it("lists only ready environments on other machines", () => {
    renderDialog();

    expect(screen.getByText("Bravo")).toBeTruthy();
    expect(screen.getByText("/bravo/repo")).toBeTruthy();
    expect(screen.getByText("feature/b")).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.queryByText("Charlie")).toBeNull();
  });

  it("keeps Move disabled until an environment is selected", () => {
    renderDialog();

    expect(
      (screen.getByRole("button", { name: "Move" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("moves the thread to the selected environment and closes", async () => {
    vi.mocked(sdk.threads.experimental_move).mockResolvedValue({
      moveId: "move_1",
      threadId: "thr_test",
      phase: "done",
      sourceEnvironmentId: "env_local",
      targetEnvironmentId: "env_b",
      error: null,
    });
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("radio"));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(sdk.threads.experimental_move).toHaveBeenCalledWith({
      threadId: "thr_test",
      environmentId: "env_b",
    });
  });

  it("shows progress while the move runs", async () => {
    vi.mocked(sdk.threads.experimental_move).mockReturnValue(
      new Promise(() => undefined),
    );
    renderDialog();

    fireEvent.click(screen.getByRole("radio"));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await screen.findByText(/Moving thread/);
    expect(
      (screen.getByRole("button", { name: "Move" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows the server refusal verbatim and stays open", async () => {
    vi.mocked(sdk.threads.experimental_move).mockRejectedValue(
      new Error("Thread thr_test is not idle"),
    );
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("radio"));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Thread thr_test is not idle",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("shows the failure message of a move that ended unfinished", async () => {
    vi.mocked(sdk.threads.experimental_move).mockResolvedValue({
      moveId: "move_1",
      threadId: "thr_test",
      phase: "cleanup_pending",
      sourceEnvironmentId: "env_local",
      targetEnvironmentId: "env_b",
      error: "Target daemon rejected the transfer",
    });
    renderDialog();

    fireEvent.click(screen.getByRole("radio"));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Target daemon rejected the transfer",
    );
  });
});
