// Interface de NovaDroid (script de page, sans accès direct à Node).

type Status = "stopped" | "booting" | "ready";
interface UiInstance {
  id: string;
  name?: string;
  status: Status;
  image?: string;
  settings: Settings;
}
interface Settings {
  ramMb: number;
  cpuCores: number;
  width: number;
  height: number;
  dpi: number;
  dataPartitionGb: number;
}
interface UiBinding {
  action: "tap" | "hold" | "keyevent" | "joystick";
  key?: string;
  code?: string;
  label?: string;
  x?: number;
  y?: number;
  up?: string;
  down?: string;
  left?: string;
  right?: string;
  radius?: number;
}
interface UiProfile {
  name: string;
  package?: string;
  bindings: UiBinding[];
}

declare const nova: any;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};
const icon = (name: string, cls = "ico") => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", cls);
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", `#i-${name}`);
  s.append(u);
  return s;
};

const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(k);
      return v ? (JSON.parse(v) as T) : d;
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* stockage indisponible : ce n'est qu'un confort */
    }
  },
};

const ui = {
  sdkReady: false,
  instances: [] as UiInstance[],
  device: store.get<string | null>("device", null),
  games: [] as string[],
  selectedGame: null as string | null,
  profiles: [] as UiProfile[],
  profile: null as UiProfile | null,
  dirty: false,
  selBinding: -1,
  keysLive: false,
  bootStart: 0,
  bootError: null as string | null,
  softwareGpu: store.get<boolean>("softwareGpu", false),
};

// ---------- Utilitaires ----------
const STATUS_TEXT: Record<Status, string> = { stopped: "Éteint", booting: "Démarrage…", ready: "Allumé" };
const NOISE = new Set(["com", "org", "net", "io", "android", "game", "games", "app", "apps", "mobile", "global", "free", "studio", "inc", "gp"]);

/** Nom lisible à partir du nom de paquet (com.studio.super_racer -> Super Racer). */
function gameName(pkg: string): string {
  const parts = pkg.split(".").filter((p) => !NOISE.has(p.toLowerCase()));
  const pick = parts[parts.length - 1] ?? pkg;
  return pick
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
function hueOf(text: string): number {
  let x = 0;
  for (const c of text) x = (x * 31 + c.charCodeAt(0)) % 360;
  return x;
}
function cover(pkg: string, cls = "cover"): HTMLElement {
  const el = h("div", cls);
  el.style.setProperty("--ch", String(hueOf(pkg)));
  el.append(h("span", "glyph", gameName(pkg).charAt(0)));
  return el;
}
function setHue(hue: number) {
  document.documentElement.style.setProperty("--h", String(hue));
}
function deviceLabel(id: string) {
  return ui.instances.find((i) => i.id === id)?.name ?? id.replace(/_/g, " ");
}
function androidLabel(image?: string) {
  const m = image?.match(/android-(\d+)/);
  const v: Record<string, string> = { "34": "14", "35": "15", "36": "16" };
  const ver = m ? v[m[1]] ?? m[1] : "";
  const play = image?.includes("playstore") ? " avec Play Store" : image?.includes("default") ? " open source" : "";
  return ver ? `Android ${ver}${play}` : "Android";
}

// ---------- Notifications ----------
let progressToast: HTMLElement | null = null;
function toast(title: string, opts: { detail?: string; error?: boolean; percent?: number; sticky?: boolean } = {}) {
  const box = $("toasts");
  let t = opts.percent !== undefined ? progressToast : null;
  if (!t) {
    t = h("div", "toast" + (opts.error ? " error" : ""));
    box.append(t);
  }
  t.replaceChildren(h("strong", "", title));
  if (opts.detail) t.append(h("span", "", opts.detail));
  if (opts.percent !== undefined) {
    const bar = h("div", "bar");
    const fill = h("span");
    fill.style.width = `${opts.percent}%`;
    bar.append(fill);
    t.append(bar);
    progressToast = opts.percent < 100 ? t : null;
  }
  if (!opts.sticky && !(opts.percent !== undefined && opts.percent < 100)) {
    const el = t;
    setTimeout(() => el.remove(), opts.error ? 7000 : 3000);
  }
  return t;
}

function cleanError(e: any) {
  return String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
async function attempt<T = any>(fn: () => Promise<T>, what = "Action impossible"): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    toast(what, { detail: cleanError(e), error: true });
    return undefined;
  }
}

// ---------- Navigation ----------
function current(): UiInstance | undefined {
  return ui.instances.find((i) => i.id === ui.device);
}
function go(view: "setup" | "library" | "controls") {
  document.body.dataset.view = view;
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => {
    if (t.dataset.go === view) t.setAttribute("aria-current", "page");
    else t.removeAttribute("aria-current");
  });
  if (view === "controls") renderStage();
  if (view !== "controls") setLive(false);
}
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => (t.onclick = () => go(t.dataset.go as any)));

function needsSetup() {
  return !ui.sdkReady || ui.instances.length === 0;
}

// ---------- Premier lancement ----------
function renderSetup() {
  const engine = $("step-engine");
  const device = $("step-device");
  const game = $("step-game");
  for (const s of [engine, device, game]) s.classList.remove("current", "done");
  if (!ui.sdkReady) engine.classList.add("current");
  else {
    engine.classList.add("done");
    if (!ui.instances.length) device.classList.add("current");
    else {
      device.classList.add("done");
      game.classList.add("current");
    }
  }
}
$("setup-engine").onclick = async () => {
  const btn = $<HTMLButtonElement>("setup-engine");
  btn.disabled = true;
  btn.textContent = "Installation…";
  $("step-engine").querySelector<HTMLElement>(".step-progress")!.hidden = false;
  const ok = await attempt(() => nova.setupSdk(), "L'installation a échoué");
  btn.disabled = false;
  btn.textContent = "Réessayer";
  if (ok) {
    ui.sdkReady = true;
    renderAll();
    checkAccel();
  }
};
$("setup-device").onclick = () => openNewDialog();

nova.on("progress", (p: { message: string; percent?: number }) => {
  const step = $("step-engine").querySelector<HTMLElement>(".step-progress")!;
  if (document.body.dataset.view === "setup" && !step.hidden) {
    (step.querySelector(".bar span") as HTMLElement).style.width = `${p.percent ?? 0}%`;
    step.querySelector("small")!.textContent = p.percent !== undefined ? `${p.message}, ${p.percent} %` : p.message;
  } else {
    toast(p.message, { percent: p.percent ?? 0 });
  }
});
nova.on("instances", (list: UiInstance[]) => {
  ui.instances = list;
  renderAll();
});

async function checkAccel() {
  const a = await attempt(() => nova.checkAccel());
  const warn = $("accel-warn");
  warn.hidden = !a || a.ok;
  if (a && !a.ok) warn.textContent = `L'accélération matérielle n'est pas active, les jeux seraient très lents. ${a.help}`;
  renderFacts(a);
}

// ---------- Appareil (barre du haut) ----------
function renderDevice() {
  const inst = current();
  $("device-name").textContent = inst ? deviceLabel(inst.id) : "Aucun appareil";
  $("device-status").textContent = inst ? `${STATUS_TEXT[inst.status]}, ${androidLabel(inst.image)}` : "";
  $("device-dot").className = `dot ${inst?.status ?? ""}`;
  const power = $<HTMLButtonElement>("power-btn");
  power.disabled = !inst || inst.status === "booting";
  power.classList.toggle("on", inst?.status === "ready");
  power.title = inst?.status === "ready" ? "Éteindre l'appareil" : "Démarrer l'appareil";

  const list = $("device-list");
  list.replaceChildren();
  for (const i of ui.instances) {
    const li = h("li");
    const b = h("button");
    b.setAttribute("aria-current", String(i.id === ui.device));
    b.append(h("span", `dot ${i.status}`), h("span", "", deviceLabel(i.id)), h("small", "", STATUS_TEXT[i.status]));
    b.onclick = () => {
      selectDevice(i.id);
      toggleMenu(false);
    };
    li.append(b);
    list.append(li);
  }
}
function toggleMenu(open?: boolean) {
  const menu = $("device-menu");
  const show = open ?? menu.hidden;
  menu.hidden = !show;
  $("device-btn").setAttribute("aria-expanded", String(show));
}
$("device-btn").onclick = (e) => {
  e.stopPropagation();
  toggleMenu();
};
document.addEventListener("click", (e) => {
  if (!$("device-menu").contains(e.target as Node)) toggleMenu(false);
});
$("menu-new").onclick = () => {
  toggleMenu(false);
  openNewDialog();
};
$("power-btn").onclick = () => {
  const inst = current();
  if (!inst) return;
  if (inst.status === "ready") stopDevice();
  else startDevice();
};

async function selectDevice(id: string) {
  ui.device = id;
  store.set("device", id);
  ui.games = [];
  renderAll();
  await refreshGames();
}

const BOOT_STEPS: [number, string][] = [
  [0, "Démarrage de la machine virtuelle…"],
  [6, "Chargement d'Android…"],
  [20, "Préparation des applications…"],
  [45, "Presque prêt, le premier démarrage est plus long…"],
];
let bootTimer: number | undefined;
function tickBoot() {
  const s = (Date.now() - ui.bootStart) / 1000;
  const step = [...BOOT_STEPS].reverse().find(([t]) => s >= t)!;
  $("boot-text").textContent = `${step[1]} ${Math.floor(s)} s`;
}

async function startDevice(opts: { software?: boolean } = {}): Promise<boolean> {
  const inst = current();
  if (!inst) return false;
  if (inst.status === "ready") return true;
  ui.bootStart = Date.now();
  ui.bootError = null;
  inst.status = "booting";
  renderAll();
  clearInterval(bootTimer);
  bootTimer = window.setInterval(tickBoot, 500);
  tickBoot();
  const gpu = opts.software || ui.softwareGpu ? "swiftshader_indirect" : "host";
  let list: UiInstance[] | undefined;
  try {
    list = await nova.start(inst.id, { gpu });
  } catch (e) {
    ui.bootError = cleanError(e);
  }
  clearInterval(bootTimer);
  if (list) ui.instances = list;
  else inst.status = "stopped";
  renderAll();
  if (!list) return false;
  toast(`${deviceLabel(inst.id)} est prêt`);
  await refreshGames();
  activateProfile();
  return true;
}
async function stopDevice() {
  const inst = current();
  if (inst) await attempt(() => nova.stop(inst.id), "Impossible d'éteindre l'appareil");
}

// ---------- Bibliothèque ----------
function recent(): Record<string, number> {
  return store.get<Record<string, number>>("recent", {});
}
function sortedGames() {
  const r = recent();
  return [...ui.games].sort((a, b) => (r[b] ?? 0) - (r[a] ?? 0) || gameName(a).localeCompare(gameName(b)));
}

async function refreshGames() {
  const inst = current();
  if (!inst || inst.status !== "ready") {
    renderLibrary();
    return;
  }
  ui.games = ((await attempt(() => nova.listApps(inst.id), "Impossible de lire les jeux")) ?? []) as string[];
  if (!ui.selectedGame || !ui.games.includes(ui.selectedGame)) ui.selectedGame = sortedGames()[0] ?? null;
  renderLibrary();
}

function renderHero() {
  const inst = current();
  const art = $("hero-art");
  const actions = $("hero-actions");
  const boot = $("boot");
  actions.replaceChildren();
  document.querySelector(".boot-error")?.remove();
  boot.hidden = inst?.status !== "booting";
  actions.hidden = inst?.status === "booting";

  if (!inst) return;
  if (inst.status !== "ready") {
    setHue(265);
    const dev = h("div", `hero-art device-art ${inst.status}`);
    dev.id = "hero-art";
    const screen = h("div", "device-screen");
    const logo = h("img") as HTMLImageElement;
    logo.src = "logo.svg";
    logo.alt = "";
    screen.append(logo);
    dev.append(screen);
    art.replaceWith(dev);
    $("hero-kicker").textContent = androidLabel(inst.image);
    $("hero-title").textContent = deviceLabel(inst.id);
    $("hero-meta").textContent =
      inst.status === "booting"
        ? "Android démarre. Tu pourras jouer dès qu'il est prêt."
        : `${ui.games.length ? "" : "Allume l'appareil pour retrouver tes jeux. "}${inst.settings.ramMb / 1024} Go de mémoire, ${inst.settings.cpuCores} cœurs, écran ${inst.settings.width}×${inst.settings.height}.`;
    if (inst.status === "stopped") {
      const b = h("button", "btn primary play");
      b.append(icon("power"), document.createTextNode(ui.bootError ? "Réessayer" : "Allumer l'appareil"));
      b.onclick = () => startDevice();
      const add = h("button", "btn play");
      add.append(icon("plus"), document.createTextNode("Ajouter un jeu"));
      add.onclick = pickApks;
      actions.append(b, add);
      if (ui.bootError) renderBootError(actions);
    }
    return;
  }

  const pkg = ui.selectedGame;
  if (!pkg) {
    setHue(265);
    $("hero-kicker").textContent = "Appareil prêt";
    $("hero-title").textContent = "Ajoute ton premier jeu";
    $("hero-meta").textContent = "Dépose un fichier APK n'importe où dans la fenêtre, ou installe un jeu depuis le Play Store.";
    const add = h("button", "btn primary play");
    add.append(icon("plus"), document.createTextNode("Ajouter un APK"));
    add.onclick = pickApks;
    const ps = h("button", "btn play");
    ps.append(icon("store"), document.createTextNode("Ouvrir le Play Store"));
    ps.onclick = openStore;
    actions.append(add, ps);
    const empty = h("div", "hero-art cover");
    empty.id = "hero-art";
    empty.append(h("span", "glyph", "+"));
    art.replaceWith(empty);
    return;
  }

  setHue(hueOf(pkg));
  const big = cover(pkg, "hero-art cover");
  big.id = "hero-art";
  art.replaceWith(big);
  const last = recent()[pkg];
  $("hero-kicker").textContent = last ? `Joué ${relTime(last)}` : "Jamais lancé";
  $("hero-title").textContent = gameName(pkg);
  $("hero-meta").textContent = pkg;
  const play = h("button", "btn primary play");
  play.append(icon("play"), document.createTextNode("Jouer"));
  play.onclick = () => playGame(pkg);
  const close = h("button", "btn");
  close.append(icon("stop", "ico sm"), document.createTextNode("Fermer le jeu"));
  close.onclick = () => attempt(() => nova.stopApp(inst.id, pkg));
  const keys = h("button", "btn ghost", "Régler les touches");
  keys.onclick = () => go("controls");
  const del = h("button", "btn ghost danger", "Désinstaller");
  del.onclick = () => confirmThen(del, "Confirmer", async () => {
    const list = await attempt(() => nova.uninstall(inst.id, pkg), "Désinstallation impossible");
    if (list) {
      ui.games = list;
      ui.selectedGame = sortedGames()[0] ?? null;
      toast(`${gameName(pkg)} désinstallé`);
      renderLibrary();
    }
  });
  actions.append(play, close, keys, del);
}

/** Panneau d'erreur de démarrage, avec des solutions en un clic. */
function renderBootError(actions: HTMLElement) {
  const box = h("div", "boot-error");
  const [summary, ...rest] = (ui.bootError ?? "").split("\n\n");
  box.append(h("strong", "", "L'appareil n'a pas démarré"), h("p", "", summary));
  if (rest.length) {
    const d = h("details");
    d.append(h("summary", "", "Détail technique"), h("pre", "", rest.join("\n\n")));
    box.append(d);
  }
  const row = h("div", "boot-error-actions");
  const soft = h("button", "btn sm", "Réessayer en rendu logiciel");
  soft.onclick = () => startDevice({ software: true });
  const repair = h("button", "btn sm ghost", "Réparer le moteur Android");
  repair.onclick = repairEngine;
  row.append(soft, repair);
  box.append(row);
  actions.after(box);
}

async function repairEngine() {
  toast("Réparation du moteur Android…", { detail: "Les éléments manquants sont téléchargés.", sticky: true });
  const ok = await attempt(() => nova.repairSdk(), "La réparation a échoué");
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  if (ok) {
    ui.bootError = null;
    toast("Moteur Android réparé", { detail: "Tu peux rallumer l'appareil." });
    renderAll();
  }
}

function relTime(t: number) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `il y a ${hrs} h`;
  return `il y a ${Math.round(hrs / 24)} j`;
}

/** Un deuxième clic est demandé pour les actions destructives. */
function confirmThen(btn: HTMLButtonElement, label: string, fn: () => void) {
  if (btn.dataset.armed) {
    fn();
    return;
  }
  const old = btn.textContent;
  btn.dataset.armed = "1";
  btn.textContent = label;
  setTimeout(() => {
    delete btn.dataset.armed;
    btn.textContent = old;
  }, 3000);
}

function renderShelf() {
  const inst = current();
  const shelf = $("shelf");
  shelf.replaceChildren();
  const ready = inst?.status === "ready";
  $("games-count").textContent = ready && ui.games.length ? String(ui.games.length) : "";
  if (!ready) {
    shelf.append(h("p", "empty-shelf", inst?.status === "booting" ? "Tes jeux apparaîtront dans un instant." : "Tes jeux s'affichent quand l'appareil est allumé. Tu peux déjà en ajouter un : l'appareil s'allumera tout seul."));
  }
  for (const pkg of ready ? sortedGames() : []) {
    const t = h("button", "tile");
    t.setAttribute("role", "listitem");
    t.setAttribute("aria-selected", String(pkg === ui.selectedGame));
    t.dataset.pkg = pkg;
    t.append(cover(pkg), h("span", "name", gameName(pkg)), h("span", "sub", pkg));
    t.onclick = () => selectGame(pkg);
    t.ondblclick = () => playGame(pkg);
    shelf.append(t);
  }
  const add = h("button", "tile add");
  const c = h("div", "cover");
  c.append(icon("plus", "ico xl"));
  add.append(c, h("span", "name", "Ajouter un APK"), h("span", "sub", "ou dépose-le ici"));
  add.onclick = pickApks;
  const ps = h("button", "tile store");
  const c2 = h("div", "cover");
  c2.append(icon("store", "ico xl"));
  ps.append(c2, h("span", "name", "Play Store"), h("span", "sub", "Trouver des jeux"));
  ps.onclick = async () => {
    if (await startDevice()) openStore();
  };
  shelf.append(add);
  if (inst) shelf.append(ps);
}

function selectGame(pkg: string) {
  ui.selectedGame = pkg;
  document.querySelectorAll<HTMLElement>(".tile[data-pkg]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.pkg === pkg)));
  renderHero();
}

async function playGame(pkg: string) {
  const inst = current();
  if (!inst) return;
  const r = recent();
  r[pkg] = Date.now();
  store.set("recent", r);
  const ok = await attempt(() => nova.launchApp(inst.id, pkg), "Le jeu n'a pas pu se lancer");
  if (ok !== undefined) {
    toast(`${gameName(pkg)} est lancé`, { detail: "Les touches du profil sont actives dans l'onglet Touches." });
    renderHero();
  }
}
async function openStore() {
  const inst = current();
  if (inst) await attempt(() => nova.launchApp(inst.id, "com.android.vending"), "Le Play Store n'est pas disponible sur cet appareil");
}

function renderLibrary() {
  renderHero();
  renderShelf();
}

// Navigation au clavier dans la bibliothèque : flèches + Entrée.
document.addEventListener("keydown", (e) => {
  if (document.body.dataset.view !== "library") return;
  const tag = (document.activeElement?.tagName ?? "").toLowerCase();
  if (tag === "input" || tag === "select" || $("drawer").classList.contains("open")) return;
  const games = sortedGames();
  if (!games.length) return;
  const i = Math.max(0, games.indexOf(ui.selectedGame ?? ""));
  const perRow = Math.max(1, Math.round($("shelf").clientWidth / 168));
  const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow };
  if (e.key in moves) {
    e.preventDefault();
    const next = games[Math.min(games.length - 1, Math.max(0, i + moves[e.key]))];
    selectGame(next);
    document.querySelector<HTMLElement>(`.tile[data-pkg="${next}"]`)?.focus();
  } else if (e.key === "Enter" && ui.selectedGame && !(document.activeElement instanceof HTMLButtonElement && !document.activeElement.dataset.pkg)) {
    e.preventDefault();
    playGame(ui.selectedGame);
  }
});

// ---------- Installation d'APK ----------
async function installApks(paths: string[]) {
  const inst = current();
  if (!paths.length) return;
  if (!inst) {
    toast("Crée d'abord un appareil", { error: true });
    return;
  }
  if (inst.status !== "ready") {
    // L'appareil s'allume tout seul, puis le jeu s'installe.
    toast("Allumage de l'appareil", { detail: "Le jeu s'installera dès qu'Android sera prêt." });
    if (inst.status === "booting") {
      while (current()?.status === "booting") await new Promise((r) => setTimeout(r, 1000));
      if (current()?.status !== "ready") return;
    } else if (!(await startDevice())) return;
  }
  const before = new Set(ui.games);
  const t = toast(`Installation de ${paths.length > 1 ? `${paths.length} fichiers` : "ton jeu"}…`, { sticky: true });
  const list = (await attempt(() => nova.install(inst.id, paths), "Installation impossible")) as string[] | undefined;
  t.remove();
  if (!list) return;
  ui.games = list;
  const added = list.find((p) => !before.has(p));
  if (added) ui.selectedGame = added;
  toast(added ? `${gameName(added)} est installé` : "Jeu mis à jour");
  renderLibrary();
}
async function pickApks() {
  installApks(await nova.pickApks());
}

let dragDepth = 0;
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $("dropzone").hidden = false;
});
window.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("dropzone").hidden = true;
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("dropzone").hidden = true;
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.name.toLowerCase().endsWith(".apk"));
  if (!files.length) {
    toast("Ce n'est pas un jeu Android", { detail: "Dépose un fichier .apk.", error: true });
    return;
  }
  go("library");
  installApks(files.map((f) => nova.pathForFile(f)));
});

// ---------- Nouvel appareil ----------
function openNewDialog() {
  const d = $<HTMLDialogElement>("new-dialog");
  $<HTMLInputElement>("new-name").value = ui.instances.length ? "" : "Mon appareil";
  d.showModal();
}
$("new-form").addEventListener("submit", async (e) => {
  const d = $<HTMLDialogElement>("new-dialog");
  if ((e as SubmitEvent).submitter?.getAttribute("value") !== "ok") return;
  const name = $<HTMLInputElement>("new-name").value.trim();
  const sel = document.querySelector<HTMLInputElement>('input[name="img"]:checked')!.value;
  const [api, variant] = sel.split("|");
  const img = { api: Number(api), variant, abi: navigator.userAgent.includes("arm64") ? "arm64-v8a" : "x86_64" };
  d.close();
  const t = toast("Création de l'appareil…", { detail: "Ça prend quelques secondes.", sticky: true });
  const before = new Set(ui.instances.map((i) => i.id));
  const list = (await attempt(() => nova.createInstance(name, img), "Création impossible")) as UiInstance[] | undefined;
  t.remove();
  if (!list) return;
  ui.instances = list;
  const created = list.find((i) => !before.has(i.id)) ?? list[list.length - 1];
  toast(`${deviceLabel(created.id)} est créé`);
  await selectDevice(created.id);
  go("library");
});

// ---------- Réglages ----------
const PRESETS: Record<string, Partial<Settings>> = {
  eco: { ramMb: 2048, cpuCores: 2, width: 1280, height: 720, dpi: 240 },
  balanced: { ramMb: 4096, cpuCores: 4, width: 1920, height: 1080, dpi: 320 },
  perf: { ramMb: 8192, cpuCores: 8, width: 1920, height: 1080, dpi: 320 },
};
function formSettings(): Settings {
  const f = $<HTMLFormElement>("settings-form");
  return Object.fromEntries([...new FormData(f).entries()].map(([k, v]) => [k, Number(v)])) as unknown as Settings;
}
function fillSettings(s: Settings) {
  const f = $<HTMLFormElement>("settings-form");
  for (const [k, v] of Object.entries(s)) {
    const input = f.elements.namedItem(k) as HTMLInputElement | null;
    if (input) input.value = String(v);
  }
  markPreset();
}
function markPreset() {
  const s = formSettings();
  document.querySelectorAll<HTMLButtonElement>(".preset").forEach((b) => {
    const p = PRESETS[b.dataset.preset!];
    const match = Object.entries(p).every(([k, v]) => (s as any)[k] === v);
    b.setAttribute("aria-checked", String(match));
  });
}
function renderSettings() {
  const inst = current();
  $("sec-device").hidden = !inst;
  if (!inst) return;
  $("set-name").textContent = deviceLabel(inst.id);
  $("set-image").textContent = androidLabel(inst.image);
  const locked = inst.status !== "stopped";
  $("set-locked").hidden = !locked;
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(".preset, #settings-form input, #settings-save, #device-delete").forEach((el) => (el.disabled = locked));
  fillSettings(inst.settings);
}
function renderFacts(accel?: { ok: boolean; details?: string }) {
  nova.sdkStatus().then((s: any) => {
    const facts = $("engine-facts");
    facts.replaceChildren();
    const row = (ok: boolean | undefined, text: string) => {
      const li = h("li");
      li.append(h("span", `dot ${ok ? "ready" : ok === false ? "booting" : ""}`), h("span", "", text));
      facts.append(li);
    };
    row(s.java, s.java ? "Java installé" : "Java manquant");
    row(s.emulator && s.platformTools, s.emulator ? "Émulateur et ADB installés" : "Émulateur non installé");
    if (accel) row(accel.ok, accel.ok ? "Accélération matérielle active" : "Accélération matérielle inactive");
    const li = h("li");
    li.append(h("span", "path", s.root ?? ""));
    facts.append(li);
  });
}
function openDrawer(open: boolean) {
  $("drawer").classList.toggle("open", open);
  $("drawer").setAttribute("aria-hidden", String(!open));
  $("scrim").hidden = !open;
  if (open) {
    renderSettings();
    $("drawer-close").focus();
  }
}
$("settings-btn").onclick = () => openDrawer(true);
$("engine-repair").onclick = repairEngine;
const swGpu = $<HTMLInputElement>("software-gpu");
swGpu.checked = ui.softwareGpu;
swGpu.onchange = () => {
  ui.softwareGpu = swGpu.checked;
  store.set("softwareGpu", swGpu.checked);
};
$("drawer-close").onclick = () => openDrawer(false);
$("scrim").onclick = () => openDrawer(false);
document.querySelectorAll<HTMLButtonElement>(".preset").forEach((b) => {
  b.onclick = () => {
    const inst = current();
    if (!inst) return;
    fillSettings({ ...formSettings(), ...PRESETS[b.dataset.preset!] });
  };
});
$("settings-form").addEventListener("input", markPreset);
$("settings-save").onclick = async () => {
  const inst = current();
  if (!inst) return;
  const list = await attempt(() => nova.saveSettings(inst.id, formSettings()), "Réglages non enregistrés");
  if (list) {
    ui.instances = list;
    renderAll();
    toast("Réglages enregistrés", { detail: "Ils s'appliquent au prochain démarrage." });
  }
};
$("device-delete").onclick = () =>
  confirmThen($<HTMLButtonElement>("device-delete"), "Confirmer la suppression", async () => {
    const inst = current();
    if (!inst) return;
    const list = await attempt(() => nova.deleteInstance(inst.id), "Suppression impossible");
    if (list) {
      ui.instances = list;
      ui.device = list[0]?.id ?? null;
      store.set("device", ui.device);
      openDrawer(false);
      toast(`${deviceLabel(inst.id)} est supprimé`);
      renderAll();
    }
  });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if ($("drawer").classList.contains("open")) openDrawer(false);
    toggleMenu(false);
  }
});

// ---------- Éditeur de touches ----------
const KEY_NAMES: Record<string, string> = {
  Space: "Espace", Escape: "Échap", Enter: "Entrée", ShiftLeft: "Maj", ShiftRight: "Maj D", ControlLeft: "Ctrl",
  ControlRight: "Ctrl D", AltLeft: "Alt", Tab: "Tab", Backspace: "⌫", ArrowUp: "↑", ArrowDown: "↓",
  ArrowLeft: "←", ArrowRight: "→", Home: "Début", CapsLock: "Verr",
};
function keyName(code?: string) {
  if (!code) return "?";
  return KEY_NAMES[code] ?? code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Pavé ");
}

async function loadProfiles(keepName?: string) {
  ui.profiles = ((await attempt(() => nova.profiles())) ?? []) as UiProfile[];
  const want = keepName ?? store.get<string | null>("profile", null);
  const p = ui.profiles.find((x) => x.name === want) ?? ui.profiles[0] ?? { name: "Mon profil", bindings: [] };
  ui.profile = structuredClone(p);
  ui.dirty = false;
  ui.selBinding = -1;
  const sel = $<HTMLSelectElement>("profile");
  sel.replaceChildren(...ui.profiles.map((x) => new Option(x.name, x.name, false, x.name === ui.profile!.name)));
  renderStage();
}

function setDirty(d = true) {
  ui.dirty = d;
  $<HTMLButtonElement>("profile-save").disabled = !d;
}

function renderStage() {
  const keys = $("stage-keys");
  keys.replaceChildren();
  const soft = $("softkeys");
  soft.replaceChildren();
  const p = ui.profile;
  setDirty(ui.dirty);
  if (!p) return;
  p.bindings.forEach((b, i) => {
    if (b.action === "keyevent") {
      const s = h("button", "softkey" + (i === ui.selBinding ? " sel" : ""));
      s.append(h("kbd", "", keyName(b.key)), document.createTextNode(b.label ?? b.code ?? ""));
      s.onclick = () => selectBinding(i);
      soft.append(s);
      return;
    }
    if (b.action === "joystick") {
      const r = b.radius ?? 0.06;
      const ring = h("div", "joy" + (i === ui.selBinding ? " sel" : ""));
      Object.assign(ring.style, { left: `${b.x! * 100}%`, top: `${b.y! * 100}%`, width: `${r * 200}%` });
      ring.dataset.i = String(i);
      const dirs: [string | undefined, number, number][] = [[b.up, 50, 0], [b.down, 50, 100], [b.left, 0, 50], [b.right, 100, 50]];
      for (const [k, x, y] of dirs) {
        const kb = h("div", "kb", keyName(k));
        kb.dataset.code = k ?? "";
        Object.assign(kb.style, { left: `${x}%`, top: `${y}%` });
        ring.append(kb);
      }
      makeDraggable(ring, i);
      keys.append(ring);
      return;
    }
    const kb = h("div", `kb ${b.action}` + (i === ui.selBinding ? " sel" : ""), keyName(b.key));
    kb.dataset.code = b.key ?? "";
    Object.assign(kb.style, { left: `${b.x! * 100}%`, top: `${b.y! * 100}%` });
    if (b.label) kb.append(h("small", "", b.label));
    makeDraggable(kb, i);
    keys.append(kb);
  });
  if (!p.bindings.length) soft.append(h("span", "muted small", "Ajoute une commande avec les boutons ci-dessus."));
  renderInspector();
}

function makeDraggable(el: HTMLElement, i: number) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const stage = $("stage");
    const rect = stage.getBoundingClientRect();
    const b = ui.profile!.bindings[i];
    const start = { x: e.clientX, y: e.clientY, bx: b.x!, by: b.y! };
    let moved = false;
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / rect.width;
      const dy = (ev.clientY - start.y) / rect.height;
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 3) moved = true;
      b.x = Math.min(1, Math.max(0, +(start.bx + dx).toFixed(4)));
      b.y = Math.min(1, Math.max(0, +(start.by + dy).toFixed(4)));
      el.style.left = `${b.x * 100}%`;
      el.style.top = `${b.y * 100}%`;
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.classList.remove("dragging");
      if (moved) setDirty();
      selectBinding(i);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up, { once: true });
  });
}

function selectBinding(i: number) {
  ui.selBinding = i;
  renderStage();
}

let listening: { el: HTMLButtonElement; field: keyof UiBinding } | null = null;
function keycap(label: string, field: keyof UiBinding, b: UiBinding) {
  const wrap = h("label");
  wrap.append(document.createTextNode(label));
  const btn = h("button", "keycap", keyName(b[field] as string));
  btn.type = "button";
  btn.onclick = () => {
    listening?.el.classList.remove("listening");
    listening = { el: btn, field };
    btn.classList.add("listening");
    btn.textContent = "Appuie sur une touche…";
  };
  wrap.append(btn);
  return wrap;
}
window.addEventListener(
  "keydown",
  (e) => {
    if (!listening || !ui.profile) return;
    e.preventDefault();
    e.stopPropagation();
    const b = ui.profile.bindings[ui.selBinding];
    if (e.code !== "Escape" || listening.field !== "key") (b as any)[listening.field] = e.code;
    listening = null;
    setDirty();
    renderStage();
  },
  true,
);

function renderInspector() {
  const b = ui.profile?.bindings[ui.selBinding];
  $("insp-empty").hidden = !!b;
  const form = $<HTMLFormElement>("insp-form");
  form.hidden = !b;
  if (!b) return;
  (form.elements.namedItem("label") as HTMLInputElement).value = b.label ?? "";
  const keys = $("insp-keys");
  keys.replaceChildren();
  if (b.action === "joystick") {
    const grid = h("div", "keygrid");
    grid.append(keycap("Haut", "up", b), keycap("Bas", "down", b), keycap("Gauche", "left", b), keycap("Droite", "right", b));
    keys.append(grid);
  } else {
    keys.append(keycap("Touche du clavier", "key", b));
  }
  $("insp-code-wrap").hidden = b.action !== "keyevent";
  (form.elements.namedItem("code") as HTMLSelectElement).value = b.code ?? "KEYCODE_BACK";
  $("insp-radius-wrap").hidden = b.action !== "joystick";
  (form.elements.namedItem("radius") as HTMLInputElement).value = String(b.radius ?? 0.06);
}
$("insp-form").addEventListener("input", (e) => {
  const b = ui.profile?.bindings[ui.selBinding];
  if (!b) return;
  const t = e.target as HTMLInputElement;
  if (t.name === "label") b.label = t.value || undefined;
  if (t.name === "code") b.code = t.value;
  if (t.name === "radius") b.radius = Number(t.value);
  setDirty();
  if (t.name !== "label") renderStage();
  else {
    const el = document.querySelector<HTMLElement>(`.kb.sel small`);
    if (el) el.textContent = t.value;
  }
});
$("insp-form").addEventListener("change", (e) => {
  if ((e.target as HTMLInputElement).name === "label") renderStage();
});
$("insp-form").addEventListener("submit", (e) => e.preventDefault());
$("insp-delete").onclick = () => {
  if (!ui.profile) return;
  ui.profile.bindings.splice(ui.selBinding, 1);
  ui.selBinding = -1;
  setDirty();
  renderStage();
};

document.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((btn) => {
  btn.onclick = () => {
    if (!ui.profile) return;
    const kind = btn.dataset.add as UiBinding["action"];
    const b: UiBinding =
      kind === "joystick"
        ? { action: "joystick", label: "Déplacement", up: "KeyW", down: "KeyS", left: "KeyA", right: "KeyD", x: 0.18, y: 0.7, radius: 0.06 }
        : kind === "keyevent"
          ? { action: "keyevent", label: "Retour", key: "Backspace", code: "KEYCODE_BACK" }
          : { action: kind, key: kind === "hold" ? "ShiftLeft" : "Space", x: 0.5, y: 0.5 };
    ui.profile.bindings.push(b);
    ui.selBinding = ui.profile.bindings.length - 1;
    setDirty();
    renderStage();
  };
});

$("profile").addEventListener("change", (e) => {
  const name = (e.target as HTMLSelectElement).value;
  if (ui.dirty && !confirmLoseChanges()) {
    (e.target as HTMLSelectElement).value = ui.profile!.name;
    return;
  }
  store.set("profile", name);
  loadProfiles(name).then(activateProfile);
});
function confirmLoseChanges() {
  toast("Modifications non enregistrées", { detail: "Enregistre le profil avant d'en changer.", error: true });
  return false;
}
$("profile-new").onclick = () => {
  let n = 1;
  while (ui.profiles.some((p) => p.name === `Profil ${n}`)) n++;
  ui.profile = { name: `Profil ${n}`, bindings: [] };
  ui.profiles.push(ui.profile);
  const sel = $<HTMLSelectElement>("profile");
  sel.append(new Option(ui.profile.name, ui.profile.name, true, true));
  ui.selBinding = -1;
  setDirty();
  renderStage();
};
$("profile-save").onclick = async () => {
  if (!ui.profile) return;
  const name = ui.profile.name;
  const list = await attempt(() => nova.saveProfile(ui.profile), "Profil non enregistré");
  if (!list) return;
  store.set("profile", name);
  await loadProfiles(name);
  toast("Profil enregistré");
  activateProfile();
};
$("snap").onclick = async () => {
  const inst = current();
  if (!inst || inst.status !== "ready") {
    toast("Allume l'appareil et lance un jeu", { detail: "La capture sert de fond pour placer les touches.", error: true });
    return;
  }
  const src = await attempt(() => nova.captureScreen(inst.id), "Capture impossible");
  if (src) {
    const img = $<HTMLImageElement>("stage-shot");
    img.src = src;
    img.hidden = false;
  }
};

async function activateProfile() {
  const inst = current();
  ui.keysLive = false;
  if (!inst || inst.status !== "ready" || !ui.profile || ui.dirty) return;
  ui.keysLive = !!(await attempt(() => nova.activateKeymap(inst.id, ui.profile!.name)));
}

const stage = $("stage");
function setLive(on: boolean) {
  stage.classList.toggle("live", on);
  $("stage-hint").textContent = on
    ? ui.keysLive
      ? "Touches actives : joue au clavier. Clique ailleurs pour arrêter."
      : "Aperçu : allume l'appareil et enregistre le profil pour envoyer les touches."
    : "Glisse les touches pour les placer. Clique ici puis joue au clavier pour tester.";
}
stage.addEventListener("pointerdown", () => {
  ui.selBinding = -1;
  renderStage();
  stage.focus();
});
stage.addEventListener("focus", () => {
  setLive(true);
  if (!ui.keysLive) activateProfile().then(() => setLive(document.activeElement === stage));
});
function onKey(e: KeyboardEvent, down: boolean) {
  if (listening) return;
  e.preventDefault();
  stage.querySelectorAll(`[data-code="${e.code}"]`).forEach((k) => k.classList.toggle("down", down));
  const inst = current();
  if (inst && ui.keysLive) nova.key(inst.id, e.code, down);
}
stage.addEventListener("keydown", (e) => onKey(e, true));
stage.addEventListener("keyup", (e) => onKey(e, false));
stage.addEventListener("blur", () => {
  setLive(false);
  stage.querySelectorAll(".down").forEach((k) => k.classList.remove("down"));
  const inst = current();
  if (inst && ui.keysLive) nova.releaseKeys(inst.id);
});

// ---------- Rendu global ----------
function renderAll() {
  if (!ui.instances.some((i) => i.id === ui.device)) ui.device = ui.instances[0]?.id ?? null;
  renderDevice();
  renderSetup();
  if (needsSetup()) {
    if (document.body.dataset.view !== "setup") go("setup");
  } else if (document.body.dataset.view === "setup") {
    go("library");
  }
  renderLibrary();
  if ($("drawer").classList.contains("open")) renderSettings();
}

(async () => {
  const s = await attempt(() => nova.sdkStatus());
  ui.sdkReady = !!(s && s.java && s.cmdlineTools && s.emulator && s.platformTools);
  ui.instances = ((await attempt(() => nova.listInstances())) ?? []) as UiInstance[];
  renderAll();
  if (ui.sdkReady) checkAccel();
  else renderFacts();
  await refreshGames();
  await loadProfiles();
})();
