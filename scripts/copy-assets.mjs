import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/renderer/fonts", { recursive: true });
for (const f of ["index.html", "styles.css"]) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);
cpSync("node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2", "dist/renderer/fonts/bricolage.woff2");
cpSync("node_modules/@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2", "dist/renderer/fonts/figtree.woff2");
cpSync("keymaps", "dist/keymaps", { recursive: true });
cpSync("assets/logo.svg", "dist/renderer/logo.svg");
cpSync("assets/icon.png", "dist/icon.png");
