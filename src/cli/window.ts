import { parseArgs } from "node:util";
import { cliContext } from "./context.ts";
import { saveConfig, upsertProviderWindow } from "../config/config.ts";
import type { WindowCfg } from "../config/types.ts";

export async function run(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      type: { type: "string" },
      duration: { type: "string" },
      weekday: { type: "string" },
      day: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  if (positionals[0] !== "set") {
    throw new Error("window: only 'set' subcommand is supported");
  }

  const id = positionals[1];
  if (!id) {
    throw new Error("window set: provider id is required (try omp or claude-code)");
  }

  const kind = values.type;
  let w: WindowCfg;
  switch (kind) {
    case "rolling": {
      if (!values.duration) {
        throw new Error("--duration required for rolling");
      }
      w = { type: "rolling", duration: values.duration };
      break;
    }
    case "daily":
      w = { type: "daily" };
      break;
    case "weekly": {
      if (!values.weekday) {
        throw new Error("--weekday required for weekly");
      }
      w = { type: "weekly", duration: values.weekday };
      break;
    }
    case "monthly": {
      if (!values.day) {
        throw new Error("--day required for monthly");
      }
      w = { type: "monthly", duration: values.day };
      break;
    }
    default:
      throw new Error(`window set: --type must be one of rolling|daily|weekly|monthly (got ${kind})`);
  }

  const { paths, cfg } = cliContext();
  upsertProviderWindow(cfg, id, w);
  saveConfig(paths.configFile, cfg);
  console.log(`${id}: window updated`);
}