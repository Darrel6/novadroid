// Processus principal Electron : fenêtre, état des instances et pont IPC vers le cœur.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { readdirSync, readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { Adb, InputSession } from "../core/adb";
import { accelerationHelp, checkAcceleration, launch, nextFreePort, RunningInstance } from "../core/emulator";
import { setupSdk } from "../core/installer";
import { applySettings, createInstance, deleteInstance, InstanceSettings, listInstances } from "../core/instances";
import { KeymapEngine, KeymapProfile, validateProfile } from "../core/keymap";
import { run } from "../core/run";
import { DEFAULT_IMAGE, sdkPaths, sdkStatus, SystemImage } from "../core/sdk";

const paths = sdkPaths();
const adb = new Adb(paths, run);
const running = new Map<string, RunningInstance & { status: "booting" | "ready" }>();
const input = new Map<string, { session: InputSession; engine: KeymapEngine }>();
let win: BrowserWindow | null = null;

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
  ipcMain.handle("accel:check", async () => {
    const info = await checkAcceleration(paths, run);
    return { ...info, help: info.ok ? "" : accelerationHelp() };
  });

  ipcMain.handle("instances:list", () => instancesView());
  ipcMain.handle("instances:create", async (_e, name: string, img?: SystemImage, settings?: InstanceSettings) => {
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

  ipcMain.handle("instance:start", async (_e, id: string, opts?: { coldBoot?: boolean; gpu?: "host" | "auto" }) => {
    if (running.has(id)) return instancesView();
    const port = nextFreePort([...running.values()].map((r) => r.port));
    const inst = launch(paths, id, { port, gpu: opts?.gpu ?? "host", coldBoot: opts?.coldBoot }, (log) =>
      emit("log", { id, log }),
    );
    running.set(id, { ...inst, status: "booting" });
    emit("instances", instancesView());
    inst.process.on("exit", () => {
      running.delete(id);
      input.get(id)?.session.close();
      input.delete(id);
      emit("instances", instancesView());
    });
    try {
      await adb.waitForBoot(inst.serial);
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

  ipcMain.handle("keymap:profiles", () => loadProfiles());
  ipcMain.handle("keymap:openFolder", () => shell.openPath(keymapDir));
  ipcMain.handle("keymap:activate", async (_e, id: string, profileName: string) => {
    const serial = serialOf(id);
    const profile = loadProfiles().find((p) => p.name === profileName);
    if (!profile) throw new Error("Profil introuvable");
    const screen = await adb.screenSize(serial);
    input.get(id)?.session.close();
    input.set(id, { session: adb.openInputSession(serial), engine: new KeymapEngine(profile, screen) });
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
    backgroundColor: "#0e1116",
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
