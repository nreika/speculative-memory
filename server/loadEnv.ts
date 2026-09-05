/**
 * Tiny dependency-free .env loader for the Node server process.
 * Vite loads .env* for the client bundle; this makes the same files
 * visible to server.ts (GENERATION_BACKEND, COMFYUI_URL, ...).
 *
 * Later files override earlier ones; existing process.env always wins.
 */
import fs from "fs";
import path from "path";

const files = [".env", ".env.local", `.env.${process.env.NODE_ENV || "development"}`, `.env.${process.env.NODE_ENV || "development"}.local`];

for (const file of files) {
  const full = path.join(process.cwd(), file);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
