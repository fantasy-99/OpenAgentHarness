import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDist = path.join(repoRoot, "apps", "web", "dist");
const cliWebAssets = path.join(repoRoot, "apps", "cli", "dist", "webui");

const indexPath = path.join(webDist, "index.html");
const indexStats = await stat(indexPath).catch(() => null);
if (!indexStats?.isFile()) {
  throw new Error(`WebUI build not found at ${indexPath}. Run pnpm --filter @oah/web build first.`);
}

await mkdir(path.dirname(cliWebAssets), { recursive: true });
await rm(cliWebAssets, { recursive: true, force: true });
await cp(webDist, cliWebAssets, {
  recursive: true,
  force: true,
  preserveTimestamps: true
});

console.log(`Copied WebUI static bundle to ${path.relative(repoRoot, cliWebAssets)}`);
