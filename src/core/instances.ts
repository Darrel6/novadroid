// Instances = appareils virtuels Android (AVD) gérés par NovaDroid.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Runner, runOk } from "./run";
import { SdkPaths, sdkEnv, SystemImage, systemImagePackage } from "./sdk";

export interface InstanceSettings {
  ramMb: number;
  cpuCores: number;
  /** Résolution de l'écran en mode paysage (jeux). */
  width: number;
  height: number;
  dpi: number;
  dataPartitionGb: number;
}

export const DEFAULT_SETTINGS: InstanceSettings = {
  ramMb: 4096,
  cpuCores: 4,
  width: 1920,
  height: 1080,
  dpi: 320,
  dataPartitionGb: 16,
};

export interface Instance {
  id: string;
  /** Nom choisi par l'utilisateur, avec accents et apostrophes. */
  name: string;
  path: string;
  image?: string;
  settings: InstanceSettings;
}

/** Transforme un nom libre en identifiant d'AVD valide. */
export function toInstanceId(name: string): string {
  const id = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!id) throw new Error("Nom d'instance invalide");
  return id;
}

export function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=][^=]*?)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function serializeIni(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
}

/** Réglages matériels écrits dans le config.ini de l'AVD. */
export function hardwareConfig(s: InstanceSettings): Record<string, string> {
  return {
    "hw.ramSize": String(s.ramMb),
    "hw.cpu.ncore": String(s.cpuCores),
    "hw.lcd.width": String(s.width),
    "hw.lcd.height": String(s.height),
    "hw.lcd.density": String(s.dpi),
    "hw.initialOrientation": s.width > s.height ? "landscape" : "portrait",
    "disk.dataPartition.size": `${s.dataPartitionGb}G`,
    // Rendu GPU par la carte graphique de l'hôte (Vulkan / OpenGL).
    "hw.gpu.enabled": "yes",
    "hw.gpu.mode": "host",
    "hw.keyboard": "yes",
    "hw.mainKeys": "no",
    "hw.audioInput": "yes",
    "hw.gltransport": "pipe",
    "fastboot.forceColdBoot": "no",
    "showDeviceFrame": "no",
  };
}

export function settingsFromConfig(cfg: Record<string, string>): InstanceSettings {
  const num = (k: string, d: number) => {
    const n = parseInt(cfg[k] ?? "", 10);
    return Number.isFinite(n) ? n : d;
  };
  return {
    ramMb: num("hw.ramSize", DEFAULT_SETTINGS.ramMb),
    cpuCores: num("hw.cpu.ncore", DEFAULT_SETTINGS.cpuCores),
    width: num("hw.lcd.width", DEFAULT_SETTINGS.width),
    height: num("hw.lcd.height", DEFAULT_SETTINGS.height),
    dpi: num("hw.lcd.density", DEFAULT_SETTINGS.dpi),
    dataPartitionGb: num("disk.dataPartition.size", DEFAULT_SETTINGS.dataPartitionGb),
  };
}

function configPath(paths: SdkPaths, id: string): string {
  return path.join(paths.avdHome, `${id}.avd`, "config.ini");
}

export function applySettings(paths: SdkPaths, id: string, s: InstanceSettings, displayName?: string): void {
  const file = configPath(paths, id);
  const cfg = existsSync(file) ? parseIni(readFileSync(file, "utf8")) : {};
  const extra: Record<string, string> = displayName ? { "avd.ini.displayname": displayName.replace(/[\r\n=]/g, " ").trim() } : {};
  writeFileSync(file, serializeIni({ ...cfg, ...hardwareConfig(s), ...extra }));
}

export async function createInstance(
  paths: SdkPaths,
  runner: Runner,
  name: string,
  img: SystemImage,
  settings: InstanceSettings = DEFAULT_SETTINGS,
): Promise<Instance> {
  const id = toInstanceId(name);
  await runOk(
    runner,
    paths.avdmanager,
    ["create", "avd", "--name", id, "--package", systemImagePackage(img), "--device", "pixel_7", "--force"],
    // avdmanager demande s'il faut un profil matériel personnalisé : on répond non.
    { env: sdkEnv(paths), input: "no\n" },
  );
  applySettings(paths, id, settings, name);
  return { id, name, path: path.join(paths.avdHome, `${id}.avd`), image: systemImagePackage(img), settings };
}

export function listInstances(paths: SdkPaths): Instance[] {
  if (!existsSync(paths.avdHome)) return [];
  return readdirSync(paths.avdHome)
    .filter((f) => f.endsWith(".ini"))
    .map((f) => f.slice(0, -4))
    .filter((id) => existsSync(configPath(paths, id)))
    .map((id) => {
      const cfg = parseIni(readFileSync(configPath(paths, id), "utf8"));
      return {
        id,
        name: cfg["avd.ini.displayname"] || id.replace(/_/g, " "),
        path: path.join(paths.avdHome, `${id}.avd`),
        image: cfg["image.sysdir.1"],
        settings: settingsFromConfig(cfg),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function deleteInstance(paths: SdkPaths, id: string): void {
  rmSync(path.join(paths.avdHome, `${id}.avd`), { recursive: true, force: true });
  rmSync(path.join(paths.avdHome, `${id}.ini`), { force: true });
}
