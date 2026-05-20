/**
 * Copy repo-root magda-eval assets into public/magda-eval for static fetch in the browser.
 * Run from magda-web-client: yarn sync-magda-eval
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_CLIENT_ROOT = path.resolve(__dirname, "..");
const SRC = path.resolve(WEB_CLIENT_ROOT, "../../magda-eval");
const DEST = path.join(WEB_CLIENT_ROOT, "public", "magda-eval");

if (!fs.existsSync(SRC)) {
    console.error(`Source not found: ${SRC}`);
    process.exit(1);
}

fs.mkdirSync(path.dirname(DEST), { recursive: true });
if (fs.existsSync(DEST)) {
    fs.rmSync(DEST, { recursive: true });
}
fs.cpSync(SRC, DEST, { recursive: true });
console.log(`Copied magda-eval → ${DEST}`);
