// Communication avec les instances via ADB : installation d'APK, lancement des jeux, entrées.
import { ChildProcess, spawn } from "node:child_process";
import { Runner, runOk } from "./run";
import { SdkPaths, sdkEnv } from "./sdk";

export interface Device {
  serial: string;
  state: string;
}

export function parseDevices(out: string): Device[] {
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[0])
    .map(([serial, state]) => ({ serial, state }));
}

export function parsePackages(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("package:"))
    .map((l) => l.slice("package:".length))
    .sort();
}

export function parseWmSize(out: string): { width: number; height: number } | undefined {
  // "Override size" prime sur "Physical size" si présent.
  const override = out.match(/Override size:\s*(\d+)x(\d+)/);
  const physical = out.match(/Physical size:\s*(\d+)x(\d+)/);
  const m = override ?? physical;
  return m ? { width: Number(m[1]), height: Number(m[2]) } : undefined;
}

const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;

export function assertPackageName(pkg: string): void {
  if (!PACKAGE_RE.test(pkg)) throw new Error(`Nom de paquet invalide : ${pkg}`);
}

export class Adb {
  constructor(private paths: SdkPaths, private runner: Runner) {}

  private exec(args: string[], timeoutMs?: number) {
    return runOk(this.runner, this.paths.adb, args, { env: sdkEnv(this.paths), timeoutMs });
  }

  async devices(): Promise<Device[]> {
    return parseDevices(await this.exec(["devices"]));
  }

  async shell(serial: string, ...cmd: string[]): Promise<string> {
    return this.exec(["-s", serial, "shell", ...cmd]);
  }

  /** Attend que l'instance ait fini de démarrer Android. */
  async waitForBoot(serial: string, timeoutMs = 300_000, onTick?: () => void): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await this.exec(["-s", serial, "wait-for-device"], timeoutMs);
    while (Date.now() < deadline) {
      const r = await this.runner(this.paths.adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], {
        env: sdkEnv(this.paths),
      });
      if (r.stdout.trim() === "1") return;
      onTick?.();
      await new Promise((res) => setTimeout(res, 2000));
    }
    throw new Error("L'instance n'a pas démarré à temps");
  }

  /** Installe un APK (ou plusieurs APK séparés d'un même jeu) en accordant les permissions. */
  async install(serial: string, apkPaths: string[]): Promise<void> {
    if (!apkPaths.length) throw new Error("Aucun APK fourni");
    const mode = apkPaths.length > 1 ? "install-multiple" : "install";
    await this.exec(["-s", serial, mode, "-r", "-g", ...apkPaths], 600_000);
  }

  async listGames(serial: string): Promise<string[]> {
    return parsePackages(await this.shell(serial, "pm", "list", "packages", "-3"));
  }

  async launchApp(serial: string, pkg: string): Promise<void> {
    assertPackageName(pkg);
    await this.shell(serial, "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1");
  }

  async stopApp(serial: string, pkg: string): Promise<void> {
    assertPackageName(pkg);
    await this.shell(serial, "am", "force-stop", pkg);
  }

  async uninstall(serial: string, pkg: string): Promise<void> {
    assertPackageName(pkg);
    await this.exec(["-s", serial, "uninstall", pkg]);
  }

  async screenSize(serial: string): Promise<{ width: number; height: number }> {
    const size = parseWmSize(await this.shell(serial, "wm", "size"));
    if (!size) throw new Error("Taille d'écran inconnue");
    return size;
  }

  async killEmulator(serial: string): Promise<void> {
    await this.runner(this.paths.adb, ["-s", serial, "emu", "kill"], { env: sdkEnv(this.paths) });
  }

  /** Ouvre un shell persistant pour envoyer des entrées sans relancer adb à chaque touche. */
  openInputSession(serial: string): InputSession {
    const child = spawn(this.paths.adb, ["-s", serial, "shell"], { env: sdkEnv(this.paths), windowsHide: true });
    return new InputSession(child);
  }
}

export class InputSession {
  constructor(private child: ChildProcess) {}

  send(command: string): void {
    const ok =
      /^input (tap|swipe)( \d+)+$/.test(command) ||
      /^input motionevent (DOWN|MOVE|UP) \d+ \d+$/.test(command) ||
      /^input keyevent KEYCODE_[A-Z0-9_]+$/.test(command);
    if (!ok) {
      throw new Error(`Commande d'entrée refusée : ${command}`);
    }
    this.child.stdin?.write(command + "\n");
  }

  close(): void {
    this.child.stdin?.end("exit\n");
  }
}
