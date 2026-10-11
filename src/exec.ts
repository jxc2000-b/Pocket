// Promise wrapper around child_process.execFile. Always an argument vector,
// never a shell string, so user text cannot be interpreted as a command.

import { execFile as execFileCb } from "node:child_process";

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export const execFileAsync: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFileCb(file, args, { ...options, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
