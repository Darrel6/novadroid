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
  return { ok: r.code === 0 && /is installed and usable|is usable|accel:\s*0/i.test(details), details };
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
