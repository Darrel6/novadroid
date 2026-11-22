// Diagnostic en ligne de commande : npm run doctor
import { accelerationHelp, checkAcceleration } from "../core/emulator";
import { listInstances } from "../core/instances";
import { run } from "../core/run";
import { hostOS, sdkPaths, sdkStatus } from "../core/sdk";

(async () => {
  const paths = sdkPaths();
  const s = sdkStatus(paths);
  const mark = (ok: boolean) => (ok ? "OK " : "-- ");
  console.log(`NovaDroid : diagnostic (${hostOS()}, ${process.arch})`);
  console.log(`Dossier de données : ${paths.root}`);
  console.log(`${mark(s.cmdlineTools)} Outils en ligne de commande Android`);
  console.log(`${mark(s.emulator)} Émulateur`);
  console.log(`${mark(s.platformTools)} ADB`);
  if (s.emulator) {
    const a = await checkAcceleration(paths, run);
    console.log(`${mark(a.ok)} Accélération matérielle`);
    if (!a.ok) console.log(`    ${accelerationHelp()}\n    ${a.details.split("\n").join("\n    ")}`);
  }
  const inst = listInstances(paths);
  console.log(`Instances : ${inst.length ? inst.map((i) => i.id).join(", ") : "aucune"}`);
})();
