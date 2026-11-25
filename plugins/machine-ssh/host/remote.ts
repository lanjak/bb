const DECODER =
  'd=-d; printf "" | base64 -d >/dev/null 2>&1 || d=-D; eval "$(printf %s "$1" | base64 "$d")"';

const SHELL_ANSWER_SECONDS = 10;

const NODE_DISCOVERY = `bb_supported() {
  "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' </dev/null >/dev/null 2>&1
}
bb_ask() {
  bb_answer=$(mktemp) || return 0
  "\${SHELL:-/bin/sh}" "$@" </dev/null >"$bb_answer" 2>/dev/null &
  bb_asked=$!
  (bb_waited=0; while [ "$bb_waited" -lt ${SHELL_ANSWER_SECONDS} ] && kill -0 "$bb_asked"; do sleep 1; bb_waited=$((bb_waited + 1)); done; kill -9 "$bb_asked") </dev/null >/dev/null 2>&1 &
  wait "$bb_asked" 2>/dev/null
  grep '^/.*/node$' "$bb_answer" | tail -n 1
  rm -f "$bb_answer"
}
bb_use() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  if bb_supported "$1"; then bb_found=$1; return 0; fi
  [ -n "$bb_old" ] || bb_old=$1
  return 1
}
bb_ask_shells() {
  case "\${SHELL:-}" in
    *csh) bb_use "$(bb_ask -c 'which node')" ;;
    *) bb_use "$(bb_ask -ilc 'command -v node')" || bb_use "$(bb_ask -lc 'command -v node')" ;;
  esac
}
bb_search_installs() {
  for bb_path in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$bb_path" ] && bb_supported "$bb_path"; then bb_found=$bb_path; fi
  done
  [ -z "$bb_found" ] || return 0
  for bb_path in "$HOME/.local/share/fnm/aliases/default/bin/node" "$HOME/.fnm/aliases/default/bin/node" "$HOME/Library/Application Support/fnm/aliases/default/bin/node" "$HOME/.asdf/shims/node" "$HOME/.local/share/mise/shims/node" "$HOME/.volta/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    bb_use "$bb_path" && return 0
  done
  return 1
}
if ! { command -v node >/dev/null 2>&1 && bb_supported node; }; then
  bb_found=
  bb_old=
  bb_ask_shells || bb_search_installs || :
  if [ -z "$bb_found" ] && ! command -v node >/dev/null 2>&1; then bb_found=$bb_old; fi
  if [ -n "$bb_found" ]; then
    case "$bb_found" in
      */shims/node | */.volta/bin/node | */fnm_multishells/* | */fnm/aliases/* | */.fnm/aliases/*)
        bb_real=$("$bb_found" -p process.execPath </dev/null 2>/dev/null)
        case "$bb_real" in /*/node) bb_found=$bb_real ;; esac
        ;;
    esac
    PATH="\${bb_found%/*}:$PATH"
    export PATH
  fi
fi`;

export function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function remoteScript(
  command: readonly string[],
  options: { linger: boolean },
): string {
  return [
    NODE_DISCOVERY,
    ...(options.linger
      ? []
      : ["BB_INSTALL_NO_LINGER=1; export BB_INSTALL_NO_LINGER"]),
    `exec ${command.map(posixQuote).join(" ")}`,
  ].join("\n");
}

export function remoteCommand(
  command: readonly string[],
  options: { linger: boolean },
): string {
  const script = Buffer.from(remoteScript(command, options)).toString("base64");
  return `exec /bin/sh -c '${DECODER}' bb-ssh ${script}`;
}
