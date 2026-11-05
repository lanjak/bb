import { expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({
  randomBytes: () => ({ toString: () => "synthetic-token" }),
  randomUUID: () => "synthetic-uuid",
  timingSafeEqual: () => false,
  createHmac: vi.fn(),
}));

const controls = vi.hoisted(() => ({
  wsConstructor: vi.fn(),
  httpClose: vi.fn((callback: (error?: unknown) => void) => callback()),
  wsClose: vi.fn((callback: () => void) => callback()),
}));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined), rename: vi.fn(async () => undefined), rm: vi.fn(async () => undefined) }));
vi.mock("node:http", () => ({ createServer: vi.fn(() => ({
  on: vi.fn(), once: vi.fn(), off: vi.fn(),
  listen: vi.fn((_port: number, _host: string, callback: () => void) => callback()),
  address: () => ({ port: 12345 }), close: controls.httpClose,
})) }));
vi.mock("ws", () => ({ WebSocket: { OPEN: 1 }, WebSocketServer: class {
  constructor() { controls.wsConstructor(); }
  on = vi.fn(); close = controls.wsClose;
} }));
vi.mock("@bb/config/file-lock", async () => vi.importActual("@bb/config/internal-managed-root-admission"));
vi.mock("@bb/host-daemon-contract", () => {
  const schema = { parse: (value: unknown) => value };
  return { DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE: "broker.json", desktopBrowserBrokerDescriptorSchema: schema,
    desktopBrowserBrokerResponseSchema: schema, desktopBrowserChangedSchema: schema,
    desktopBrowserCommandSchema: schema, desktopBrowserRegistrationSchema: schema, desktopBrowserResultSchemas: {} };
});

it("joins both original servers when temporary cleanup fails without replacing undefined primary", async () => {
  const fs = await import("node:fs/promises");
  const { startDesktopBrowserBroker } = await import("./desktop-browser-broker.js");
  vi.mocked(fs.rename).mockRejectedValueOnce(undefined);
  vi.mocked(fs.rm).mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(startDesktopBrowserBroker({ dataDir: "/unopened", hostId: "host", serverUrl: "https://example.test", onChanged: () => undefined })).rejects.toBeUndefined();
  expect(controls.httpClose).toHaveBeenCalledTimes(1);
  expect(controls.wsClose).toHaveBeenCalledTimes(1);
});

it("does not delete a foreign temporary file when exclusive publication refuses", async () => {
  const fs = await import("node:fs/promises");
  const { startDesktopBrowserBroker } = await import("./desktop-browser-broker.js");
  vi.mocked(fs.rm).mockClear();
  const foreign = Object.assign(new Error("foreign"), { code: "EEXIST" });
  vi.mocked(fs.writeFile).mockRejectedValueOnce(foreign);
  await expect(startDesktopBrowserBroker({ dataDir: "/unopened", hostId: "host", serverUrl: "https://example.test", onChanged: () => undefined })).rejects.toBe(foreign);
  expect(fs.rm).not.toHaveBeenCalled();
});

it("closes the original HTTP handle when the WebSocket constructor throws undefined", async () => {
  const { startDesktopBrowserBroker } = await import("./desktop-browser-broker.js");
  const httpClosed = controls.httpClose.mock.calls.length;
  const wsClosed = controls.wsClose.mock.calls.length;
  controls.wsConstructor.mockImplementationOnce(() => { throw undefined; });
  await expect(startDesktopBrowserBroker({ dataDir: "/unopened", hostId: "host", serverUrl: "https://example.test", onChanged: () => undefined })).rejects.toBeUndefined();
  expect(controls.httpClose.mock.calls.length).toBe(httpClosed + 1);
  expect(controls.wsClose.mock.calls.length).toBe(wsClosed);
});

it("blocks publication after enrollment at an await and refuses later constructors", async () => {
  const fs = await import("node:fs/promises");
  const http = await import("node:http");
  const { startDesktopBrowserBroker } = await import("./desktop-browser-broker.js");
  const admission = await vi.importActual<typeof import("@bb/config/internal-managed-root-admission")>("@bb/config/internal-managed-root-admission");
  vi.mocked(fs.writeFile).mockClear();
  vi.mocked(fs.rename).mockClear();
  vi.mocked(fs.mkdir).mockImplementationOnce(async () => {
    admission.internal_DO_NOT_USE_enrollManagedRoot(Object.freeze({}));
  });
  const options = { dataDir: "/unopened", hostId: "host", serverUrl: "https://example.test", onChanged: () => undefined };
  await expect(startDesktopBrowserBroker(options)).rejects.toThrow("cohort NOT_ESTABLISHED");
  expect(fs.writeFile).not.toHaveBeenCalled();
  expect(fs.rename).not.toHaveBeenCalled();
  const created = vi.mocked(http.createServer).mock.calls.length;
  await expect(startDesktopBrowserBroker(options)).rejects.toThrow("cohort NOT_ESTABLISHED");
  expect(vi.mocked(http.createServer).mock.calls.length).toBe(created);
});
