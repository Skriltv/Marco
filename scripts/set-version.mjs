// Sets the app version everywhere from a git tag, e.g. "v1.2.3" -> "1.2.3".
// Run by the release workflow (.github/workflows/release.yml) right after
// checkout, before the Tauri build. The git tag is the single source of
// truth for the version — nobody should hand-edit a version number in
// package.json, tauri.conf.json, Cargo.toml, or the installer script again.
//
// Usage: node scripts/set-version.mjs v1.2.3

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const tag = process.argv[2];
if (!tag) {
  console.error("Usage: node scripts/set-version.mjs <tag>");
  process.exit(1);
}

const match = tag.match(/^v?(\d+\.\d+\.\d+)$/);
if (!match) {
  console.error(`Tag "${tag}" doesn't look like a version tag (expected e.g. "v1.2.3").`);
  process.exit(1);
}
const version = match[1];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const packageJsonPath = path.join(root, "package.json");
const tauriConfPath = path.join(root, "src-tauri", "tauri.conf.json");
const cargoTomlPath = path.join(root, "src-tauri", "Cargo.toml");
const issPath = path.join(root, "installer", "Marco.iss");

function replaceVersion(filePath, pattern) {
  const content = readFileSync(filePath, "utf8");
  writeFileSync(filePath, content.replace(pattern, `$1${version}$2`));
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
packageJson.version = version;
writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");

replaceVersion(tauriConfPath, /("version"\s*:\s*")\d+\.\d+\.\d+(")/);
replaceVersion(cargoTomlPath, /(^version\s*=\s*")\d+\.\d+\.\d+(")/m);

try {
  replaceVersion(issPath, /(#define MyAppVersion ")\d+\.\d+\.\d+(")/);
} catch {
  // Inno Setup script is optional.
}

console.log(`Version set to ${version} (from tag ${tag})`);
