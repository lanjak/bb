import { useEffect, useRef } from "react";

export function MachineProgressLog({
  log,
  label,
}: {
  log: string;
  label: string;
}) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [log]);
  if (log === "") return null;
  return (
    <pre
      ref={ref}
      aria-label={label}
      className="max-h-60 min-w-0 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-words text-foreground"
    >
      {log}
    </pre>
  );
}
