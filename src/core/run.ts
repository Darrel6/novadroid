// Petit utilitaire pour exécuter les outils Android et récupérer leur sortie.
import { spawn, SpawnOptions } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  /** Texte envoyé sur l'entrée standard (ex. "y\n" pour accepter les licences). */
  input?: string;
  onOutput?: (chunk: string) => void;
  timeoutMs?: number;
}

/** Met entre guillemets un argument pour cmd.exe s'il contient des espaces ou caractères spéciaux. */
export function quoteForCmd(arg: string): string {
  return /[\s&()^|<>"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

export const run: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    // Les scripts .bat de Windows doivent passer par le shell, qui ne protège pas les espaces.
    const viaShell = process.platform === "win32" && cmd.toLowerCase().endsWith(".bat");
    const spawnOpts: SpawnOptions = { env: opts.env, shell: viaShell, windowsHide: true };
    const child = viaShell
      ? spawn(quoteForCmd(cmd), args.map(quoteForCmd), spawnOpts)
      : spawn(cmd, args, spawnOpts);
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) timer = setTimeout(() => child.kill(), opts.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      opts.onOutput?.(s);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      opts.onOutput?.(s);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });

export async function runOk(runner: Runner, cmd: string, args: string[], opts?: RunOptions): Promise<string> {
  const r = await runner(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} a échoué (code ${r.code}) : ${(r.stderr || r.stdout).trim().slice(-500)}`);
  }
  return r.stdout;
}
