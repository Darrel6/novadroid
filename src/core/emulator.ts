// Lancement et suivi des instances de l'émulateur Android (QEMU + WHPX/KVM/HVF).
import { ChildProcess, spawn } from "node:child_process";
import { Runner } from "./run";
import { SdkPaths, sdkEnv } from "./sdk";

export type GpuMode = "host" | "swiftshader_indirect" | "auto";

export interface LaunchOptions {
  port: number;
  gpu: GpuMode;
  /** Démarrage à froid (ignore l'instantané de démarrage rapide). */
  coldBoot?: boolean;
  /** Sans fenêtre (serveur / tests automatisés). */
  headless?: boolean;
  /** Port gRPC de l'émulateur, utilisé pour l'affichage intégré à venir. */
  grpcPort?: number;
}

export function serialForPort(port: number): string {
  return `emulator-${port}`;
}

/** Les ports de console de l'émulateur sont pairs, de 5554 à 5682. */
export function nextFreePort(used: number[]): number {
  for (let p = 5554; p <= 5682; p += 2) if (!used.includes(p)) return p;
  throw new Error("Trop d'instances lancées (limite de 64)");
}

export function emulatorArgs(id: string, o: LaunchOptions): string[] {
  const args = ["-avd", id, "-port", String(o.port), "-gpu", o.gpu, "-accel", "on", "-no-boot-anim"];
  if (o.coldBoot) args.push("-no-snapshot-load");
  if (o.headless) args.push("-no-window");
  if (o.grpcPort) args.push("-grpc", String(o.grpcPort));
  return args;
}

export interface RunningInstance {
  id: string;
  port: number;
  serial: string;
  process: ChildProcess;
}

export function launch(paths: SdkPaths, id: string, o: LaunchOptions, onLog?: (s: string) => void): RunningInstance {
  const child = spawn(paths.emulator, emulatorArgs(id, o), { env: sdkEnv(paths), windowsHide: false });
  child.stdout?.on("data", (d: Buffer) => onLog?.(d.toString()));
  child.stderr?.on("data", (d: Buffer) => onLog?.(d.toString()));
  return { id, port: o.port, serial: serialForPort(o.port), process: child };
}

export interface AccelInfo {
  ok: boolean;
  details: string;
}

/** Vérifie l'accélération matérielle (WHPX/AEHD sous Windows, KVM sous Linux, HVF sous macOS). */
export async function checkAcceleration(paths: SdkPaths, runner: Runner): Promise<AccelInfo> {
  const r = await runner(paths.emulator, ["-accel-check"], { env: sdkEnv(paths), timeoutMs: 30000 });
  const details = (r.stdout + r.stderr).trim();
  return { ok: r.code === 0 || /is installed and usable/i.test(details), details };
}

/** Conseils affichés si l'accélération n'est pas disponible. */
export function accelerationHelp(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return "Active « Plateforme de l'hyperviseur Windows » (Windows Hypervisor Platform) dans « Activer ou désactiver des fonctionnalités Windows », active la virtualisation (VT-x / AMD-V) dans le BIOS, puis redémarre.";
  }
  if (platform === "linux") {
    return "Active la virtualisation dans le BIOS et ajoute ton utilisateur au groupe kvm : sudo usermod -aG kvm $USER (puis reconnecte-toi).";
  }
  return "Hypervisor.framework est utilisé automatiquement sur macOS.";
}

/** Traduit les erreurs connues de l'émulateur en conseils compréhensibles. */
export function explainEmulatorFailure(log: string, platform: NodeJS.Platform = process.platform): string {
  const l = log.toLowerCase();
  if (/whpx|hypervisor|hardware acceleration|accel|vt-x|amd-v|hax|aehd|kvm/.test(l) && /not|unable|fail|require|disabled|unavailable/.test(l)) {
    return `L'accélération matérielle n'est pas disponible. ${accelerationHelp(platform)}`;
  }
  if (/cannot find avd system path|no initial system image|system image.*(not|missing)/.test(l)) {
    return "L'image système Android de cet appareil n'est pas installée. Clique sur « Réparer le moteur Android » dans les réglages.";
  }
  if (/vulkan|opengl|gles|gpu|graphics/.test(l) && /fail|error|crash|unsupported/.test(l)) {
    return "La carte graphique a refusé le rendu. Mets à jour ton pilote graphique ou active « Rendu logiciel » dans les réglages.";
  }
  if (/running multiple emulators with the same avd|already running|lock/.test(l)) {
    return "Cet appareil est déjà en cours d'exécution. Ferme l'autre fenêtre de l'émulateur puis réessaie.";
  }
  if (/not enough (memory|space)|out of memory|insufficient/.test(l)) {
    return "Pas assez de mémoire ou d'espace disque. Choisis le préréglage « Économie » ou libère de la place.";
  }
  return "L'émulateur s'est arrêté pendant le démarrage.";
}

/** Garde les dernières lignes utiles d'un journal. */
export function tailLog(log: string, lines = 6): string {
  return log
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(-lines)
    .join("\n");
}
