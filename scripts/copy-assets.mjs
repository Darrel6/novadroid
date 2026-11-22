import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/renderer", { recursive: true });
for (const f of ["index.html", "styles.css"]) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);
cpSync("keymaps", "dist/keymaps", { recursive: true });
