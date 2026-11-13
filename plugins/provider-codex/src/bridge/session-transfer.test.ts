import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codexSessionsDirectory,
  listCodexSessionFiles,
} from "./session-transfer.js";

const PARENT = "01a1aeff-c171-70b0-9ea6-4031c45d476b";
const CHILD = "01a1af00-45e3-7a00-b8e9-6fb892abe331";
const GRANDCHILD = "01a1af00-6334-78a3-92c7-44219205d9bc";
const UNRELATED = "01a1af00-7228-7580-b9b4-5bd34113dadb";

let codexHome: string;

beforeEach(async () => {
  codexHome = await mkdtemp(join(tmpdir(), "bb-codex-transfer-"));
});

afterEach(async () => {
  await rm(codexHome, { recursive: true, force: true });
});

async function writeRollout(args: {
  day: string;
  time: string;
  id: string;
  parent?: string;
}): Promise<string> {
  const directory = join(
    codexSessionsDirectory(codexHome),
    ...args.day.split("-"),
  );
  await mkdir(directory, { recursive: true });
  const path = join(
    directory,
    `rollout-${args.day}T${args.time}-${args.id}.jsonl`,
  );
  const source =
    args.parent === undefined
      ? "cli"
      : { subagent: { thread_spawn: { parent_thread_id: args.parent } } };
  await writeFile(
    path,
    `${JSON.stringify({ type: "session_meta", payload: { id: args.id, source, base_instructions: { text: "x".repeat(200_000) } } })}\n{"type":"event_msg"}\n`,
  );
  return path;
}

describe("listCodexSessionFiles", () => {
  it("returns the rollout, nested subagent rollouts and nothing unrelated, keeping the date folders", async () => {
    const parent = await writeRollout({
      day: "2026-11-06",
      time: "14-55-59",
      id: PARENT,
    });
    const child = await writeRollout({
      day: "2026-11-07",
      time: "09-00-00",
      id: CHILD,
      parent: PARENT,
    });
    const grandchild = await writeRollout({
      day: "2026-11-07",
      time: "09-05-00",
      id: GRANDCHILD,
      parent: CHILD,
    });
    await writeRollout({
      day: "2026-11-07",
      time: "10-00-00",
      id: UNRELATED,
      parent: "other-parent",
    });
    await writeRollout({
      day: "2026-11-05",
      time: "10-00-00",
      id: "01a1aeff-0000-0000-0000-000000000000",
      parent: PARENT,
    });

    const files = await listCodexSessionFiles({
      codexHome,
      sessionId: PARENT,
    });

    expect(files).toEqual([
      {
        path: parent,
        relativePath: `2026/11/06/rollout-2026-11-06T14-55-59-${PARENT}.jsonl`,
      },
      {
        path: child,
        relativePath: `2026/11/07/rollout-2026-11-07T09-00-00-${CHILD}.jsonl`,
      },
      {
        path: grandchild,
        relativePath: `2026/11/07/rollout-2026-11-07T09-05-00-${GRANDCHILD}.jsonl`,
      },
    ]);
  });

  it("returns an empty list when the session or the sessions folder is missing", async () => {
    expect(
      await listCodexSessionFiles({ codexHome, sessionId: PARENT }),
    ).toEqual([]);
    await writeRollout({ day: "2026-11-06", time: "14-55-59", id: UNRELATED });
    expect(
      await listCodexSessionFiles({ codexHome, sessionId: PARENT }),
    ).toEqual([]);
  });

  it("rejects session ids that could escape the sessions folder", async () => {
    await expect(
      listCodexSessionFiles({ codexHome, sessionId: "../escape" }),
    ).rejects.toThrow("Invalid Codex session id");
  });
});
