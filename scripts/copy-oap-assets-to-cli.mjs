import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "template", "deploy-root");
const targetRoot = path.join(repoRoot, "apps", "cli", "dist", "assets", "deploy-root");

await rm(targetRoot, { recursive: true, force: true });
await cp(sourceRoot, targetRoot, { recursive: true });

console.log(`Copied OAP deploy-root assets to ${path.relative(repoRoot, targetRoot)}`);
