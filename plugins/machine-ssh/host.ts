import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  OUTPUT_CHUNK_MAX_CHARS,
  sshHostContract,
  sshHostSignals,
} from "./contract.js";
import { createSshClient, type SshClient } from "./host/ssh-client.js";

interface CallContext {
  signal: AbortSignal;
  experimental_paths: { dataDir: string; tempDir: string };
}

async function withClient<T>(
  context: CallContext,
  run: (client: SshClient) => Promise<T>,
): Promise<T> {
  const client = await createSshClient({
    dataDir: context.experimental_paths.dataDir,
    tempDir: context.experimental_paths.tempDir,
    signal: context.signal,
  });
  try {
    return await run(client);
  } finally {
    await client.dispose();
  }
}

export default experimental_defineHostEntry({
  contract: sshHostContract,
  experimental_signals: sshHostSignals,
  handlers: {
    listConfigHosts: (_input, context) =>
      withClient(context, (client) => client.listConfigHosts()),
    resolve: ({ target }, context) =>
      withClient(context, (client) => client.resolve(target)),
    inspect: ({ target, routeUrls }, context) =>
      withClient(context, (client) => client.inspect(target, routeUrls)),
    trust: ({ target, fingerprint }, context) =>
      withClient(context, (client) => client.trust(target, fingerprint)),
    forget: ({ pinnedKey }, context) =>
      withClient(context, (client) => client.forget(pinnedKey)),
    exec: ({ executionId, target, command, ...run }, context) =>
      withClient(context, async (client) => {
        let delivered: Promise<unknown> = Promise.resolve();
        const result = await client.exec(target, command, {
          ...run,
          onOutput(text) {
            for (
              let start = 0;
              start < text.length;
              start += OUTPUT_CHUNK_MAX_CHARS
            ) {
              const chunk = text.slice(start, start + OUTPUT_CHUNK_MAX_CHARS);
              delivered = delivered.then(() =>
                context.experimental_emitSignal("output", {
                  executionId,
                  chunk,
                }),
              );
            }
          },
        });
        await delivered;
        return result;
      }),
  },
});
