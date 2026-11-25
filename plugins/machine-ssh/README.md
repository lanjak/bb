# SSH machines

Adds a Linux or macOS computer that an enrolled machine reaches over SSH as a bb
machine, through the `ssh` machine provider.

- `host.ts` runs the system `ssh`, `ssh-keygen` and ssh config on the Connect
  from machine. It writes only its own `known_hosts` file in the plugin host data
  directory, and passes `UpdateHostKeys no` and `CheckHostIP no` so ssh never
  writes `~/.ssh`.
- `server.ts` registers the provider, the app RPC and `bb ssh`.
- `app.tsx` is the Add machine control.

SSH config follows `HOME` of the daemon. See `skills/ssh-machines/SKILL.md` for
commands, requirements and host key rules.
