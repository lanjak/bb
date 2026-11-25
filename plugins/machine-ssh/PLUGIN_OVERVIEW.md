Add a Linux or macOS computer that you reach over SSH as a bb machine.

In **Settings > Machines > Add machine**, choose **Over SSH**, pick the machine
that runs ssh and a host from its `~/.ssh/config` (or type `user@host`), check
the connection, and confirm the host key fingerprint. bb installs its daemon over
SSH and connects the machine through your normal server route.

- ssh uses the keys, agent and ProxyJump setup of the machine you connect from.
  bb copies no key and never writes `~/.ssh`.
- **Reconnect** reinstalls and updates the daemon over SSH.
- From a terminal: `bb ssh hosts`, `bb ssh probe <host>` and `bb ssh add <host>`.

The computer needs Node.js 22.19 or newer, npm, curl, and key or agent sign-in.

bb refuses a new host key from an agent thread that identifies itself through the
`bb` CLI. This is a guardrail against mistakes, not a security boundary: an agent
can remove that identity or call the HTTP API.
