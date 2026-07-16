import { parseArgs } from "node:util";
import { cliContext } from "./context.ts";
import { saveConfig, upsertProviderLimit } from "../config/config.ts";

export async function run(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      cost: { type: "string" },
      tokens: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  if (positionals[0] !== "set") {
    throw new Error("limit: only 'set' subcommand is supported");
  }

  const id = positionals[1];
  if (!id) {
    throw new Error("limit set: provider id is required (try omp or claude-code)");
  }

  const cost = values.cost !== undefined ? Number.parseFloat(values.cost) : undefined;
  const tokens = values.tokens !== undefined ? Number.parseInt(values.tokens, 10) : undefined;

  const { paths, cfg } = cliContext();
  upsertProviderLimit(cfg, id, cost, tokens);
  saveConfig(paths.configFile, cfg);
  console.log(`${id}: limits updated`);
}