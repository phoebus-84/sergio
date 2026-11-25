#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A small command line for the Atlas client
// ---------------------------------------------------------------------------
// For a person checking an account or looking after a job: is the host
// there, what does a task cost, how is an operation doing. `task` submits a
// body written by hand, which is how a request shape is tried against the
// real service; it spends, so it asks for --paid.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { AtlasClient, createAtlasClient } from "./client.js";
import { API_KEY_ENV, BASE_URL_ENV, DEFAULT_BASE_URL, KEY_SCOPES, redactKey, resolveConfig } from "./config.js";
import { AtlasUnavailableError } from "./errors.js";
import { describePrices } from "./pricing.js";
import { provenanceOf } from "./provenance.js";
import { ATLAS_TASKS, type AtlasTask } from "./types.js";

const HELP = `npm run cli --workspace @av/worldlabs-atlas -- <command>

  health                         is the host there? no key, no charge
  config                         the host and the key in use (last four characters)
  prices                         what each task costs, where that is known
  operations                     the account's operations
  operation <id>                 one operation
  wait <id> [minutes]            wait for an operation (default 45)
  cancel <id> [reason]           ask Atlas to stop an operation (the key needs operations.cancel)
  trace <id> [file]              the provider's account of an operation
  upload <file> <content-type>   hand a file to Atlas; prints its asset id
  task <name> <body.json> --paid [--key <idempotency-key>] [--out <file>]
                                 submit a task as written and wait: THIS SPENDS CREDITS
                                 names: ${ATLAS_TASKS.join(", ")}
                                 the same --key with the same body returns the first operation: use it to retry

The key is read from ${API_KEY_ENV} and needs ${KEY_SCOPES.join(", ")}; ${BASE_URL_ENV} names another API root than ${DEFAULT_BASE_URL}.
World Labs' own CLI (@worldlabsai/cli) reads the same variables and does more: this one is what the package needs to look after its jobs.`;

const print = (value: unknown) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "help") {
    print(HELP);
    return 0;
  }
  if (command === "prices") {
    print(describePrices().join("\n"));
    return 0;
  }
  if (command === "health") {
    // No key is needed, so none is required: a placeholder never leaves this process.
    const config = resolveConfig({ ...process.env, [API_KEY_ENV]: process.env[API_KEY_ENV] || "none" });
    if (config instanceof AtlasUnavailableError) throw config;
    const health = await new AtlasClient({ config }).health();
    print({ host: config.baseUrl, ...health });
    return health.ok ? 0 : 1;
  }
  if (command === "config") {
    const config = resolveConfig();
    print(config instanceof AtlasUnavailableError ? { available: false, reason: config.message } : { available: true, host: config.baseUrl, key: redactKey(config.apiKey) });
    return config instanceof AtlasUnavailableError ? 1 : 0;
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const client = createAtlasClient({ onEvent: (event) => console.error(`[atlas] ${event.kind}${event.operationId ? ` ${event.operationId}` : ""}${event.state ? ` ${event.state}` : ""}${event.note ? ` ${event.note}` : ""}`) });
  const need = (value: string | undefined, what: string): string => {
    if (!value) throw new Error(`${command} needs ${what}`);
    return value;
  };

  switch (command) {
    case "operations":
      print((await client.listOperations({ pageSize: 50 }, controller.signal)).operations.map(({ raw: _raw, response: _response, ...operation }) => operation));
      return 0;
    case "operation":
      print((await client.getOperation(need(args[0], "an operation id"), controller.signal)).raw);
      return 0;
    case "wait": {
      const minutes = Number(args[1] ?? 45);
      // Ctrl-C stops the waiting only: the job is someone's money, and stopping it is `cancel`.
      print((await client.waitUntilDone(need(args[0], "an operation id"), { maxWaitMs: minutes * 60_000, signal: controller.signal })).raw);
      return 0;
    }
    case "cancel":
      print((await client.cancelOperation(need(args[0], "an operation id"), args[1] ? { reason: args.slice(1).join(" ") } : {}, controller.signal)).raw);
      return 0;
    case "trace": {
      const trace = await client.traceOperation(need(args[0], "an operation id"), controller.signal);
      if (args[1]) await writeFile(args[1], `${JSON.stringify(trace, null, 2)}\n`);
      print(args[1] ? `written to ${args[1]}` : trace);
      return 0;
    }
    case "upload": {
      const file = need(args[0], "a file");
      print(await client.uploadFile({ bytes: await readFile(file), fileName: basename(file), contentType: need(args[1], "a content type, e.g. image/png") }, controller.signal));
      return 0;
    }
    case "task": {
      const task = need(args[0], "a task name") as AtlasTask;
      if (!ATLAS_TASKS.includes(task)) throw new Error(`${task} is not a task: ${ATLAS_TASKS.join(", ")}`);
      const body = JSON.parse(await readFile(need(args[1], "a body file"), "utf8")) as Record<string, unknown>;
      if (!args.includes("--paid")) throw new Error(`tasks:${task} spends credits. Read the body once more, then add --paid`);
      const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
      const key = flag("--key") ?? `cli-${randomUUID()}`;
      console.error(`[atlas] idempotency key ${key}: pass it as --key to ask for this same task again`);
      const run = await client.run(task, body, { signal: controller.signal, idempotencyKey: key });
      const record = provenanceOf(run, body);
      const out = flag("--out");
      if (out) await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
      print(out ? { operationId: run.operation.id, files: run.files, written: out } : record);
      return 0;
    }
    default:
      throw new Error(`unknown command ${command}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
