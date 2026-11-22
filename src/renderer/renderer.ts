// Interface de NovaDroid (script de page, sans accès direct à Node).

interface UiInstance {
  id: string;
  status: "stopped" | "booting" | "ready";
  image?: string;
  settings: Record<string, number>;
}
interface UiBinding {
  action: "tap" | "hold" | "keyevent" | "joystick";
  key?: string;
  label?: string;
  x?: number;
  y?: number;
  up?: string;
  down?: string;
  left?: string;
  right?: string;
  radius?: number;
}
interface UiProfile { name: string; bindings: UiBinding[] }

declare const nova: any;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  instances: [] as UiInstance[],
  selected: null as string | null,
  profiles: [] as UiProfile[],
  keysActive: false,
};

// --- Messages ---
let toastTimer: number | undefined;
function toast(text: string, opts: { percent?: number; error?: boolean; sticky?: boolean } = {}) {
  const t = $("toast");
  t.hidden = false;
  t.classList.toggle("error", !!opts.error);
  $("toast-text").textContent = text;
  const bar = $<HTMLProgressElement>("toast-bar");
  bar.hidden = opts.percent === undefined;
  if (opts.percent !== undefined) bar.value = opts.percent;
  clearTimeout(toastTimer);
  if (!opts.sticky) toastTimer = window.setTimeout(() => (t.hidden = true), opts.error ? 8000 : 3500);
}

async function attempt<T = any>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e: any) {
    // Electron préfixe les erreurs IPC : on garde le message utile.
    toast(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), { error: true });
    return undefined;
  }
}

nova.on("progress", (p: { message: string; percent?: number }) =>
  toast(p.message, { percent: p.percent, sticky: p.percent !== undefined && p.percent < 100 }),
);
nova.on("instances", (list: UiInstance[]) => {
  ui.instances = list;
  render();
});

// --- SDK ---
async function renderSdk() {
  const box = $("sdk");
  const s = await nova.sdkStatus();
  if (s.cmdlineTools && s.emulator && s.platformTools) {
    box.innerHTML = `<span class="ok">Moteur Android installé</span>`;
    const accel = await attempt(() => nova.checkAccel());
    if (accel && !accel.ok) {
      const warn = document.createElement("p");
      warn.textContent = "Accélération matérielle indisponible : les jeux seront lents. " + accel.help;
      box.append(warn);
    }
    return;
  }
  box.innerHTML = `<p>Le moteur Android n'est pas encore installé (environ 3 Go à télécharger).</p>`;
  const btn = document.createElement("button");
  btn.className = "primary";
  btn.textContent = "Installer le moteur Android";
  btn.onclick = async () => {
    btn.disabled = true;
    await attempt(() => nova.setupSdk());
    renderSdk();
  };
  box.append(btn);
}

// --- Instances ---
function current(): UiInstance | undefined {
  return ui.instances.find((i) => i.id === ui.selected);
}

const STATUS_TEXT = { stopped: "Arrêtée", booting: "Démarrage d'Android…", ready: "En marche" };

function render() {
  const list = $("instances");
  list.innerHTML = "";
  for (const inst of ui.instances) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.setAttribute("aria-current", String(inst.id === ui.selected));
    b.innerHTML = `<span></span><span class="dot ${inst.status}" title="${STATUS_TEXT[inst.status]}"></span>`;
    (b.firstChild as HTMLElement).textContent = inst.id.replace(/_/g, " ");
    b.onclick = () => select(inst.id);
    li.append(b);
    list.append(li);
  }

  const inst = current();
  $("empty").hidden = !!inst;
  $("detail").hidden = !inst;
  if (!inst) return;
  $("d-name").textContent = inst.id.replace(/_/g, " ");
  $("d-status").textContent = `${STATUS_TEXT[inst.status]}, ${inst.settings.width}×${inst.settings.height}, ${inst.settings.ramMb / 1024} Go de RAM`;
  $<HTMLButtonElement>("d-start").hidden = inst.status !== "stopped";
  $<HTMLButtonElement>("d-stop").hidden = inst.status === "stopped";
  const ready = inst.status === "ready";
  $<HTMLButtonElement>("d-add").disabled = !ready;
  $("drop").textContent = ready
    ? "Dépose un ou plusieurs fichiers .apk ici pour installer un jeu."
    : "Démarre l'instance pour installer et lancer des jeux.";
  const form = $<HTMLFormElement>("settings-form");
  for (const [k, v] of Object.entries(inst.settings)) {
    const input = form.elements.namedItem(k) as HTMLInputElement | null;
    if (input && document.activeElement !== input) input.value = String(v);
  }
}

async function select(id: string) {
  ui.selected = id;
  render();
  await refreshGames();
}

async function refreshGames() {
  const inst = current();
  const ul = $("games");
  ul.innerHTML = "";
  if (!inst || inst.status !== "ready") return;
  const games: string[] = (await attempt(() => nova.listApps(inst.id))) ?? [];
  if (!games.length) {
    ul.innerHTML = `<li class="none">Aucun jeu installé. Ajoute un APK ou ouvre le Play Store dans l'instance.</li>`;
    return;
  }
  for (const pkg of games) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "pkg";
    name.textContent = pkg;
    const play = document.createElement("button");
    play.className = "primary";
    play.textContent = "Jouer";
    play.onclick = async () => {
      await attempt(() => nova.launchApp(inst.id, pkg));
      $("pad").focus();
    };
    const stop = document.createElement("button");
    stop.textContent = "Fermer";
    stop.onclick = () => attempt(() => nova.stopApp(inst.id, pkg));
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "Désinstaller";
    del.onclick = async () => {
      if (await attempt(() => nova.uninstall(inst.id, pkg))) refreshGames();
    };
    li.append(name, play, stop, del);
    ul.append(li);
  }
}

$("new-instance").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>("new-name").value.trim();
  const [api, variant] = $<HTMLSelectElement>("new-image").value.split("|");
  const img = { api: Number(api), variant, abi: navigator.userAgent.includes("arm64") ? "arm64-v8a" : "x86_64" };
  toast("Création de l'instance…", { sticky: true });
  const list = await attempt(() => nova.createInstance(name, img));
  if (list) {
    const before = ui.instances;
    ui.instances = list;
    $<HTMLInputElement>("new-name").value = "";
    toast("Instance créée");
    const created = list.find((i: UiInstance) => !before.some((o) => o.id === i.id)) ?? list[list.length - 1];
    select(created.id);
  }
});

$("d-start").onclick = async () => {
  const inst = current();
  if (!inst) return;
  const list = await attempt(() => nova.start(inst.id));
  if (list) {
    ui.instances = list;
    render();
    toast("Instance prête");
    refreshGames();
    activateProfile();
  }
};
$("d-stop").onclick = async () => {
  const inst = current();
  if (inst) await attempt(() => nova.stop(inst.id));
};
$("d-delete").onclick = async () => {
  const inst = current();
  if (!inst) return;
  const list = await attempt(() => nova.deleteInstance(inst.id));
  if (list) {
    ui.instances = list;
    ui.selected = list[0]?.id ?? null;
    render();
  }
};
$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const inst = current();
  if (!inst) return;
  const data = new FormData(e.target as HTMLFormElement);
  const settings = Object.fromEntries([...data.entries()].map(([k, v]) => [k, Number(v)]));
  const list = await attempt(() => nova.saveSettings(inst.id, settings));
  if (list) {
    ui.instances = list;
    render();
    toast("Réglages enregistrés");
  }
});

// --- Installation d'APK ---
async function installApks(paths: string[]) {
  const inst = current();
  if (!inst || inst.status !== "ready" || !paths.length) return;
  if (await attempt(() => nova.install(inst.id, paths))) refreshGames();
}
$("d-add").onclick = async () => installApks(await nova.pickApks());
const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const files = [...(e.dataTransfer?.files ?? [])];
  installApks(files.map((f) => nova.pathForFile(f)));
});

// --- Clavier et souris ---
function keyLabel(code: string) {
  return code.replace(/^Key/, "").replace(/^Digit/, "").replace("Space", "Espace").replace("Escape", "Échap");
}

function renderOverlay() {
  const overlay = $("pad-overlay");
  overlay.innerHTML = "";
  const profile = ui.profiles.find((p) => p.name === $<HTMLSelectElement>("profile").value);
  if (!profile) return;
  for (const b of profile.bindings) {
    if (b.x === undefined || b.y === undefined) continue;
    if (b.action === "joystick") {
      const ring = document.createElement("div");
      ring.className = "joy";
      const size = `${(b.radius ?? 0.06) * 2 * 100}%`;
      Object.assign(ring.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: size, aspectRatio: "1" });
      overlay.append(ring);
      const dirs: [string | undefined, number, number][] = [[b.up, 0, -1], [b.down, 0, 1], [b.left, -1, 0], [b.right, 1, 0]];
      for (const [k, dx, dy] of dirs) {
        if (!k) continue;
        // Le rayon est exprimé en largeur d'écran : sur un écran 16/9, y = x × 16/9.
        addKey(k, b.x + dx * (b.radius ?? 0.06), b.y + dy * (b.radius ?? 0.06) * (16 / 9));
      }
      continue;
    }
    if (b.key) addKey(b.key, b.x, b.y, b.label);
  }
  function addKey(code: string, x: number, y: number, label?: string) {
    const el = document.createElement("div");
    el.className = "key";
    el.dataset.code = code;
    el.style.left = `${x * 100}%`;
    el.style.top = `${y * 100}%`;
    el.textContent = keyLabel(code);
    if (label) {
      const s = document.createElement("small");
      s.textContent = label;
      el.append(s);
    }
    overlay.append(el);
  }
}

async function loadProfiles() {
  ui.profiles = (await attempt(() => nova.profiles())) ?? [];
  const sel = $<HTMLSelectElement>("profile");
  sel.innerHTML = "";
  for (const p of ui.profiles) sel.append(new Option(p.name, p.name));
  renderOverlay();
}

async function activateProfile() {
  const inst = current();
  const name = $<HTMLSelectElement>("profile").value;
  ui.keysActive = false;
  if (!inst || inst.status !== "ready" || !name) return;
  ui.keysActive = !!(await attempt(() => nova.activateKeymap(inst.id, name)));
}

$("profile").addEventListener("change", () => {
  renderOverlay();
  activateProfile();
});
$("profile-folder").onclick = async () => {
  await nova.openKeymapFolder();
  toast("Modifie ou ajoute des profils .json, puis reviens ici.");
};
window.addEventListener("focus", loadProfiles);

const pad = $("pad");
function onKey(e: KeyboardEvent, down: boolean) {
  const inst = current();
  if (!inst) return;
  e.preventDefault();
  pad.querySelectorAll(`[data-code="${e.code}"]`).forEach((k) => k.classList.toggle("down", down));
  if (ui.keysActive) nova.key(inst.id, e.code, down);
}
pad.addEventListener("keydown", (e) => onKey(e, true));
pad.addEventListener("keyup", (e) => onKey(e, false));
pad.addEventListener("blur", () => {
  pad.querySelectorAll(".key.down").forEach((k) => k.classList.remove("down"));
  const inst = current();
  if (inst && ui.keysActive) nova.releaseKeys(inst.id);
});
pad.addEventListener("focus", () => {
  if (!ui.keysActive) activateProfile();
});

// --- Démarrage ---
(async () => {
  ui.instances = (await attempt(() => nova.listInstances())) ?? [];
  if (ui.instances[0]) select(ui.instances[0].id);
  else render();
  renderSdk();
  loadProfiles();
})();
