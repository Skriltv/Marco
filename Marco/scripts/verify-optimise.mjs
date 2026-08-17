// Dev-only accuracy harness: for a set of diverse weapons, fetch the live
// d2ttk page, run Marco's vendored display pipeline with the site's default
// state, and assert our computed Optimal/Body TTK matches the TTK the site
// itself server-rendered into the page. Run from the repo root:
//   node scripts/verify-optimise.mjs
import { pickRoll, displayFor, MODES } from "../public/vendor/optimise.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Marco";

// name -> hash, picked for variety: pulse, hand cannon, SMG, sniper, exotic AR.
const WEAPONS = {
  "Nightshade (pulse)": 34731066,
};

async function loadBrowseList() {
  const r = await fetch("https://d2ttk.com/data/weapons.json", { headers: { "user-agent": UA } });
  return r.json();
}

function unwrap(v) {
  if (Array.isArray(v) && v.length === 2 && v[0] === 0) return unwrapVal(v[1]);
  if (Array.isArray(v) && v.length === 2 && v[0] === 1) return v[1].map(unwrap);
  return v;
}
function unwrapVal(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = {};
    for (const k in v) o[k] = unwrap(v[k]);
    return o;
  }
  return v;
}

function decodeEntities(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

async function fetchWeapon(hash) {
  const r = await fetch(`https://d2ttk.com/weapons/${hash}/`, { headers: { "user-agent": UA } });
  const html = await r.text();
  const m = html.match(/component-url="[^"]*WeaponPage[^"]*"[^>]*props="([^"]*)"/);
  if (!m) throw new Error("no island props");
  const props = JSON.parse(decodeEntities(m[1]));
  const pageTtk = (label) => {
    const i = html.indexOf(label);
    if (i < 0) return null;
    const win = html.slice(i, i + 400);
    const mm = win.match(/(\d+(?:\.\d+)?)(?:<!-- -->)?s/);
    return mm ? Number(mm[1]) : null;
  };
  return {
    weapon: unwrapVal(props.weapon[1]),
    statGroup: props.statGroup ? unwrapVal(props.statGroup[1]) : null,
    pageOptimal: pageTtk("Optimal TTK"),
    pageBody: pageTtk("Body TTK"),
    html,
  };
}

function approx(a, b) {
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 0.006; // page rounds to 2dp
}

const list = await loadBrowseList();
// Add variety by type from the live list.
for (const t of ["Hand Cannon", "Submachine Gun", "Sniper Rifle"]) {
  const w = list.find((x) => x.typeName === t && x.tierName === "Legendary");
  if (w) WEAPONS[`${w.name} (${t})`] = w.hash;
}
const exotic = list.find((x) => x.tierName === "Exotic" && x.typeName === "Auto Rifle");
if (exotic) WEAPONS[`${exotic.name} (exotic AR)`] = exotic.hash;

let failures = 0;
for (const [label, hash] of Object.entries(WEAPONS)) {
  const { weapon, statGroup, pageOptimal, pageBody } = await fetchWeapon(hash);
  const disp = displayFor(weapon, statGroup, null);
  const ours = disp?.ttk ?? null;
  const okO = approx(ours?.critTtk, pageOptimal);
  const okB = approx(ours?.bodyTtk, pageBody);
  if (!okO || !okB) failures++;
  console.log(
    `${okO && okB ? "PASS" : "FAIL"} ${label}: ours optimal=${ours?.critTtk} body=${ours?.bodyTtk} | page optimal=${pageOptimal} body=${pageBody}`,
  );
  if (label.startsWith("Nightshade")) {
    console.log("  displayStats sample:", JSON.stringify((disp?.displayStats ?? []).slice(0, 3)));
    console.log("  ttk:", JSON.stringify(ours), "showTtk:", disp?.showTtk);
    console.log("  derivedStats:", JSON.stringify(disp?.derivedStats).slice(0, 300));
    for (const mode of MODES) {
      const roll = pickRoll(weapon, mode.key);
      const names = {};
      for (const s of weapon.sockets) {
        const h = roll.picks[s.socketIndex];
        if (h) names[s.columnLabel] = s.plugs.find((p) => p.hash === h)?.name;
      }
      const optDisp = displayFor(weapon, statGroup, roll.picks);
      console.log(`  ${mode.key}: ${JSON.stringify(names)} -> TTK ${optDisp?.ttk?.critTtk}`);
    }
  }
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
