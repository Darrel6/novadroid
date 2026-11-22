// Gestion du SDK Android (outils open source de l'AOSP) : emplacement, détection,
// téléchargement des outils en ligne de commande et installation des paquets.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
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
  /** Dossier où NovaDroid installe Java (requis par sdkmanager et avdmanager). */
  jdkDir: string;
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
    jdkDir: p.join(root, "jdk"),
    sdk,
    avdHome: p.join(root, "avd"),
    sdkmanager: p.join(sdk, "cmdline-tools", "latest", "bin", `sdkmanager${bat}`),
    avdmanager: p.join(sdk, "cmdline-tools", "latest", "bin", `avdmanager${bat}`),
    emulator: p.join(sdk, "emulator", `emulator${exe}`),
    adb: p.join(sdk, "platform-tools", `adb${exe}`),
  };
}

/** URL du JDK open source Eclipse Temurin 21 (Adoptium). */
export function jdkUrl(os: HostOS = hostOS(), arch: string = process.arch): string {
  const a = arch === "arm64" ? "aarch64" : "x64";
  return `https://api.adoptium.net/v3/binary/latest/21/ga/${os}/${a}/jdk/hotspot/normal/eclipse`;
}

/** Retrouve le JAVA_HOME du JDK installé par NovaDroid (l'archive contient un sous-dossier versionné). */
export function findJavaHome(
  paths: SdkPaths,
  os: HostOS = hostOS(),
  exists: (p: string) => boolean = existsSync,
  list: (p: string) => string[] = (d) => (existsSync(d) ? readdirSync(d) : []),
): string | undefined {
  const p = os === "windows" ? path.win32 : path.posix;
  const java = os === "windows" ? "java.exe" : "java";
  for (const entry of list(paths.jdkDir)) {
    const home = os === "mac" ? p.join(paths.jdkDir, entry, "Contents", "Home") : p.join(paths.jdkDir, entry);
    if (exists(p.join(home, "bin", java))) return home;
  }
  return undefined;
}

/** Variables d'environnement à passer à tous les outils Android. */
export function sdkEnv(paths: SdkPaths, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const javaHome = findJavaHome(paths);
  const sep = process.platform === "win32" ? ";" : ":";
  const pathKey = Object.keys(base).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const java = javaHome
    ? { JAVA_HOME: javaHome, [pathKey]: `${path.join(javaHome, "bin")}${sep}${base[pathKey] ?? ""}` }
    : {};
  return {
    ...base,
    ...java,
    ANDROID_HOME: paths.sdk,
    ANDROID_SDK_ROOT: paths.sdk,
    ANDROID_AVD_HOME: paths.avdHome,
  };
}

export interface SdkStatus {
  java: boolean;
  cmdlineTools: boolean;
  emulator: boolean;
  platformTools: boolean;
}

export function sdkStatus(paths: SdkPaths, exists: (p: string) => boolean = existsSync): SdkStatus {
  return {
    java: !!findJavaHome(paths, hostOS(), exists),
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
