// Bumps the patch version everywhere it's referenced. Run via
// `pnpm run release` (bumps, then runs `tauri build`) — not part of the
// Tauri build hooks, since tauri.conf.json's version is read before any
// build hook runs, so editing it from inside one is too late.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Skip in CI: the release workflow builds an already-tagged version, so
// bumping again here would make the build drift from the git tag.
if (process.env.CI) {
  console.log("CI detected — skipping version bump.");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const packageJsonPath = path.join(root, "package.json");
const tauriConfPath = path.join(root, "src-tauri", "tauri.conf.json");
const cargoTomlPath = path.join(root, "src-tauri", "Cargo.toml");
const settingsModalPath = path.join(root, "src", "components", "SettingsModal.tsx");
const issPath = path.join(root, "installer", "Marco.iss");

function bumpPatch(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Unrecognized version format: "${version}"`);
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

function replaceVersion(filePath, pattern) {
  const content = readFileSync(filePath, "utf8");
  writeFileSync(filePath, content.replace(pattern, `$1${newVersion}$2`));
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const oldVersion = packageJson.version;
const newVersion = bumpPatch(oldVersion);

packageJson.version = newVersion;
writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");

replaceVersion(tauriConfPath, /("version"\s*:\s*")\d+\.\d+\.\d+(")/);
replaceVersion(cargoTomlPath, /(^version\s*=\s*")\d+\.\d+\.\d+(")/m);
replaceVersion(settingsModalPath, /(const APP_VERSION = ")\d+\.\d+\.\d+(";)/);

try {
  replaceVersion(issPath, /(#define MyAppVersion ")\d+\.\d+\.\d+(")/);
} catch {
  // Inno Setup script is optional.
}

console.log(`Version bumped: ${oldVersion} -> ${newVersion}`);
