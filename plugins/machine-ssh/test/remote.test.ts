import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { remoteCommand } from "../host/remote.js";

const SHELLS = ["sh", "bash", "zsh", "fish", "tcsh"];
const TOOLS = ["sh", "base64", "cat", "grep", "tail", "mktemp", "rm", "sleep"];

function pathOf(command: string): string | null {
  const found = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
    encoding: "utf8",
  }).stdout.trim();
  return found === "" ? null : found;
}

describe.skipIf(process.platform === "win32")("remote command", () => {
  for (const shell of SHELLS) {
    const missing = pathOf(shell) === null;
    it.skipIf(missing)(
      `passes arguments and stdin unchanged through a ${shell} login shell`,
      () => {
        const argument = "a b 'c' \"d\" $e `f` !g \\h\nnew line";
        const result = spawnSync(
          shell,
          [
            "-c",
            remoteCommand(
              ["sh", "-c", 'printf "%s|" "$1"; cat', "x", argument],
              {
                linger: true,
              },
            ),
          ],
          { encoding: "utf8", input: "from stdin" },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(`${argument}|from stdin`);
      },
    );
  }
});

describe.skipIf(process.platform === "win32")("remote Node discovery", () => {
  let root: string;
  let tools: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-ssh-node-"));
    tools = join(root, "tools");
    await mkdir(tools);
    for (const tool of TOOLS) await symlink(pathOf(tool)!, join(tools, tool));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(path: string, content: string) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    await chmod(path, 0o755);
  }

  const fakeNode = (path: string) =>
    write(
      path,
      '#!/bin/sh\ncase "$1" in -p) printf \'%s\\n\' "$0" ;; esac\nexit 0\n',
    );

  function nodeFound(home: string, shell: string) {
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        remoteCommand(["sh", "-c", "command -v node; cat"], { linger: true }),
      ],
      {
        encoding: "utf8",
        input: "stdin kept",
        env: { HOME: home, SHELL: shell, PATH: tools },
        timeout: 40_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.split("\n");
  }

  it.skipIf(pathOf("bash") === null)(
    "finds a Node that .bashrc adds after the interactive guard",
    async () => {
      const home = join(root, "bash-home");
      const node = join(home, ".nvm/versions/node/v22.19.0/bin/node");
      await fakeNode(node);
      await write(join(home, ".profile"), '. "$HOME/.bashrc"\n');
      await write(
        join(home, ".bashrc"),
        `case $- in *i*) ;; *) return ;; esac\necho "welcome"\nPATH="${dirname(node)}:$PATH"\n`,
      );
      expect(nodeFound(home, pathOf("bash")!)).toEqual([node, "stdin kept"]);
    },
  );

  it.skipIf(pathOf("zsh") === null)(
    "finds a Node that only .zshrc adds",
    async () => {
      const home = join(root, "zsh-home");
      const node = join(home, "tools/node-22/bin/node");
      await fakeNode(node);
      await write(join(home, ".zshrc"), `path=(${dirname(node)} $path)\n`);
      expect(nodeFound(home, pathOf("zsh")!)).toEqual([node, "stdin kept"]);
    },
  );

  it("looks in the nvm directory when no shell reports a Node", async () => {
    const home = join(root, "nvm-home");
    const older = join(home, ".nvm/versions/node/v22.19.0/bin/node");
    const newer = join(home, ".nvm/versions/node/v24.1.0/bin/node");
    await fakeNode(older);
    await fakeNode(newer);
    expect(nodeFound(home, "/bin/false")).toEqual([newer, "stdin kept"]);
  });

  it("puts the real directory behind a version manager shim on PATH", async () => {
    const home = join(root, "asdf-home");
    const real = join(home, ".asdf/installs/nodejs/22.19.0/bin/node");
    await fakeNode(real);
    await write(
      join(home, ".asdf/shims/node"),
      `#!/bin/sh\nexec "${real}" "$@"\n`,
    );
    expect(nodeFound(home, "/bin/false")).toEqual([real, "stdin kept"]);
  });

  it("gives up on a shell that does not return", async () => {
    const home = join(root, "stuck-home");
    const node = join(home, ".volta/bin/node");
    await fakeNode(node);
    const shell = join(home, "stuck-shell");
    await write(shell, "#!/bin/sh\nexec sleep 60\n");
    expect(nodeFound(home, shell)).toEqual([node, "stdin kept"]);
  }, 45_000);
});
