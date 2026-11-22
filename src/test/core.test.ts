import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cmdlineToolsUrl, requiredPackages, sdkPaths, systemImagePackage } from "../core/sdk";
import { parseSdkmanagerPercent, unzipCommand } from "../core/installer";
import {
  createInstance,
  deleteInstance,
  hardwareConfig,
  listInstances,
  parseIni,
  toInstanceId,
} from "../core/instances";
import { emulatorArgs, nextFreePort } from "../core/emulator";
import { assertPackageName, parseDevices, parsePackages, parseWmSize } from "../core/adb";
import { KeymapEngine, validateProfile } from "../core/keymap";
import { Runner } from "../core/run";

test("chemins du SDK selon l'OS", () => {
  const w = sdkPaths("windows", "C:\\Users\\a\\AppData\\Local\\NovaDroid");
  assert.equal(w.emulator, "C:\\Users\\a\\AppData\\Local\\NovaDroid\\sdk\\emulator\\emulator.exe");
  assert.ok(w.sdkmanager.endsWith("cmdline-tools\\latest\\bin\\sdkmanager.bat"));
  const l = sdkPaths("linux", "/home/a/.local/share/novadroid");
  assert.equal(l.adb, "/home/a/.local/share/novadroid/sdk/platform-tools/adb");
  assert.match(cmdlineToolsUrl("windows", "1"), /commandlinetools-win-1_latest\.zip$/);
});

test("paquets requis pour une image", () => {
  const img = { api: 35, variant: "google_apis_playstore", abi: "x86_64" } as const;
  assert.equal(systemImagePackage(img), "system-images;android-35;google_apis_playstore;x86_64");
  assert.deepEqual(requiredPackages(img).slice(0, 3), ["platform-tools", "emulator", "platforms;android-35"]);
});

test("extraction et progression de sdkmanager", () => {
  assert.equal(unzipCommand("windows", "a.zip", "d")[0], "tar");
  assert.equal(unzipCommand("linux", "a.zip", "d")[0], "unzip");
  assert.equal(parseSdkmanagerPercent("[=====    ] 42% Downloading x"), 42);
  assert.equal(parseSdkmanagerPercent("rien"), undefined);
});

test("identifiants d'instance", () => {
  assert.equal(toInstanceId("Jeux d'action é"), "Jeux_d_action_e");
  assert.throws(() => toInstanceId("!!!"));
});

test("configuration matérielle : GPU de l'hôte et paysage", () => {
  const cfg = hardwareConfig({ ramMb: 4096, cpuCores: 4, width: 1920, height: 1080, dpi: 320, dataPartitionGb: 16 });
  assert.equal(cfg["hw.gpu.mode"], "host");
  assert.equal(cfg["hw.initialOrientation"], "landscape");
  assert.equal(cfg["disk.dataPartition.size"], "16G");
});

test("création, liste et suppression d'instances (avdmanager simulé)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-"));
  const paths = sdkPaths("linux", root);
  const calls: string[][] = [];
  const fake: Runner = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    assert.equal(opts?.input, "no\n");
    // Simule ce que fait avdmanager sur le disque.
    const id = args[args.indexOf("--name") + 1];
    mkdirSync(path.join(paths.avdHome, `${id}.avd`), { recursive: true });
    writeFileSync(path.join(paths.avdHome, `${id}.ini`), "path=x\n");
    writeFileSync(path.join(paths.avdHome, `${id}.avd`, "config.ini"), "image.sysdir.1=system-images/android-35/\nhw.ramSize=1536\n");
    return { code: 0, stdout: "", stderr: "" };
  };
  await createInstance(paths, fake, "Ma partie", { api: 35, variant: "default", abi: "x86_64" });
  assert.equal(calls[0][0], paths.avdmanager);
  assert.ok(calls[0].includes("system-images;android-35;default;x86_64"));
  const cfg = parseIni(readFileSync(path.join(paths.avdHome, "Ma_partie.avd", "config.ini"), "utf8"));
  assert.equal(cfg["hw.ramSize"], "4096");
  assert.equal(cfg["image.sysdir.1"], "system-images/android-35/");
  const list = listInstances(paths);
  assert.equal(list.length, 1);
  assert.equal(list[0].settings.width, 1920);
  assert.equal(list[0].name, "Ma partie");
  deleteInstance(paths, "Ma_partie");
  assert.equal(listInstances(paths).length, 0);
});

test("arguments de l'émulateur et ports", () => {
  const args = emulatorArgs("A", { port: 5556, gpu: "host", coldBoot: true, grpcPort: 8554 });
  assert.deepEqual(args.slice(0, 6), ["-avd", "A", "-port", "5556", "-gpu", "host"]);
  assert.ok(args.includes("-no-snapshot-load"));
  assert.ok(args.includes("-grpc"));
  assert.equal(nextFreePort([]), 5554);
  assert.equal(nextFreePort([5554, 5556]), 5558);
});

test("analyse des sorties adb", () => {
  assert.deepEqual(parseDevices("List of devices attached\nemulator-5554\tdevice\n\n"), [
    { serial: "emulator-5554", state: "device" },
  ]);
  assert.deepEqual(parsePackages("package:com.b.game\r\npackage:com.a.game\n"), ["com.a.game", "com.b.game"]);
  assert.deepEqual(parseWmSize("Physical size: 1080x1920\nOverride size: 1920x1080"), { width: 1920, height: 1080 });
  assert.throws(() => assertPackageName("com.x; rm -rf /"));
  assertPackageName("com.supercell.clashroyale");
});

const profile = validateProfile({
  name: "Test",
  bindings: [
    { action: "tap", key: "Space", x: 0.5, y: 0.5 },
    { action: "hold", key: "KeyF", x: 0.9, y: 0.5 },
    { action: "keyevent", key: "Escape", code: "KEYCODE_BACK" },
    { action: "joystick", up: "KeyW", down: "KeyS", left: "KeyA", right: "KeyD", x: 0.2, y: 0.8, radius: 0.05 },
  ],
});

test("mapping : tap, keyevent et répétition ignorée", () => {
  const e = new KeymapEngine(profile, { width: 1920, height: 1080 });
  assert.deepEqual(e.keyDown("Space"), ["input tap 960 540"]);
  assert.deepEqual(e.keyDown("Space"), []);
  assert.deepEqual(e.keyUp("Space"), []);
  assert.deepEqual(e.keyDown("Escape"), ["input keyevent KEYCODE_BACK"]);
});

test("mapping : joystick WASD", () => {
  const e = new KeymapEngine(profile, { width: 1920, height: 1080 });
  // centre (384, 864), rayon 96 px
  assert.deepEqual(e.keyDown("KeyW"), ["input motionevent DOWN 384 864", "input motionevent MOVE 384 768"]);
  const diag = e.keyDown("KeyD");
  assert.equal(diag.length, 1);
  assert.match(diag[0], /^input motionevent MOVE 452 796$/);
  // Un appui maintenu ne peut pas voler le doigt du joystick.
  assert.deepEqual(e.keyDown("KeyF"), []);
  e.keyUp("KeyW");
  assert.deepEqual(e.keyUp("KeyD"), ["input motionevent UP 480 864"]);
  assert.deepEqual(e.releaseAll(), []);
});

test("mapping : appui maintenu", () => {
  const e = new KeymapEngine(profile, { width: 1000, height: 500 });
  assert.deepEqual(e.keyDown("KeyF"), ["input motionevent DOWN 900 250"]);
  assert.deepEqual(e.releaseAll(), ["input motionevent UP 900 250"]);
});

test("profil invalide refusé", () => {
  assert.throws(() => validateProfile({ name: "x", bindings: [{ action: "tap", key: "A", x: 2, y: 0 }] }));
  assert.throws(() => validateProfile({ name: "x", bindings: [{ action: "keyevent", key: "A", code: "rm" }] }));
});

test("profil fourni valide", () => {
  const p = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "keymaps", "fps-moba-defaut.json"), "utf8"));
  assert.equal(validateProfile(p).bindings.length, 8);
});

test("Java : URL, détection et environnement", async () => {
  const { jdkUrl, findJavaHome } = await import("../core/sdk");
  assert.match(jdkUrl("windows", "x64"), /\/21\/ga\/windows\/x64\/jdk\//);
  const paths = sdkPaths("windows", "C:\\N");
  const home = findJavaHome(paths, "windows", (p) => p === "C:\\N\\jdk\\jdk-21.0.5+11\\bin\\java.exe", () => ["jdk-21.0.5+11"]);
  assert.equal(home, "C:\\N\\jdk\\jdk-21.0.5+11");
  assert.equal(findJavaHome(paths, "windows", () => false, () => []), undefined);
});

test("guillemets pour les scripts .bat", async () => {
  const { quoteForCmd } = await import("../core/run");
  assert.equal(quoteForCmd("--sdk_root=C:\\Users\\Jean Paul\\sdk"), '"--sdk_root=C:\\Users\\Jean Paul\\sdk"');
  assert.equal(quoteForCmd("platform-tools"), "platform-tools");
});

test("erreurs de l'émulateur traduites", async () => {
  const { explainEmulatorFailure, tailLog } = await import("../core/emulator");
  assert.match(explainEmulatorFailure("ERROR | x86_64 emulation currently requires hardware acceleration!", "win32"), /accélération/);
  assert.match(explainEmulatorFailure("PANIC: Cannot find AVD system path."), /image système/);
  assert.match(explainEmulatorFailure("rien de connu"), /arrêté/);
  assert.equal(tailLog("a\n\nb\nc", 2), "b\nc");
});
