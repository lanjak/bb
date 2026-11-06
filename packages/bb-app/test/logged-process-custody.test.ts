import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  spawn: vi.fn(), nativeSpawn: vi.fn(), close: vi.fn(), open: vi.fn(() => 73),
  mkdir: vi.fn(), stat: vi.fn(() => undefined), rename: vi.fn(),
}));
vi.mock("@bb/process-utils", () => ({ spawnHostProcess: fake.spawn }));
vi.mock("node:child_process", () => ({ spawn: fake.nativeSpawn }));
vi.mock("node:fs", () => ({ closeSync: fake.close, openSync: fake.open, mkdirSync: fake.mkdir, statSync: fake.stat, renameSync: fake.rename }));
vi.mock("@bb/config/file-lock", () => ({ internal_DO_NOT_USE_assertManagedRootAdmission: () => undefined }));
import { getOriginalProcessCustody, spawnLoggedProcess, type OriginalProcessSpawnFailure } from "../src/logged-process.js";

class OriginalChild extends EventEmitter {
  kill = vi.fn(() => true);
  stdout = { destroy: vi.fn() };
  stderr = { destroy: vi.fn() };
}
const args = { command: "/inert/node", args: [], env: {}, logDir: "/unopened", logName: "server" as const };

beforeEach(() => {
  vi.clearAllMocks();
  fake.spawn.mockReset();
  fake.close.mockReset();
});

it("installs completion before reentrant kill and joins CLOSE once", async () => {
  const child = new OriginalChild();
  fake.spawn.mockReturnValue(child);
  const original = getOriginalProcessCustody(spawnLoggedProcess(args));
  if (original === undefined) throw new Error("Missing original custody.");
  let reentrant: Promise<void> | undefined;
  child.kill.mockImplementation(() => { reentrant = original.cleanup(); return true; });
  const completion = original.cleanup();
  expect(reentrant).toBe(completion);
  expect(child.kill).toHaveBeenCalledTimes(1);
  let finished = false;
  void completion.then(() => { finished = true; });
  await Promise.resolve();
  expect(finished).toBe(false);
  child.emit("close");
  await completion;
});

it("preserves undefined spawn primary and original FD close uncertainty without retry", () => {
  const closeFailure = new Error("injected close failure");
  fake.spawn.mockImplementation(() => { throw undefined; });
  fake.close.mockImplementation(() => { throw closeFailure; });
  let receipt: OriginalProcessSpawnFailure | undefined;
  let caught = false;
  try { spawnLoggedProcess({ ...args, onIssuanceFailure: (failure) => { receipt = failure; } }); }
  catch (reason) { caught = true; expect(reason).toBeUndefined(); }
  expect(caught).toBe(true);
  expect(receipt?.primary).toBeUndefined();
  expect(receipt?.original).toBeUndefined();
  expect(receipt?.descriptor).toMatchObject({ fd: 73, attempted: true, closed: false, failures: [closeFailure] });
  expect(fake.close).toHaveBeenCalledExactlyOnceWith(73);
});

it("surfaces exact close failure to ordinary caller while retaining the issued original", async () => {
  const child = new OriginalChild();
  const failure = new Error("injected close uncertainty");
  fake.spawn.mockReturnValue(child);
  fake.close.mockImplementation(() => { throw failure; });
  let receipt: OriginalProcessSpawnFailure | undefined;
  let observed = false;
  try { spawnLoggedProcess({ ...args, onIssuanceFailure: (value) => { receipt = value; } }); }
  catch (reason) { observed = true; expect(reason).toBe(failure); }
  expect(observed).toBe(true);
  expect(receipt?.original?.child).toBe(child);
  expect(receipt?.descriptor.fd).toBe(73);
  expect(fake.close).toHaveBeenCalledTimes(1);
  child.emit("close");
  await receipt?.original?.cleanup();
});

it("attempts both pipe destructions and rejects with first opaque failure after CLOSE", async () => {
  const child = new OriginalChild();
  fake.spawn.mockReturnValue(child);
  const original = getOriginalProcessCustody(spawnLoggedProcess(args));
  if (original === undefined) throw new Error("Missing original custody.");
  child.stdout.destroy.mockImplementation(() => { throw undefined; });
  child.stderr.destroy.mockImplementation(() => { throw false; });
  const cleanup = original.cleanup();
  const rejection = expect(cleanup).rejects.toBeUndefined();
  child.emit("close");
  await rejection;
  expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
  expect(child.stderr.destroy).toHaveBeenCalledTimes(1);
  expect(original.failures).toEqual([undefined, false]);
  expect(original.cleanup()).toBe(cleanup);
  expect(fake.close).toHaveBeenCalledTimes(1);
  expect(fake.nativeSpawn).not.toHaveBeenCalled();
});
