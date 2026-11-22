// Processus principal Electron : fenêtre, état des instances et pont IPC vers le cœur.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { readdirSync, readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { Adb, InputSession } from "../core/adb";
import { accelerationHelp, checkAcceleration, explainEmulatorFailure, launch, nextFreePort, RunningInstance, tailLog } from "../core/emulator";
import { installPackages, setupSdk } from "../core/installer";
import { applySettings, createInstance, deleteInstance, InstanceSettings, listInstances } from "../core/instances";
import { KeymapEngine, KeymapProfile, validateProfile } from "../core/keymap";
import { run } from "../core/run";
import { DEFAULT_IMAGE, sdkEnv, sdkPaths, sdkStatus, SystemImage } from "../core/sdk";

const paths = sdkPaths();
const adb = new Adb(paths, run);
const running = new Map<string, RunningInstance & { status: "booting" | "ready" }>();
const input = new Map<
  string,
  { session: InputSession; engine: KeymapEngine; profile: string; screen: { width: number; height: number } }
>();
let win: BrowserWindow | null = null;
const lastLogs = new Map<string, () => string>();

const keymapDir = path.join(paths.root, "keymaps");

function emit(channel: string, payload: unknown) {
  win?.webContents.send(channel, payload);
}

function progress(message: string, percent?: number) {
  emit("progress", { message, percent });
}

function serialOf(id: string): string {
  const r = running.get(id);
  if (!r || r.status !== "ready") throw new Error("L'instance n'est pas démarrée");
  return r.serial;
}

/** Nom de fichier sûr pour un profil. */
export function profileFileName(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "profil"}.json`;
}

function loadProfiles(): KeymapProfile[] {
  mkdirSync(keymapDir, { recursive: true });
  // Copie les profils fournis avec l'application au premier lancement.
  const bundled = path.join(__dirname, "..", "keymaps");
  if (existsSync(bundled)) {
    for (const f of readdirSync(bundled)) {
      const dest = path.join(keymapDir, f);
      if (!existsSync(dest)) copyFileSync(path.join(bundled, f), dest);
    }
  }
  return readdirSync(keymapDir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        return [validateProfile(JSON.parse(readFileSync(path.join(keymapDir, f), "utf8")))];
      } catch {
        return [];
      }
    });
}

/** Capture d'écran de l'instance (sert de fond à l'éditeur de touches). */
function captureScreen(serial: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      paths.adb,
      ["-s", serial, "exec-out", "screencap", "-p"],
      { env: sdkEnv(paths), encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

function instancesView() {
  return listInstances(paths).map((i) => ({
    ...i,
    status: running.get(i.id)?.status ?? "stopped",
  }));
}

function registerIpc() {
  ipcMain.handle("sdk:status", () => ({ ...sdkStatus(paths), root: paths.root }));
  ipcMain.handle("sdk:setup", async (_e, img?: SystemImage) => {
    await setupSdk(paths, run, img ?? DEFAULT_IMAGE, progress);
    return sdkStatus(paths);
  });
  ipcMain.handle("sdk:repair", async (_e, img?: SystemImage) => {
    // Réinstalle ce qui manque, plus l'image de chaque appareil existant.
    await setupSdk(paths, run, img ?? DEFAULT_IMAGE, progress);
    for (const i of listInstances(paths)) {
      const m = i.image?.match(/android-(\d+)[\\/]+([a-z_]+)[\\/]+([a-z0-9_-]+)/);
      if (m) await installPackages(paths, run, { api: Number(m[1]), variant: m[2] as any, abi: m[3] as any }, progress);
    }
    return sdkStatus(paths);
  });
  ipcMain.handle("instance:log", (_e, id: string) => lastLogs.get(id)?.() ?? "");
  ipcMain.handle("accel:check", async () => {
    const info = await checkAcceleration(paths, run);
    return { ...info, help: info.ok ? "" : accelerationHelp() };
  });

  ipcMain.handle("instances:list", () => instancesView());
  ipcMain.handle("instances:create", async (_e, name: string, img?: SystemImage, settings?: InstanceSettings) => {
    // Installe l'image système choisie si elle manque (Android 16 par exemple).
    await installPackages(paths, run, img ?? DEFAULT_IMAGE, progress);
    await createInstance(paths, run, name, img ?? DEFAULT_IMAGE, settings);
    return instancesView();
  });
  ipcMain.handle("instances:settings", (_e, id: string, settings: InstanceSettings) => {
    if (running.has(id)) throw new Error("Arrête l'instance avant de modifier ses réglages");
    applySettings(paths, id, settings);
    return instancesView();
  });
  ipcMain.handle("instances:delete", (_e, id: string) => {
    if (running.has(id)) throw new Error("Arrête l'instance avant de la supprimer");
    deleteInstance(paths, id);
    return instancesView();
  });

  ipcMain.handle("instance:start", async (_e, id: string, opts?: { coldBoot?: boolean; gpu?: "host" | "auto" | "swiftshader_indirect" }) => {
    if (running.has(id)) return instancesView();
    const status = sdkStatus(paths);
    if (!status.emulator || !status.platformTools) {
      throw new Error("Le moteur Android n'est pas complètement installé. Ouvre les réglages et clique sur « Réparer le moteur Android ».");
    }
    const accel = await checkAcceleration(paths, run).catch(() => undefined);
    if (accel && !accel.ok) throw new Error(`L'accélération matérielle n'est pas active. ${accelerationHelp()}\n\nRésultat de la vérification :\n${tailLog(accel.details, 10)}`);
    const port = nextFreePort([...running.values()].map((r) => r.port));
    let log = "";
    const gpu = opts?.gpu ?? (process.env.NOVADROID_GPU as any) ?? "host";
    const inst = launch(paths, id, { port, gpu, coldBoot: opts?.coldBoot }, (chunk) => {
      log = (log + chunk).slice(-20000);
      emit("log", { id, log: chunk });
    });
    lastLogs.set(id, () => log);
    running.set(id, { ...inst, status: "booting" });
    emit("instances", instancesView());
    inst.process.on("exit", () => {
      running.delete(id);
      input.get(id)?.session.close();
      input.delete(id);
      emit("instances", instancesView());
    });
    // Si l'émulateur s'arrête pendant le démarrage, on renvoie tout de suite son erreur.
    const crashed = new Promise<never>((_res, rej) => {
      inst.process.once("exit", (code) => rej(new Error(`${explainEmulatorFailure(log)}\n\nDétail (code ${code}) :\n${tailLog(log)}`)));
      inst.process.once("error", (err) => rej(new Error(`Impossible de lancer l'émulateur : ${err.message}`)));
    });
    try {
      await Promise.race([adb.waitForBoot(inst.serial), crashed]);
    } catch (err) {
      inst.process.kill();
      throw err;
    }
    const r = running.get(id);
    if (r) r.status = "ready";
    emit("instances", instancesView());
    return instancesView();
  });
  ipcMain.handle("instance:stop", async (_e, id: string) => {
    const r = running.get(id);
    if (r) {
      await adb.killEmulator(r.serial);
      setTimeout(() => r.process.kill(), 10_000).unref();
    }
    return instancesView();
  });

  ipcMain.handle("apps:pick", async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: "Choisir un jeu Android",
      filters: [{ name: "Applications Android", extensions: ["apk"] }],
      properties: ["openFile", "multiSelections"],
    });
    return res.canceled ? [] : res.filePaths;
  });
  ipcMain.handle("apps:install", async (_e, id: string, apks: string[]) => {
    const bad = apks.find((a) => !a.toLowerCase().endsWith(".apk"));
    if (bad) throw new Error(`Ce fichier n'est pas un APK : ${bad}`);
    progress("Installation du jeu…");
    await adb.install(serialOf(id), apks);
    progress("Jeu installé", 100);
    return adb.listGames(serialOf(id));
  });
  ipcMain.handle("apps:list", (_e, id: string) => adb.listGames(serialOf(id)));
  ipcMain.handle("apps:launch", (_e, id: string, pkg: string) => adb.launchApp(serialOf(id), pkg));
  ipcMain.handle("apps:stop", (_e, id: string, pkg: string) => adb.stopApp(serialOf(id), pkg));
  ipcMain.handle("apps:uninstall", async (_e, id: string, pkg: string) => {
    await adb.uninstall(serialOf(id), pkg);
    return adb.listGames(serialOf(id));
  });

  ipcMain.handle("screen:capture", async (_e, id: string) => {
    const png = await captureScreen(serialOf(id));
    return `data:image/png;base64,${png.toString("base64")}`;
  });

  ipcMain.handle("keymap:profiles", () => loadProfiles());
  ipcMain.handle("keymap:save", (_e, raw: unknown) => {
    const profile = validateProfile(raw);
    mkdirSync(keymapDir, { recursive: true });
    const file = profileFileName(profile.name);
    writeFileSync(path.join(keymapDir, file), JSON.stringify(profile, null, 2));
    // Recharge le moteur des instances qui utilisent ce profil.
    for (const ctx of input.values()) if (ctx.profile === profile.name) ctx.engine = new KeymapEngine(profile, ctx.screen);
    return loadProfiles();
  });
  ipcMain.handle("keymap:openFolder", () => shell.openPath(keymapDir));
  ipcMain.handle("keymap:activate", async (_e, id: string, profileName: string) => {
    const serial = serialOf(id);
    const profile = loadProfiles().find((p) => p.name === profileName);
    if (!profile) throw new Error("Profil introuvable");
    const screen = await adb.screenSize(serial);
    input.get(id)?.session.close();
    input.set(id, {
      session: adb.openInputSession(serial),
      engine: new KeymapEngine(profile, screen),
      profile: profile.name,
      screen,
    });
    return screen;
  });
  ipcMain.on("keymap:key", (_e, id: string, key: string, down: boolean) => {
    const ctx = input.get(id);
    if (!ctx) return;
    const cmds = down ? ctx.engine.keyDown(key) : ctx.engine.keyUp(key);
    for (const c of cmds) ctx.session.send(c);
  });
  ipcMain.on("keymap:release", (_e, id: string) => {
    const ctx = input.get(id);
    if (ctx) for (const c of ctx.engine.releaseAll()) ctx.session.send(c);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "NovaDroid",
    icon: path.join(__dirname, "..", "icon.png"),
    backgroundColor: "#15132b",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.on("closed", () => (win = null));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
});

app.on("before-quit", () => {
  for (const r of running.values()) r.process.kill();
});

app.on("window-all-closed", () => app.quit());
