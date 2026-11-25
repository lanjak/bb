import type { RemoteFacts } from "../contract.js";
import { printableLines } from "./text.js";

export const PROBE_SCRIPT = `
printf 'os=%s\\n' "$(uname -s)"
printf 'arch=%s\\n' "$(uname -m)"
printf 'user=%s\\n' "$(id -un)"
printf 'uid=%s\\n' "$(id -u)"
node_path=$(command -v node || true)
printf 'node=%s\\n' "$node_path"
if [ -n "$node_path" ]; then printf 'nodeVersion=%s\\n' "$("$node_path" --version 2>/dev/null)"; fi
printf 'npm=%s\\n' "$(command -v npm || true)"
printf 'curl=%s\\n' "$(command -v curl || true)"
if [ -d /run/systemd/system ]; then echo 'systemd=yes'; fi
if command -v systemd-detect-virt >/dev/null 2>&1 && systemd-detect-virt --container --quiet; then echo 'container=yes'; fi
if command -v loginctl >/dev/null 2>&1; then
  printf 'linger=%s\\n' "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null)"
fi
for url in "$@"; do
  status=$(curl -sSL -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 "\${url%/}/install/version" 2>/dev/null || true)
  printf 'route=%s %s\\n' "\${status:-000}" "$url"
done
if [ -n "$node_path" ]; then
  for auth in "$HOME"/.bb-machines/*/auth.json; do
    [ -f "$auth" ] || continue
    "$node_path" -e 'const fs=require("node:fs"),path=require("node:path");try{const file=process.argv[1];const auth=JSON.parse(fs.readFileSync(file,"utf8"));const config=JSON.parse(fs.readFileSync(path.join(path.dirname(file),"config.json"),"utf8"));console.log("install="+auth.hostId+" "+config.serverUrl)}catch{}' "$auth"
  done
fi
`;

const MAX_LINES = 256;
const MAX_VALUE = 512;

export function parseProbe(output: string): RemoteFacts {
  const values = new Map<string, string>();
  const routes: RemoteFacts["routes"] = [];
  const installs: RemoteFacts["installs"] = [];
  for (const line of printableLines(output).slice(0, MAX_LINES)) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1).trim();
    const space = value.indexOf(" ");
    if (key === "route" && space > 0) {
      const status = Number(value.slice(0, space));
      const url = value.slice(space + 1);
      if (Number.isInteger(status) && url.length <= 2048 && routes.length < 16)
        routes.push({ url, status });
      continue;
    }
    if (key === "install" && space > 0) {
      const hostId = value.slice(0, space);
      const serverUrl = value.slice(space + 1);
      if (hostId.length <= 128 && serverUrl.length <= 2048)
        if (installs.length < 64) installs.push({ hostId, serverUrl });
      continue;
    }
    values.set(key, value.slice(0, MAX_VALUE));
  }
  const text = (key: string) => values.get(key) || null;
  const linger = values.get("linger");
  if (text("os") === null)
    throw new Error("The computer did not answer the bb probe");
  return {
    os: text("os")!,
    arch: text("arch") ?? "",
    user: text("user") ?? "",
    root: values.get("uid") === "0",
    node: text("node"),
    nodeVersion: text("nodeVersion"),
    npm: text("npm") !== null,
    curl: text("curl") !== null,
    systemd: values.get("systemd") === "yes",
    container: values.get("container") === "yes",
    linger: linger === "yes" ? true : linger === "no" ? false : null,
    routes,
    installs,
  };
}
