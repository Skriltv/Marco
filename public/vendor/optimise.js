// Marco's adapter over d2ttk's vendored engine (see README.md).
// This is a 1:1 port of the optimise-mode logic from d2ttk's WeaponPage chunk:
// mode weights/favoured tables and the column-picker, calling the vendored
// stats/constants/build-code modules for perk effects, damage profiles and TTK.
//
// Import map (minified export -> meaning), derived from WeaponPage's imports:
//   stats.js:      e = perkEffect(name), f = computeTtk(args), n = normaliseName
//   constants.js:  a = STAT hashes,      G = guardianHp (230)
//   build-code.js: g = damageProfile(weapon, frameTable, exoticTable),
//                  h = frame damage table, f = exotic damage table

import { g as damageProfile, h as FRAME_TABLE, f as EXOTIC_TABLE, c as computeDisplay } from "./build-code.DxSnnzfm.js";
import { e as perkEffect, f as computeTtk, n as normName } from "./stats.mH12I4Q0.js";
import { a as STAT, G as GUARDIAN_HP } from "./constants.CnI7Hrdg.js";

const STAT_BY_NAME = {
  range: STAT.RANGE,
  stability: STAT.STABILITY,
  handling: STAT.HANDLING,
  aimAssistance: STAT.AIM_ASSISTANCE,
  reloadSpeed: STAT.RELOAD_SPEED,
};
const HASH_TO_NAME = Object.fromEntries(Object.entries(STAT_BY_NAME).map(([n, h]) => [h, n]));

// Verbatim from d2ttk (weights + favoured-perk bonus tables).
export const MODES = [
  { key: "lowest-ttk", label: "Lowest TTK", weights: { stability: 1, handling: 1 }, favoured: {}, ttkMode: "lowest" },
  { key: "easiest-ttk", label: "Easiest TTK", weights: { stability: 1, handling: 1 },
    favoured: { headseeker: 50, rampage: 40, "golden tricorn": 40, "target lock": 40, "kill clip": 30, frenzy: 30 }, ttkMode: "easiest" },
  { key: "best-feel", label: "Best feel", weights: { aimAssistance: 3, handling: 2, stability: 1 },
    favoured: { "moving target": 30, rangefinder: 25, "zen moment": 20, "opening shot": 25, "keep away": 20 } },
  { key: "most-reliable", label: "Most reliable", weights: { range: 2, stability: 2, handling: 2, reloadSpeed: 1 },
    favoured: { "zen moment": 25, "moving target": 20, rangefinder: 20, "fragile focus": 15 } },
  { key: "duelling", label: "Duelling", weights: { range: 3, stability: 3, aimAssistance: 2 },
    favoured: { rangefinder: 25, "zen moment": 25, "moving target": 20, "tap the trigger": 20 } },
];

function plugStatMods(plug) {
  const out = {};
  const add = (hash, v) => {
    const n = HASH_TO_NAME[hash];
    if (n) out[n] = (out[n] ?? 0) + v;
  };
  for (const m of plug.statModifiers ?? []) add(m.statHash, m.value);
  const eff = perkEffect(plug.name);
  if (eff) {
    const bonuses = eff.statBonuses ?? eff.tiers?.[eff.tiers.length - 1]?.statBonuses ?? [];
    for (const b of bonuses) add(b.statHash, b.value);
  }
  return out;
}

function cappedGain(cur, add) {
  return Math.min(100, cur + add) - Math.min(100, cur);
}

function scorePlug(plug, mode, stats) {
  const mods = plugStatMods(plug);
  let s = 0;
  for (const [stat, w] of Object.entries(mode.weights)) {
    s += w * cappedGain(stats[stat] ?? 0, mods[stat] ?? 0);
  }
  s += mode.favoured[normName(plug.name)] ?? 0;
  return s;
}

function currentStats(weapon) {
  const out = { range: 0, stability: 0, handling: 0, aimAssistance: 0, reloadSpeed: 0 };
  for (const st of weapon.stats ?? []) {
    const n = HASH_TO_NAME[st.statHash];
    if (n) out[n] = st.displayValue;
  }
  return out;
}

function bestTtkPlug(plugs, dmg, mode) {
  let best = null;
  for (const p of plugs) {
    const eff = perkEffect(p.name);
    const ttk = computeTtk({
      critDmg: dmg.crit, bodyDmg: dmg.body, rpm: dmg.rpm, burstSize: dmg.burstSize,
      mag: 30, damageMult: eff?.damageMult ?? 1, damageRamp: eff?.damageRamp ?? null,
      weaponStat: 200, guardianHp: GUARDIAN_HP, fireDelayMult: eff?.drawTimeMult ?? 1,
    });
    const fav = mode.favoured[normName(p.name)] ?? 0;
    const adjusted = ttk - (mode.ttkMode === "easiest" ? fav * 0.001 : 0);
    if (!best || adjusted < best.adjusted) best = { hash: p.hash, adjusted, ttk };
  }
  return best;
}

const SKIP_COLUMNS = new Set(["Intrinsic"]);
const TRAIT_COLUMNS = new Set(["Trait 1", "Trait 2"]);

/**
 * Clone of d2ttk's per-socket optimise picker. Returns null for mode "off".
 * { mode, picks: {socketIndex: plugHash}, stats (optimised), baseStats,
 *   dmg (damage profile incl. base optimalTtkSeconds), optimalTtk (seconds,
 *   for the picked trait roll in TTK modes; base profile TTK otherwise) }
 */
export function pickRoll(weapon, modeKey) {
  const mode = MODES.find((m) => m.key === modeKey) ?? null;
  if (!mode || !weapon?.sockets) return null;

  const dmg = damageProfile(weapon, FRAME_TABLE, EXOTIC_TABLE);
  const stats = currentStats(weapon);
  const baseStats = { ...stats };
  const picks = {};
  let pickedTtk = null;

  for (const socket of weapon.sockets) {
    if (SKIP_COLUMNS.has(socket.columnLabel) || (socket.plugs ?? []).length === 0) continue;

    if (mode.ttkMode && TRAIT_COLUMNS.has(socket.columnLabel) && dmg) {
      const best = bestTtkPlug(socket.plugs, dmg, mode);
      if (best) {
        picks[socket.socketIndex] = best.hash;
        if (pickedTtk === null || best.ttk < pickedTtk) pickedTtk = best.ttk;
      }
      continue;
    }

    let best = null;
    for (const p of socket.plugs) {
      const s = scorePlug(p, mode, stats);
      if (!best || s > best.score) best = { hash: p.hash, score: s, plug: p };
    }
    if (best) {
      picks[socket.socketIndex] = best.hash;
      const mods = plugStatMods(best.plug);
      for (const [n, v] of Object.entries(mods)) stats[n] = Math.min(100, (stats[n] ?? 0) + v);
    }
  }

  const optimalTtk = pickedTtk ?? dmg?.optimalTtkSeconds ?? null;
  return { mode, picks, stats, baseStats, dmg, optimalTtk };
}

/** Base damage profile (optimalTtkSeconds, crit/body, pattern) without a mode. */
export function baseProfile(weapon) {
  try { return damageProfile(weapon, FRAME_TABLE, EXOTIC_TABLE); } catch { return null; }
}

/// ---------------------------------------------------------------------------
/// Site-exact display model. computeDisplay is d2ttk's own calculator (the
/// function behind the weapon page's stat sidebar): it applies the selected
/// perks' modifiers to every stat, the Tier bonus, statGroup interpolation
/// curves, and returns the roll's crit/body TTK.
/// ---------------------------------------------------------------------------

/** Mirror of the site's mount effect: fixed-roll weapons (every non-intrinsic
 * socket has exactly one plug) start fully selected; random rolls start empty. */
export function defaultSelections(weapon) {
  const sockets = (weapon.sockets ?? []).filter(
    (s) => s.columnLabel !== "Intrinsic" && (s.plugs ?? []).length > 0,
  );
  if (sockets.length > 0 && sockets.every((s) => s.plugs.length === 1)) {
    const out = {};
    for (const s of sockets) out[s.socketIndex] = s.plugs[0].hash;
    return out;
  }
  return {};
}

/**
 * Run the site's display calculator with its default state (Tier 5 where
 * supported, weapon stat 100, enhanced perks on, no buffs) plus the given
 * perk selection. picks null/undefined = the site's initial view.
 * Returns Sa's full result: { displayStats, orderedStats, derivedStats,
 * pvpDmg: {critTtk, bodyTtk, critDmg, bodyDmg, critShots, bodyShots, pattern},
 * rpm, baseRpm, activeEffects, ... } or null on failure.
 */
export function displayFor(weapon, statGroup, picks) {
  try {
    const selected = { ...defaultSelections(weapon), ...(picks ?? {}) };
    return computeDisplay(weapon, statGroup ?? null, {
      selectedPerks: selected,
      selectedTier: weapon.supportsTiering ? 5 : 1,
      weaponStat: 100,
      activatedPerks: new Map(),
      activeBuffs: new Map(),
      useEnhanced: true,
    });
  } catch (e) {
    console.error("displayFor failed:", e);
    return null;
  }
}
