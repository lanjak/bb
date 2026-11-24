See what every machine and thread uses, and stop a heavy process without a terminal. The plugin also lists the servers an agent started for a thread, with their ports.

## What you get

- A **Resources** page: CPU, memory and disk for each connected machine, the threads that use the most, and the processes under each thread. A machine card shows OK, a warning or a critical state.
- A **Processes** section in a thread's Info tab with the same numbers for that thread.
- **Stop** on a command a thread started. It ends the command and every process under it. It is never offered for the agent, its shell, bb, or a process that bb did not attribute to a thread. Other processes on the machine show read only.
- A badge on Resources, and one notice, when a machine runs low on memory or disk or its CPU stays saturated. This works only while bb is open.
- A "Servers" item in the thread's context row with the server count and ports.
- When you archive or delete a thread, its servers stop if the thread's machine is online. The `Stop servers when a thread is archived` setting turns this off.

## Cost

Nothing is sampled while no view is open. Each open view asks for a new sample every 5 seconds (30 seconds for the badge), and the server shares one sample for each machine between all views. Samples live in memory and are never stored, never become thread events, and never reach logs or telemetry.

## How it works

bb sets `BB_THREAD_ID` in the shells of each agent. The plugin runs on the machine of the thread's environment and reads the process table there. A process belongs to a thread when it carries the thread's id, or when its nearest ancestor does. A command that outlived its shell, such as one started with `nohup`, still counts. When the agent's shell is gone, Stop ends the highest process of the thread above the command, so a wrapper such as `nohup sh -c 'while :; do ...; done'` cannot start it again.

CPU is the share of one core used between two samples, so a process using two cores shows 200%. Memory is resident memory, and shared pages count once for each process, so a thread's total can exceed what it really uses. On macOS, memory pressure decides the warning. In a container, memory is measured against the container's limit.

## CLI

- `bb processes usage [--machine <id-or-name>] [--limit N] [--json]`: one line for each machine, or one machine with its threads and biggest other processes.
- `bb processes thread [thread-id] [--commands] [--json]`: the processes of a thread. Command lines show only for your own thread unless you pass `--commands`.
- `bb processes servers [thread-id] [--json]`: the servers of a thread, or of every thread outside one.
- `bb processes stop <pid> [--thread <thread-id>] [--json]`: stop a command or server. It prints the outcome and exits non-zero unless the command stopped.

The same data is available through plugin RPC (`resources.machines`, `resources.machine`, `resources.thread`, `processes.stop`), for example with `sdk.plugins.callRpc`.

## Settings

`memoryWarnPercent`, `memoryCriticalPercent`, `diskWarnFreePercent`, `diskWarnFreeGiB`, `diskCriticalFreePercent`, `diskCriticalFreeGiB`, `cpuSaturatedPercent`, `toasts` and `stopOnArchive`. See the Processes section of the configuration guide.

## Requirements

Linux, macOS and Windows machines. On Windows, the plugin reads each process's environment with a PowerShell helper that uses `ReadProcessMemory` on processes of your own user. If that helper is blocked (for example by Constrained Language Mode or an application control policy), the machine shows its totals and its top processes, and the thread view says why it has no per-thread data. Listing servers is not available on Windows yet.
