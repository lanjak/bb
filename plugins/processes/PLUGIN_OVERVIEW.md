See what every machine and thread uses, stop a heavy process without a terminal, and open the servers an agent started from any device.

## What you get

- A **Resources** page: CPU, memory and disk for each machine, the threads that use the most, and the processes under each thread, with OK, warning and critical states.
- A **Processes** section in a thread's Info tab with the same numbers for that thread.
- **Stop** on a command a thread started. It ends the command and everything under it. It is never offered for the agent, its shell, bb, or a process bb did not attribute to a thread. Other processes show read only.
- A badge on Resources, and one notice, when a machine runs low on memory or disk or its CPU stays saturated. Only while bb is open.
- A "Servers" item in the thread's context row with each server's ports. Click a port to open it from the device you are on: directly on the thread's machine, through a forward in the desktop app, or through a bb Connect share on web and mobile when Connect is already on. Without Connect, the row says how to forward with the desktop app or `bb machine forward`.
- When you archive or delete a thread, its servers stop if its machine is online. The `Stop servers when a thread is archived` setting turns this off.

## Cost

Nothing is sampled while no view is open, apart from a check every 15 seconds of a thread with a bb Connect share the plugin made. An open view asks for a sample every 5 seconds (30 for the badge), and the server shares one sample for each machine. Samples live in memory and are never stored, never become thread events, and never reach logs or telemetry.

## How it works

bb sets `BB_THREAD_ID` in the shells of each agent. The plugin runs on the thread's machine and reads the process table. A process belongs to a thread when it, or its nearest ancestor, carries the thread's id. A command that outlived its shell, such as `nohup`, still counts, and Stop ends the highest process of the thread above it, so a wrapper loop cannot restart it.

CPU is the share of one core between two samples (200% is two cores). Memory is resident memory, so shared pages count once for each process. On macOS, memory pressure decides the warning. In a container, memory is measured against its limit.

## CLI

- `bb processes usage [--machine <id-or-name>] [--limit N]`: each machine, or one machine with its threads.
- `bb processes thread [thread-id] [--commands]`: a thread's processes.
- `bb processes servers [thread-id]`: the servers of a thread, or of every thread.
- `bb processes stop <pid> [--thread <thread-id>]`: stop a command or server.

Plugin RPC (`resources.machines`, `resources.machine`, `resources.thread`, `processes.stop`) serves the same data. Warning limits are plugin settings; see the configuration guide.

## Requirements

Linux, macOS and Windows. On Windows, a PowerShell helper reads the environment of your own processes with `ReadProcessMemory`. If that is blocked, you get machine totals and top processes, and the thread view says why.
