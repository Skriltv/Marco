# Marco

A Windows desktop companion app for Destiny 2.

Marco bundles six tools behind one tab bar: an AHK macro manager, a native loadout swapper (no AutoHotkey required), an on-screen weapon/perk overlay with OCR auto-detection, a bulk Bungie.net code redeemer, and DIM / Godroll.tv / D2ArmorPicker docked in as real browser tabs — plus multi-account support so multiple Bungie logins can stay signed in side by side.

![Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)
![Tauri](https://img.shields.io/badge/built%20with-Tauri%20v2-24C8DB)

---

## Features

- **Macros** — Write, edit, and run `.ahk` scripts with global hotkeys, live folder watching, and versioned backups on every save.
- **Loadouts** — Calibrate up to 20 gear slots and swap them instantly with a hotkey, using native Win32 input (no AutoHotkey needed).
- **Overlay** — A floating, always-on-top panel showing weapon stats, TTK, and perks — with OCR that auto-detects the weapon you're inspecting in-game.
- **Redeem** — Bulk-redeem Bungie.net codes from a list, with live progress and automatic retries.
- **DIM & Destiny Sites** — DIM, Godroll.tv, D2TTK, and D2ArmorPicker embedded as full native tabs (real login, cookies, sessions).
- **Multi-account** — Keep several Bungie logins signed in at once, each with its own isolated profile.
- **Themeable UI** — 8 accent themes, reorderable/hideable tabs, and configurable global hotkeys throughout.

---

## Requirements

- Windows 10 or 11 (64-bit)
- [AutoHotkey v1.1](https://www.autohotkey.com/) (only needed for the Macros tab)
- WebView2 runtime (preinstalled on current Windows 10/11)

---

## Building from source

**Prerequisites**

- Windows 10/11 (64-bit)
- [Node.js](https://nodejs.org/) 18+ and [pnpm](https://pnpm.io/installation) (`npm install -g pnpm`)
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain, installed via `rustup`)
- The [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/) for Windows — mainly the MSVC C++ build tools (via Visual Studio Build Tools) and the WebView2 runtime (preinstalled on current Windows 10/11)

**Steps**

```sh
# 1. Clone the repo
git clone https://github.com/<your-username>/marco.git
cd marco

# 2. Install JS dependencies
pnpm install

# 3. Run in dev mode (hot-reload, opens the app window)
pnpm tauri dev

# 4. Build a release binary + NSIS installer
pnpm tauri build
```

- `pnpm tauri dev` compiles the Rust backend and launches Marco with the Vite dev server attached, so front-end edits hot-reload.
- `pnpm tauri build` produces the release executable at `src-tauri/target/release/marco.exe` and, since `bundle.targets` includes `nsis`, a Windows installer under `src-tauri/target/release/bundle/nsis/`.

**Optional: building the Inno Setup installer instead**

The repo also ships an Inno Setup script (`installer/Marco.iss`) used for release builds. To use it instead of Tauri's built-in NSIS bundler:

```sh
pnpm install
pnpm tauri build --no-bundle      # compiles src-tauri/target/release/marco.exe only
ISCC installer/Marco.iss          # requires Inno Setup 6+: https://jrsoftware.org/isinfo.php
```

The output installer lands in `installer/output/Marco_<version>_x64-setup.exe`.

---

## Releasing updates

- **Versioning**: run `pnpm run release` instead of `pnpm tauri build` to build with an incremented version. It bumps the patch version (e.g. `1.0.0` -> `1.0.1`) in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, the in-app Settings screen, and `installer/Marco.iss` via `scripts/bump-version.mjs`, then runs `tauri build`. (Plain `pnpm tauri build` will **not** bump the version — Tauri reads `tauri.conf.json`'s version before any build hook can run, so the bump has to happen as a separate step first.) Bump without building: `pnpm run version:bump`.
- **In-app updates**: Marco's "Check for updates" button reads from `https://github.com/Skriltv/Marco/releases/latest/download/latest.json`. To publish a version so existing installs can find it:
  1. Bump + commit the version (`pnpm run version:bump`, or just let the next build do it), then tag it, e.g. `git tag v1.0.1 && git push origin v1.0.1`.
  2. Pushing that tag triggers `.github/workflows/release.yml`, which builds Marco on `windows-latest` and publishes a GitHub Release with the installer, its signature, and a `latest.json` manifest attached.
  3. That workflow needs a `TAURI_SIGNING_PRIVATE_KEY` (and optionally `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) repo secret — the private half of the minisign keypair matching the `pubkey` already set in `src-tauri/tauri.conf.json`. If you don't have that private key, generate a fresh pair with `pnpm tauri signer generate` and swap in the new public key.

## Notes

- Weapon stats/TTK math and perk data reuse d2ttk.com's own client-side engine; community roll data is decoded from Godroll.tv's encoding.
- All settings and account data are stored locally (`localStorage` + a `profiles/` folder next to the executable) — nothing is sent anywhere except the sites you're already using.
- All rights reserved.

---

## Credits

- Aste: For the general idea and features it should have & Implementing the real in time game overlay for perks. 
- Poofafysh: Built the general structuring for the app and macro feature.
- Skril: Fully coded and brought the idea to life and cleaned up the design and overlay UI. 
