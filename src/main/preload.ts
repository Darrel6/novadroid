// Pont sécurisé entre l'interface et le processus principal.
import { contextBridge, ipcRenderer, webUtils } from "electron";

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("nova", {
  sdkStatus: () => invoke("sdk:status"),
  setupSdk: (img?: unknown) => invoke("sdk:setup", img),
  checkAccel: () => invoke("accel:check"),

  listInstances: () => invoke("instances:list"),
  createInstance: (name: string, img?: unknown, settings?: unknown) => invoke("instances:create", name, img, settings),
  saveSettings: (id: string, settings: unknown) => invoke("instances:settings", id, settings),
  deleteInstance: (id: string) => invoke("instances:delete", id),
  start: (id: string, opts?: unknown) => invoke("instance:start", id, opts),
  stop: (id: string) => invoke("instance:stop", id),

  pickApks: () => invoke("apps:pick"),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  install: (id: string, apks: string[]) => invoke("apps:install", id, apks),
  listApps: (id: string) => invoke("apps:list", id),
  launchApp: (id: string, pkg: string) => invoke("apps:launch", id, pkg),
  stopApp: (id: string, pkg: string) => invoke("apps:stop", id, pkg),
  uninstall: (id: string, pkg: string) => invoke("apps:uninstall", id, pkg),

  captureScreen: (id: string) => invoke("screen:capture", id),
  profiles: () => invoke("keymap:profiles"),
  saveProfile: (profile: unknown) => invoke("keymap:save", profile),
  openKeymapFolder: () => invoke("keymap:openFolder"),
  activateKeymap: (id: string, name: string) => invoke("keymap:activate", id, name),
  key: (id: string, key: string, down: boolean) => ipcRenderer.send("keymap:key", id, key, down),
  releaseKeys: (id: string) => ipcRenderer.send("keymap:release", id),

  on: (channel: "progress" | "instances" | "log", cb: (payload: any) => void) => {
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
});
