# Marco

A Windows desktop companion app for Destiny 2 — built with **Tauri v2 (Rust) + React + TypeScript**.

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

## Install

Grab the latest installer from the [Releases](../../releases) page and run it.

## Build from source

```bash
pnpm install        # once
pnpm tauri dev      # run with hot reload
pnpm tauri build    # produce an NSIS installer
```

The installer will be at `src-tauri/target/release/bundle/nsis/Marco_<version>_x64-setup.exe`.

<details>
<summary>Packaging with Inno Setup instead</summary>

```bash
pnpm install
pnpm tauri build --no-bundle
cd installer
ISCC Marco.iss      # requires Inno Setup 6+
```

Produces `installer/output/Marco_<version>_x64-setup.exe`. Bump `MyAppVersion` in `Marco.iss` to match `tauri.conf.json`'s `version` before each release.
</details>

---

## Project layout

```
src/            React frontend (tabs, panels, settings)
public/         Overlay/calibration windows, vendored d2ttk assets
src-tauri/      Rust backend (macros, hotkeys, OCR overlay, loadout swaps, embedded webviews)
installer/      Inno Setup packaging script
```

---

## Notes

- Weapon stats/TTK math and perk data reuse d2ttk.com's own client-side engine; community roll data is decoded from Godroll.tv's encoding.
- All settings and account data are stored locally (`localStorage` + a `profiles/` folder next to the executable) — nothing is sent anywhere except the sites you're already using.
- All rights reserved.
