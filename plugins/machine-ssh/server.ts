import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { sshAppContract } from "./app-contract.js";
import { registerSshCli } from "./server/cli.js";
import { registerSshProvider } from "./server/provider.js";
import { createSshService } from "./server/service.js";
import { targetFromInputs } from "./target.js";

export default function sshMachinesPlugin(bb: BbPluginApi): void {
  const service = createSshService(bb);
  registerSshProvider(bb, service);
  registerSshCli(bb, service);
  bb.rpc.register(sshAppContract, {
    connectionOptions: () => service.connectionOptions(),
    configHosts: ({ via }, context) =>
      service.configHosts(via, context.experimental_signal),
    check: ({ via, access, keepRunning, ...target }, context) =>
      service.check({
        via,
        target: targetFromInputs(target),
        access,
        keepRunning,
        signal: context.experimental_signal,
      }),
  });
}
