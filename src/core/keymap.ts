// Mapping clavier/souris -> écran tactile. Les coordonnées des profils sont normalisées
// (0..1) pour fonctionner quelle que soit la résolution de l'instance.

export type Binding =
  | { action: "tap"; key: string; x: number; y: number; label?: string }
  /** Appui maintenu tant que la touche est enfoncée (tir, accélérateur...). */
  | { action: "hold"; key: string; x: number; y: number; label?: string }
  | { action: "keyevent"; key: string; code: string; label?: string }
  | {
      action: "joystick";
      up: string;
      down: string;
      left: string;
      right: string;
      x: number;
      y: number;
      /** Rayon du joystick, en fraction de la largeur de l'écran. */
      radius: number;
      label?: string;
    };

export interface KeymapProfile {
  name: string;
  /** Paquet du jeu auquel ce profil s'applique (facultatif). */
  package?: string;
  bindings: Binding[];
}

export interface Screen {
  width: number;
  height: number;
}

export function validateProfile(p: unknown): KeymapProfile {
  const prof = p as KeymapProfile;
  if (!prof || typeof prof.name !== "string" || !Array.isArray(prof.bindings)) {
    throw new Error("Profil de touches invalide");
  }
  const inUnit = (v: unknown) => typeof v === "number" && v >= 0 && v <= 1;
  for (const b of prof.bindings) {
    if ((b.action === "tap" || b.action === "hold" || b.action === "joystick") && !(inUnit(b.x) && inUnit(b.y))) {
      throw new Error(`Coordonnées hors écran dans « ${b.label ?? b.action} »`);
    }
    if (b.action === "keyevent" && !/^KEYCODE_[A-Z0-9_]+$/.test(b.code)) {
      throw new Error(`Code de touche Android invalide : ${b.code}`);
    }
  }
  return prof;
}

/**
 * Transforme les événements clavier en commandes `input` Android.
 * Limite actuelle : `input motionevent` ne gère qu'un seul doigt, donc un appui maintenu
 * et le joystick ne peuvent pas être utilisés en même temps. Le multitouch arrivera avec
 * le protocole de contrôle gRPC de l'émulateur.
 */
export class KeymapEngine {
  private pressed = new Set<string>();
  private pointerOwner: string | null = null;
  private joyPos: { x: number; y: number } | null = null;

  constructor(private profile: KeymapProfile, private screen: Screen) {}

  private px(x: number, y: number): [number, number] {
    return [Math.round(x * this.screen.width), Math.round(y * this.screen.height)];
  }

  keyDown(key: string): string[] {
    if (this.pressed.has(key)) return []; // répétition automatique du clavier
    this.pressed.add(key);
    const out: string[] = [];
    for (const b of this.profile.bindings) {
      if (b.action === "tap" && b.key === key) out.push(`input tap ${this.px(b.x, b.y).join(" ")}`);
      if (b.action === "keyevent" && b.key === key) out.push(`input keyevent ${b.code}`);
      if (b.action === "hold" && b.key === key && this.pointerOwner === null) {
        this.pointerOwner = key;
        out.push(`input motionevent DOWN ${this.px(b.x, b.y).join(" ")}`);
      }
      if (b.action === "joystick" && [b.up, b.down, b.left, b.right].includes(key)) out.push(...this.updateJoystick(b));
    }
    return out;
  }

  keyUp(key: string): string[] {
    if (!this.pressed.delete(key)) return [];
    const out: string[] = [];
    for (const b of this.profile.bindings) {
      if (b.action === "hold" && b.key === key && this.pointerOwner === key) {
        this.pointerOwner = null;
        out.push(`input motionevent UP ${this.px(b.x, b.y).join(" ")}`);
      }
      if (b.action === "joystick" && [b.up, b.down, b.left, b.right].includes(key)) out.push(...this.updateJoystick(b));
    }
    return out;
  }

  /** Relâche tout (perte de focus de la fenêtre par exemple). */
  releaseAll(): string[] {
    const out: string[] = [];
    for (const k of [...this.pressed]) out.push(...this.keyUp(k));
    return out;
  }

  private updateJoystick(b: Extract<Binding, { action: "joystick" }>): string[] {
    let dx = (this.pressed.has(b.right) ? 1 : 0) - (this.pressed.has(b.left) ? 1 : 0);
    let dy = (this.pressed.has(b.down) ? 1 : 0) - (this.pressed.has(b.up) ? 1 : 0);
    const owner = "joystick";
    const [cx, cy] = this.px(b.x, b.y);
    if (dx === 0 && dy === 0) {
      if (this.pointerOwner !== owner) return [];
      this.pointerOwner = null;
      const pos = this.joyPos ?? { x: cx, y: cy };
      this.joyPos = null;
      return [`input motionevent UP ${pos.x} ${pos.y}`];
    }
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    const r = b.radius * this.screen.width;
    const target = { x: Math.round(cx + dx * r), y: Math.round(cy + dy * r) };
    const out: string[] = [];
    if (this.pointerOwner === null) {
      this.pointerOwner = owner;
      out.push(`input motionevent DOWN ${cx} ${cy}`);
    } else if (this.pointerOwner !== owner) {
      return [];
    }
    out.push(`input motionevent MOVE ${target.x} ${target.y}`);
    this.joyPos = target;
    return out;
  }
}
