import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

/** Prompt for a line of text. Trims; re-prompts if empty unless allowEmpty. */
export async function promptText(question: string, allowEmpty = false): Promise<string> {
  for (;;) {
    const value = (await ask(`${question}: `)).trim();
    if (value.length > 0 || allowEmpty) return value;
  }
}

/** Prompt for a secret without echoing keystrokes to the terminal. */
export async function promptPassword(question: string): Promise<string> {
  stdout.write(`${question}: `);
  const isTty = stdin.isTTY === true;
  if (!isTty) {
    const value = await ask("");
    return value.trim();
  }
  stdin.setRawMode(true);
  stdin.resume();
  let buf = "";
  return await new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
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
