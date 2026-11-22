// Installation automatique du SDK : télécharge les outils en ligne de commande,
// accepte les licences et installe l'émulateur, ADB et l'image système.
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Runner, runOk } from "./run";
import {
  cmdlineToolsUrl,
  ensureDirs,
  findJavaHome,
  hostOS,
  HostOS,
  jdkUrl,
  requiredPackages,
  SdkPaths,
  sdkEnv,
  SystemImage,
} from "./sdk";

export type Progress = (message: string, percent?: number) => void;

export async function download(url: string, dest: string, onProgress: Progress, label = "Téléchargement des outils Android"): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${res.status}) : ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let received = 0;
  const body = Readable.fromWeb(res.body as any);
  body.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (total) onProgress(label, Math.round((received / total) * 100));
  });
  await pipeline(body, createWriteStream(dest));
}

/** Commande d'extraction d'un zip : tar (bsdtar) est inclus dans Windows 10+ et macOS. */
export function unzipCommand(os: HostOS, zip: string, destDir: string): [string, string[]] {
  if (os === "linux") return ["unzip", ["-q", "-o", zip, "-d", destDir]];
  return ["tar", ["-xf", zip, "-C", destDir]];
}

/** Commande d'extraction de l'archive du JDK (zip sous Windows, tar.gz ailleurs). */
export function untarJdkCommand(os: HostOS, archive: string, destDir: string): [string, string[]] {
  if (os === "windows") return ["tar", ["-xf", archive, "-C", destDir]];
  return ["tar", ["-xzf", archive, "-C", destDir]];
}

/** Installe Java 21 (Eclipse Temurin, open source) : sdkmanager et avdmanager en ont besoin. */
export async function installJdk(paths: SdkPaths, runner: Runner, onProgress: Progress): Promise<void> {
  ensureDirs(paths);
  const os = hostOS();
  const archive = path.join(paths.root, os === "windows" ? "jdk.zip" : "jdk.tar.gz");
  await download(jdkUrl(os), archive, onProgress, "Téléchargement de Java");
  onProgress("Installation de Java");
  rmSync(paths.jdkDir, { recursive: true, force: true });
  mkdirSync(paths.jdkDir, { recursive: true });
  const [cmd, args] = untarJdkCommand(os, archive, paths.jdkDir);
  await runOk(runner, cmd, args);
  rmSync(archive, { force: true });
  if (!findJavaHome(paths)) throw new Error("Java a été téléchargé mais reste introuvable après l'extraction");
}

export async function installCmdlineTools(paths: SdkPaths, runner: Runner, onProgress: Progress): Promise<void> {
  ensureDirs(paths);
  const os = hostOS();
  const zip = path.join(paths.root, "cmdline-tools.zip");
  await download(cmdlineToolsUrl(os), zip, onProgress);
  onProgress("Extraction des outils Android");
  const tmp = path.join(paths.sdk, "cmdline-tools", "_tmp");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const [cmd, args] = unzipCommand(os, zip, tmp);
  await runOk(runner, cmd, args);
  const latest = path.join(paths.sdk, "cmdline-tools", "latest");
  rmSync(latest, { recursive: true, force: true });
  // L'archive contient un dossier "cmdline-tools" qu'on renomme en "latest".
  renameSync(path.join(tmp, "cmdline-tools"), latest);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(zip, { force: true });
}

export async function acceptLicenses(paths: SdkPaths, runner: Runner): Promise<void> {
  await runner(paths.sdkmanager, [`--sdk_root=${paths.sdk}`, "--licenses"], {
    env: sdkEnv(paths),
    input: "y\n".repeat(30),
  });
}

/** Lit le pourcentage affiché par sdkmanager ("[====   ] 42% ..."). */
export function parseSdkmanagerPercent(chunk: string): number | undefined {
  const matches = [...chunk.matchAll(/(\d{1,3})%/g)];
  if (!matches.length) return undefined;
  const n = Number(matches[matches.length - 1][1]);
  return n >= 0 && n <= 100 ? n : undefined;
}

export async function installPackages(
  paths: SdkPaths,
  runner: Runner,
  img: SystemImage,
  onProgress: Progress,
): Promise<void> {
  const pkgs = requiredPackages(img);
  onProgress(`Installation : ${pkgs.join(", ")}`, 0);
  await runOk(runner, paths.sdkmanager, [`--sdk_root=${paths.sdk}`, ...pkgs], {
    env: sdkEnv(paths),
    input: "y\n".repeat(10),
    onOutput: (c) => {
      const pct = parseSdkmanagerPercent(c);
      if (pct !== undefined) onProgress("Installation des composants Android", pct);
    },
  });
}

/** Installe tout ce qui manque pour lancer une instance avec l'image donnée. */
export async function setupSdk(
  paths: SdkPaths,
  runner: Runner,
  img: SystemImage,
  onProgress: Progress,
): Promise<void> {
  if (!findJavaHome(paths)) await installJdk(paths, runner, onProgress);
  if (!existsSync(paths.sdkmanager)) await installCmdlineTools(paths, runner, onProgress);
  onProgress("Acceptation des licences du SDK Android");
  await acceptLicenses(paths, runner);
  await installPackages(paths, runner, img, onProgress);
  onProgress("SDK prêt", 100);
}
