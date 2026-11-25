import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  definePluginApp,
  useRpc,
  type JsonValue,
  type PluginMachineProviderInputsProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Pill } from "@/components/ui/pill";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type {
  CheckReport,
  ConnectionOptions,
  ListedConfigHost,
  sshAppContract,
} from "./app-contract.js";
import { PROVIDER_ID } from "./provider-id.js";

interface Form {
  via: string | null;
  destination: string;
  port: string;
  identityFile: string;
  name: string;
  access: string | null;
  keepRunning: boolean;
}

const EMPTY_FORM: Form = {
  via: null,
  destination: "",
  port: "",
  identityFile: "",
  name: "",
  access: null,
  keepRunning: true,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readForm(value: JsonValue | null): Form {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return EMPTY_FORM;
  const text = (key: string) => {
    const entry = value[key];
    return typeof entry === "string" ? entry : "";
  };
  return {
    via: text("via") || null,
    destination: text("destination"),
    port: typeof value.port === "number" ? String(value.port) : "",
    identityFile: text("identityFile"),
    name: text("name"),
    access: text("access") || null,
    keepRunning: value.keepRunning !== false,
  };
}

function parsePort(port: string): number | null | "invalid" {
  const text = port.trim();
  if (text === "") return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= 65535
    ? value
    : "invalid";
}

function requestFor(form: Form) {
  const port = parsePort(form.port);
  if (form.via === null || form.destination.trim() === "" || port === "invalid")
    return null;
  return {
    via: form.via,
    destination: form.destination.trim(),
    keepRunning: form.keepRunning,
    ...(port === null ? {} : { port }),
    ...(form.identityFile.trim() === ""
      ? {}
      : { identityFile: form.identityFile.trim() }),
    ...(form.access === null ? {} : { access: form.access }),
  };
}

function blockedReason(
  form: Form,
  checked: CheckReport | null,
  checking: boolean,
  confirmed: boolean,
): string | null {
  if (form.via === null) return "Connect a machine that can run ssh.";
  if (form.destination.trim() === "") return "Choose a computer.";
  if (parsePort(form.port) === "invalid")
    return "The port must be between 1 and 65535.";
  if (checking) return "Checking the connection...";
  if (checked === null) return "Check the connection first.";
  const { inspection, blockers, machineName } = checked;
  if (machineName !== null)
    return `Already added as ${machineName}. Use Reconnect on that machine.`;
  if (inspection.hostKey.state === "unreachable")
    return "bb could not connect.";
  if (inspection.hostKey.state === "changed") return "The host key changed.";
  if (inspection.hostKey.state === "unknown") {
    if (inspection.resolved.strictHostKeyChecking)
      return "Your ssh config requires known hosts.";
    return confirmed ? null : "Confirm the host key fingerprint.";
  }
  if (inspection.facts === null) return "bb could not sign in.";
  return blockers.length > 0 ? "Fix the problems the check found." : null;
}

export function SshMachineInputs({
  value,
  onChange,
  experimental_localHostId: localHostId,
}: PluginMachineProviderInputsProps) {
  const rpc = useRpc<typeof sshAppContract>();
  const ids = {
    destination: useId(),
    port: useId(),
    identity: useId(),
    name: useId(),
    keep: useId(),
    confirm: useId(),
  };
  const [form, setForm] = useState(() => readForm(value));
  const [options, setOptions] = useState<ConnectionOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [configHosts, setConfigHosts] = useState<{
    via: string;
    hosts: ListedConfigHost[];
    error: string | null;
  } | null>(null);
  const [checked, setChecked] = useState<CheckReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const generation = useRef(0);

  const update = (next: Partial<Form>) => {
    setForm((current) => ({ ...current, ...next }));
    if (Object.keys(next).some((key) => key !== "name")) {
      generation.current += 1;
      setChecked(null);
      setChecking(false);
      setCheckError(null);
      setConfirmed(false);
    }
  };

  const loadOptions = useCallback(() => {
    setLoadError(null);
    rpc.call("connectionOptions", {}).then(setOptions, (error: unknown) => {
      setLoadError(errorText(error));
    });
  }, [rpc]);
  useEffect(loadOptions, [loadOptions]);

  useEffect(() => {
    if (options === null || form.via !== null) return;
    const connected = options.machines.filter((machine) => machine.connected);
    const preferred =
      connected.find((machine) => machine.id === localHostId) ??
      connected.find((machine) => machine.server) ??
      connected[0];
    if (preferred !== undefined)
      setForm((current) => ({ ...current, via: preferred.id }));
  }, [options, form.via, localHostId]);

  useEffect(() => {
    const via = form.via;
    if (via === null) return;
    let current = true;
    setConfigHosts(null);
    rpc.call("configHosts", { via }).then(
      (result) => {
        if (current) setConfigHosts({ via, hosts: result.hosts, error: null });
      },
      (error: unknown) => {
        if (current)
          setConfigHosts({ via, hosts: [], error: errorText(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [rpc, form.via]);

  const reason = blockedReason(form, checked, checking, confirmed);
  const request = requestFor(form);
  const hostKey =
    checked?.inspection.hostKey.state === "unknown"
      ? checked.inspection.hostKey.fingerprint
      : null;
  const ready =
    reason === null && request !== null
      ? {
          ...request,
          ...(form.name.trim() === "" ? {} : { name: form.name.trim() }),
          ...(hostKey === null ? {} : { hostKey }),
        }
      : null;
  const reported = JSON.stringify(ready ?? { blocked: reason });
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    onChangeRef.current(
      ready === null
        ? { status: "blocked", reason: reason ?? "Choose a computer." }
        : { status: "ready", value: ready },
    );
  }, [reported]);

  const check = () => {
    if (request === null) return;
    generation.current += 1;
    const started = generation.current;
    setChecking(true);
    setChecked(null);
    setCheckError(null);
    setConfirmed(false);
    rpc.call("check", request).then(
      (report) => {
        if (generation.current !== started) return;
        setChecked(report);
        setChecking(false);
      },
      (error: unknown) => {
        if (generation.current !== started) return;
        setCheckError(errorText(error));
        setChecking(false);
      },
    );
  };

  if (loadError !== null)
    return (
      <div className="space-y-2 text-sm">
        <p role="alert" className="text-destructive-text">
          {loadError}
        </p>
        <Button type="button" size="sm" variant="outline" onClick={loadOptions}>
          Try again
        </Button>
      </div>
    );
  if (options === null)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading...
      </p>
    );

  const via = options.machines.find((machine) => machine.id === form.via);
  const query = form.destination.trim().toLowerCase();
  const aliases = configHosts?.hosts ?? [];
  const exact = aliases.some((host) => host.alias === form.destination.trim());
  const matches =
    query === "" || exact
      ? aliases
      : aliases.filter((host) => host.alias.toLowerCase().includes(query));
  const route = options.routes.find((entry) => entry.id === form.access);

  return (
    <div className="space-y-3 text-sm">
      <Field label="Connect from">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full justify-between font-normal"
              aria-label="Connect from"
            >
              <span className="truncate">
                {via?.name ?? "Choose a machine"}
              </span>
              <Icon name="ChevronDown" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {options.machines.map((machine) => (
              <DropdownMenuItem
                key={machine.id}
                disabled={!machine.connected}
                onSelect={() => update({ via: machine.id })}
              >
                <span className="truncate">{machine.name}</span>
                <span className="ml-auto pl-3 text-xs text-subtle-foreground">
                  {machine.connected
                    ? machine.id === localHostId
                      ? "this device"
                      : machine.server
                        ? "server"
                        : ""
                    : "offline"}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <p className="text-xs text-subtle-foreground">
          ssh runs on this machine and uses its keys, agent and ssh config.
        </p>
      </Field>

      <Field label="Computer" htmlFor={ids.destination}>
        <Input
          id={ids.destination}
          value={form.destination}
          placeholder="Host alias or user@host"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) => update({ destination: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            check();
          }}
        />
        {configHosts === null ? (
          form.via === null ? null : (
            <p role="status" className="text-xs text-subtle-foreground">
              Reading ssh config...
            </p>
          )
        ) : configHosts.error !== null ? (
          <p className="text-xs text-destructive-text">{configHosts.error}</p>
        ) : matches.length === 0 || exact ? null : (
          <ul
            aria-label="Hosts in ssh config"
            className="max-h-36 overflow-y-auto rounded-md border border-border"
          >
            {matches.map((host) => (
              <li key={host.alias}>
                <button
                  type="button"
                  className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
                  onClick={() => update({ destination: host.alias })}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {host.alias}
                  </span>
                  {host.machineName === null ? null : (
                    <Pill variant="secondary" size="sm">
                      In bb
                    </Pill>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Field>

      <details className="space-y-3">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Port and identity file
        </summary>
        <div className="mt-2 grid grid-cols-[6rem_1fr] gap-2">
          <Field label="Port" htmlFor={ids.port}>
            <Input
              id={ids.port}
              value={form.port}
              inputMode="numeric"
              placeholder="22"
              onChange={(event) => update({ port: event.target.value })}
            />
          </Field>
          <Field label="Identity file" htmlFor={ids.identity}>
            <Input
              id={ids.identity}
              value={form.identityFile}
              placeholder="~/.ssh/id_ed25519"
              spellCheck={false}
              onChange={(event) => update({ identityFile: event.target.value })}
            />
          </Field>
        </div>
      </details>

      <Field label="Name" htmlFor={ids.name}>
        <Input
          id={ids.name}
          value={form.name}
          maxLength={64}
          placeholder={form.destination.trim() || "Machine name"}
          onChange={(event) => update({ name: event.target.value })}
        />
      </Field>

      {options.routes.length > 1 ? (
        <Field label="Server route">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full justify-between font-normal"
                aria-label="Server route"
              >
                <span className="truncate">
                  {route?.displayName ?? "Server default"}
                </span>
                <Icon name="ChevronDown" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => update({ access: null })}>
                Server default
              </DropdownMenuItem>
              {options.routes.map((entry) => (
                <DropdownMenuItem
                  key={entry.id}
                  onSelect={() => update({ access: entry.id })}
                >
                  {entry.displayName}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </Field>
      ) : null}

      <label htmlFor={ids.keep} className="flex items-center gap-2">
        <Checkbox
          id={ids.keep}
          checked={form.keepRunning}
          onCheckedChange={(next) => update({ keepRunning: next === true })}
        />
        Keep running after logout
      </label>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={request === null || checking}
          onClick={check}
        >
          {checking ? (
            <Icon name="Spinner" aria-hidden className="animate-spin" />
          ) : null}
          {checking ? "Checking..." : "Check connection"}
        </Button>
      </div>

      {checkError === null ? null : (
        <p role="alert" className="whitespace-pre-wrap text-destructive-text">
          {checkError}
        </p>
      )}
      {checked === null ? null : (
        <CheckResult
          destination={form.destination.trim()}
          report={checked}
          confirmed={confirmed}
          confirmId={ids.confirm}
          onConfirm={setConfirmed}
        />
      )}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1">
      {htmlFor === undefined ? (
        <p className="text-xs font-medium">{label}</p>
      ) : (
        <label htmlFor={htmlFor} className="block text-xs font-medium">
          {label}
        </label>
      )}
      {children}
    </div>
  );
}

export function CheckResult({
  destination,
  report,
  confirmed,
  confirmId,
  onConfirm,
}: {
  destination: string;
  report: CheckReport;
  confirmed: boolean;
  confirmId: string;
  onConfirm: (confirmed: boolean) => void;
}) {
  const { inspection, blockers, notes, machineName } = report;
  const { resolved, hostKey, facts, message } = inspection;
  const failed =
    blockers.length > 0 ||
    hostKey.state === "unreachable" ||
    hostKey.state === "changed" ||
    (hostKey.state === "trusted" && facts === null);
  const ok = !failed && hostKey.state === "trusted";
  return (
    <section
      aria-label="Connection check"
      className="space-y-2 rounded-md border border-border bg-muted/30 p-3"
    >
      <p className="flex items-center gap-2">
        <Icon
          name={ok ? "CircleCheck" : failed ? "AlertCircle" : "Info"}
          aria-hidden
          className={cn(
            "size-4 shrink-0",
            ok && "text-success",
            failed && "text-destructive-text",
          )}
        />
        <span className="min-w-0 break-all">
          {`${resolved.user}@${resolved.hostname}:${resolved.port}`}
          {resolved.proxyJump === null ? "" : ` via ${resolved.proxyJump}`}
        </span>
      </p>
      {machineName === null ? null : (
        <p className="text-destructive-text">
          Already added as the machine {machineName}.
        </p>
      )}
      {message === null ? null : (
        <p
          role={failed ? "alert" : undefined}
          className={cn(
            "whitespace-pre-wrap break-words text-xs",
            failed ? "text-destructive-text" : "text-muted-foreground",
          )}
        >
          {message}
        </p>
      )}
      {hostKey.state === "unknown" && hostKey.fingerprint !== null ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            bb has not connected to this computer before. Its {hostKey.keyType}{" "}
            host key is:
          </p>
          <code className="block break-all rounded bg-background px-2 py-1 font-mono text-xs">
            {hostKey.fingerprint}
          </code>
          {resolved.strictHostKeyChecking ? (
            <p className="text-xs text-destructive-text">
              Your ssh config requires known hosts. Add the key yourself, then
              check again.
            </p>
          ) : (
            <label htmlFor={confirmId} className="flex items-start gap-2">
              <Checkbox
                id={confirmId}
                className="mt-0.5"
                checked={confirmed}
                onCheckedChange={(next) => onConfirm(next === true)}
              />
              <span>
                I checked that this fingerprint belongs to {destination}
              </span>
            </label>
          )}
          <p className="text-xs text-subtle-foreground">
            bb checks the rest of the computer after you add it.
          </p>
        </div>
      ) : null}
      {facts === null ? null : (
        <p className="text-xs text-muted-foreground">
          {`${facts.os} ${facts.arch}, user ${facts.user}, Node ${facts.nodeVersion ?? "not found"}`}
        </p>
      )}
      {blockers.map((blocker) => (
        <p
          key={blocker}
          role="alert"
          className="break-words text-xs text-destructive-text"
        >
          {blocker}
        </p>
      ))}
      {notes.map((note) => (
        <p key={note} className="text-xs text-muted-foreground">
          {note}
        </p>
      ))}
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_machineProviderInputs({
    machineProviderId: PROVIDER_ID,
    component: SshMachineInputs,
  });
});
