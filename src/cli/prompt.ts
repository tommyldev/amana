import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

/** Prompt for a line of text. Trims; re-prompts if empty unless allowEmpty. */
export async function promptText(question: string, allowEmpty = false): Promise<string> {
  for (;;) {
    const value = (await ask(`${question}: `)).trim();
    if (value.length > 0 || allowEmpty) return value;
  }
}

/** Present a numbered list and return the selected index, or throw on cancel. */
export async function promptSelect(question: string, items: string[]): Promise<number> {
  if (items.length === 0) throw new Error("nothing to select");
  stdout.write(`${question}\n`);
  items.forEach((item, i) => stdout.write(`  ${i + 1}) ${item}\n`));
  for (;;) {
    const raw = (await ask("Selection (number): ")).trim();
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
    stdout.write(`Enter a number between 1 and ${items.length}.\n`);
  }
}

function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
