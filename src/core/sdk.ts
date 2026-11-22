// Gestion du SDK Android (outils open source de l'AOSP) : emplacement, détection,
// téléchargement des outils en ligne de commande et installation des paquets.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type HostOS = "windows" | "linux" | "mac";

export function hostOS(platform: NodeJS.Platform = process.platform): HostOS {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "mac";
  return "linux";
}

/** Version des "command line tools" Android. Modifiable via NOVADROID_CMDLINE_TOOLS_BUILD. */
export const CMDLINE_TOOLS_BUILD = process.env.NOVADROID_CMDLINE_TOOLS_BUILD ?? "13114758";

export function cmdlineToolsUrl(os: HostOS = hostOS(), build = CMDLINE_TOOLS_BUILD): string {
  const tag = os === "windows" ? "win" : os === "mac" ? "mac" : "linux";
  return `https://dl.google.com/android/repository/commandlinetools-${tag}-${build}_latest.zip`;
}

/** Dossier de données de NovaDroid (SDK, instances, profils). */
export function dataRoot(os: HostOS = hostOS(), env: NodeJS.ProcessEnv = process.env): string {
  if (env.NOVADROID_HOME) return env.NOVADROID_HOME;
  if (os === "windows") return path.join(env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "NovaDroid");
  if (os === "mac") return path.join(homedir(), "Library", "Application Support", "NovaDroid");
  return path.join(env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"), "novadroid");
}

export interface SdkPaths {
  root: string;
  sdk: string;
  avdHome: string;
  sdkmanager: string;
  avdmanager: string;
  emulator: string;
  adb: string;
}

export function sdkPaths(os: HostOS = hostOS(), root = dataRoot(os)): SdkPaths {
  const p = os === "windows" ? path.win32 : path.posix;
  const sdk = p.join(root, "sdk");
  const bat = os === "windows" ? ".bat" : "";
  const exe = os === "windows" ? ".exe" : "";
  return {
    root,
    sdk,
    avdHome: p.join(root, "avd"),
    sdkmanager: p.join(sdk, "cmdline-tools", "latest", "bin", `sdkmanager${bat}`),
    avdmanager: p.join(sdk, "cmdline-tools", "latest", "bin", `avdmanager${bat}`),
    emulator: p.join(sdk, "emulator", `emulator${exe}`),
    adb: p.join(sdk, "platform-tools", `adb${exe}`),
  };
}

/** Variables d'environnement à passer à tous les outils Android. */
export function sdkEnv(paths: SdkPaths, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    ANDROID_HOME: paths.sdk,
    ANDROID_SDK_ROOT: paths.sdk,
    ANDROID_AVD_HOME: paths.avdHome,
  };
}

export interface SdkStatus {
  cmdlineTools: boolean;
  emulator: boolean;
  platformTools: boolean;
}

export function sdkStatus(paths: SdkPaths, exists: (p: string) => boolean = existsSync): SdkStatus {
  return {
    cmdlineTools: exists(paths.sdkmanager),
    emulator: exists(paths.emulator),
    platformTools: exists(paths.adb),
  };
}

export function ensureDirs(paths: SdkPaths): void {
  for (const d of [paths.root, paths.sdk, paths.avdHome]) mkdirSync(d, { recursive: true });
}

/** Image système Android à utiliser pour une instance. */
export interface SystemImage {
  api: number;
  /** "google_apis_playstore" (Play Store, recommandé pour les jeux) ou "default" (AOSP pur). */
  variant: "google_apis_playstore" | "google_apis" | "default";
  abi: "x86_64" | "arm64-v8a";
}

export function defaultAbi(arch: string = process.arch): SystemImage["abi"] {
  return arch === "arm64" ? "arm64-v8a" : "x86_64";
}

export const DEFAULT_IMAGE: SystemImage = { api: 35, variant: "google_apis_playstore", abi: defaultAbi() };

export function systemImagePackage(img: SystemImage): string {
  return `system-images;android-${img.api};${img.variant};${img.abi}`;
}

/** Paquets nécessaires pour faire tourner une instance. */
export function requiredPackages(img: SystemImage): string[] {
  return ["platform-tools", "emulator", `platforms;android-${img.api}`, systemImagePackage(img)];
}
