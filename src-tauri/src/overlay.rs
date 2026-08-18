//! Phase 2: d2ttk in-game overlay + OCR weapon identifier.
//!
//! Weapon database comes from d2ttk's own public JSON (no Bungie API key),
//! cached next to the exe. The overlay is an always-on-top frameless window
//! (overlay.html) hosting the live d2ttk weapon page as a child webview.
//! Detection captures a user-calibrated screen region, OCRs it with the
//! Windows built-in engine, and fuzzy-matches against the weapon list.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

const WEAPON_DB_URL: &str = "https://d2ttk.com/data/weapons.json";
const DB_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);
/// Per-weapon detail cache (TTK/perks/stats) age limit. Independent of, and
/// shorter than nothing special — same window as the master list — but the
/// point is just that this now HAS an expiry at all. Previously detail
/// files were cached forever (only ever invalidated by the "v" format-
/// version bump), so a sandbox update that revamps a weapon's perks/TTK on
/// d2ttk's site never got picked up here once that weapon had already been
/// detected once. See also: purge_all_weapon_detail_cache, which drops
/// every detail file the moment the master list actually changes, so a
/// revamp is picked up immediately rather than waiting out this window.
const DETAIL_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);
/// The independent overlay panels; each is its own always-on-top window
/// loading overlay.html?panel=<kind>. (w, h) are creation defaults — the user
/// resizes/moves them freely afterward and overlay.html persists that.
/// (TTK is merged into the stats panel per user request.)
const PANELS: [(&str, &str, f64, f64); 2] = [
    ("overlay_stats", "stats", 280.0, 520.0),
    ("overlay_perks", "perks", 310.0, 340.0),
];

/// d2ttk serves empty bodies to requests without a browser-ish User-Agent.
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Marco";

async fn fetch_text(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent(UA)
        .build()
        .map_err(|e| format!("{e}"))?;
    let resp = client.get(url).send().await.map_err(|e| format!("fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("fetch failed: HTTP {} for {url}", resp.status()));
    }
    resp.text().await.map_err(|e| format!("read failed: {e}"))
}

fn data_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("data")))
        .unwrap_or_else(|| PathBuf::from("data"))
}

fn db_path() -> PathBuf {
    data_dir().join("weapons.json")
}

/// Append-only diagnostic log for the DIM-search focus-steal path
/// specifically. This runs in a packaged release build with no visible
/// console, and every Win32 call along the focus-steal path was previously
/// swallowed with `let _ =`, so when it silently fails in the field there's
/// no way to tell *which* step failed without this. Kept intentionally
/// narrow (just this one feature) rather than a general logging framework.
fn log_dim(msg: impl AsRef<str>) {
    use std::io::Write;
    let path = data_dir().join("dim-search.log");
    let _ = std::fs::create_dir_all(data_dir());
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let ts = chrono::Local::now().format("%H:%M:%S%.3f");
        let _ = writeln!(f, "[{ts}] {}", msg.as_ref());
    }
}

// ---------------------------------------------------------------------------
// Weapon database
// ---------------------------------------------------------------------------

/// The subset of d2ttk's weapon record the detection loop needs in memory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeaponEntry {
    pub hash: u64,
    pub name: String,
    /// d2ttk marks the old copy of a reworked weapon `true` and the current
    /// (reissued/revamped) copy `false`. This is the primary signal for
    /// picking which same-named entry OCR matching should resolve to.
    pub superseded: bool,
    /// Monotonically increasing d2ttk release number. Used as a tiebreaker
    /// when `superseded` doesn't disambiguate (e.g. missing/absent on older
    /// records, or genuinely equal) — higher wins.
    pub release_version: i64,
}

pub struct WeaponDbState {
    pub weapons: Mutex<Vec<WeaponEntry>>,
}

fn cache_is_fresh() -> bool {
    db_path()
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .map(|age| age < DB_MAX_AGE)
        .unwrap_or(false)
}

async fn fetch_db_to_cache() -> Result<(), String> {
    let body = fetch_text(WEAPON_DB_URL).await.map_err(|e| format!("weapon DB {e}"))?;
    // Only cache if it actually parses as the expected array.
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("weapon DB isn't valid JSON: {e}"))?;
    if !parsed.is_array() {
        return Err("weapon DB JSON isn't an array".into());
    }
    // If the master list actually changed content (not just a re-fetch of
    // identical data), a sandbox update may have touched any weapon in it —
    // drop every per-weapon detail cache so revamped weapons refetch on
    // next view instead of waiting out DETAIL_MAX_AGE.
    let old = std::fs::read_to_string(db_path()).ok();
    let changed = old.as_deref() != Some(body.as_str());
    let _ = std::fs::create_dir_all(data_dir());
    std::fs::write(db_path(), &body).map_err(|e| format!("couldn't cache weapon DB: {e}"))?;
    if changed {
        purge_all_weapon_detail_cache();
    }
    Ok(())
}

/// Delete every cached per-weapon detail file (weapon_<hash>.json and
/// godroll_<hash>.json). Called when the master weapon list changes, since
/// that's the signal a game/sandbox update may have revamped any weapon.
fn purge_all_weapon_detail_cache() {
    let Ok(entries) = std::fs::read_dir(data_dir()) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if (name.starts_with("weapon_") || name.starts_with("godroll_")) && name.ends_with(".json") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn load_names_into_state(app: &AppHandle) -> Result<usize, String> {
    let s = std::fs::read_to_string(db_path()).map_err(|e| format!("{e}"))?;
    let parsed: Vec<serde_json::Value> = serde_json::from_str(&s).map_err(|e| format!("{e}"))?;
    let list: Vec<WeaponEntry> = parsed
        .iter()
        .filter_map(|w| {
            Some(WeaponEntry {
                hash: w.get("hash")?.as_u64()?,
                name: w.get("name")?.as_str()?.to_string(),
                // Absent on any record => treat as not-superseded/oldest so
                // it never wins a tiebreak it has no data for.
                superseded: w.get("superseded").and_then(|v| v.as_bool()).unwrap_or(false),
                release_version: w.get("releaseVersion").and_then(|v| v.as_i64()).unwrap_or(0),
            })
        })
        .collect();
    let count = list.len();
    let state = app.state::<WeaponDbState>();
    *state.weapons.lock().map_err(|e| e.to_string())? = list;
    Ok(count)
}

/// Returns the full d2ttk weapon DB (fetching/refreshing the cache if needed)
/// and loads the name→hash list into memory for the detection loop.
#[tauri::command]
pub async fn get_weapon_db(app: AppHandle, force: Option<bool>) -> Result<serde_json::Value, String> {
    if force.unwrap_or(false) || !cache_is_fresh() {
        if let Err(e) = fetch_db_to_cache().await {
            // Stale cache beats no data — only hard-fail if there's no cache at all.
            if !db_path().exists() {
                return Err(e);
            }
            eprintln!("weapon DB refresh failed, using stale cache: {e}");
        }
    }
    load_names_into_state(&app)?;
    let s = std::fs::read_to_string(db_path()).map_err(|e| format!("{e}"))?;
    serde_json::from_str(&s).map_err(|e| format!("{e}"))
}

// ---------------------------------------------------------------------------
// Per-weapon detail (TTK + full perk columns with icons)
// ---------------------------------------------------------------------------
// d2ttk's per-weapon pages are statically generated, so the TTK values and
// every perk (aria-label + bungie.net icon <img>) are present in the raw HTML.
// We fetch once per weapon and cache the parsed result.

fn detail_path(hash: u64) -> PathBuf {
    data_dir().join(format!("weapon_{hash}.json"))
}

fn find_after<'a>(html: &'a str, marker: &str) -> Option<&'a str> {
    html.find(marker).map(|i| &html[i + marker.len()..])
}

fn html_entity_decode(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Strip Astro's props serialization wrappers: [0, value] = literal,
/// [1, [..]] = array of wrapped values; objects wrap each field.
fn astro_unwrap(v: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    if let Value::Array(a) = v {
        if a.len() == 2 {
            if a[0] == Value::from(0) {
                return astro_unwrap_inner(&a[1]);
            }
            if a[0] == Value::from(1) {
                if let Value::Array(items) = &a[1] {
                    return Value::Array(items.iter().map(astro_unwrap).collect());
                }
            }
        }
    }
    astro_unwrap_inner(v)
}

fn astro_unwrap_inner(v: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match v {
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), astro_unwrap(x))).collect()),
        other => other.clone(),
    }
}

/// The full props embedded in the page's WeaponPage astro-island:
/// { weapon, statGroup } — both needed by the site's display calculator.
fn extract_island_props(html: &str) -> Option<serde_json::Value> {
    // Find the island whose component-url mentions WeaponPage, then its props attr.
    let island_at = html.find("component-url=\"/_astro/WeaponPage")?;
    let after = &html[island_at..];
    let props_start = after.find("props=\"")? + "props=\"".len();
    let rest = &after[props_start..];
    let props_end = rest.find('"')?;
    let raw = html_entity_decode(&rest[..props_end]);
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parsed.get("weapon")?; // sanity: must at least contain the weapon
    Some(astro_unwrap_inner(&parsed))
}

/// Bungie tags reworked weapons with a "Rev. N" suffix on the item-type
/// subtitle, always in the exact form "<Type> | Rev. N" (e.g. "Sidearm |
/// Rev. 1" — visible in the in-game inspect panel, see screenshot in the
/// conversation this shipped from). d2ttk's page carries the same manifest
/// text verbatim, so we pull it straight out of the raw HTML the same way
/// extract_ttk does. Anchored on "| Rev." specifically (not bare "Rev.")
/// since a bare match risks colliding with unrelated page furniture (footer
/// version strings, etc). Returns e.g. "Rev. 1", or None for a weapon
/// that's never been reworked.
fn extract_rev(html: &str) -> Option<String> {
    let idx = html.find("| Rev.")?;
    let window = &html[idx..html.len().min(idx + 26)];
    let bytes = window.as_bytes();
    let mut i = 6; // past "| Rev."
    while i < bytes.len() && bytes[i] == b' ' {
        i += 1;
    }
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return None;
    }
    Some(format!("Rev. {}", &window[start..i]))
}

/// First `<digits>.<digits>s` occurring after `label` in the HTML.
fn extract_ttk(html: &str, label: &str) -> Option<String> {
    let rest = find_after(html, label)?;
    let window = &rest[..rest.len().min(400)];
    let bytes = window.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b's' {
                return Some(format!("{}s", &window[start..i]));
            }
            continue;
        }
        i += 1;
    }
    None
}

/// Scan HTML sequentially for column headers and aria-label+icon perk buttons,
/// grouping perks under the most recent header.
fn extract_perk_columns(html: &str) -> Vec<serde_json::Value> {
    const HEADERS: [&str; 5] = ["Barrel", "Magazine", "Trait 1", "Trait 2", "Origin"];
    let mut events: Vec<(usize, Option<&str>, Option<(String, String)>)> = Vec::new();

    for h in HEADERS {
        // Column labels appear as element text: >Barrel<
        let marker = format!(">{h}<");
        let mut from = 0;
        while let Some(pos) = html[from..].find(&marker) {
            events.push((from + pos, Some(h), None));
            from += pos + marker.len();
        }
    }

    // aria-label="NAME" ... <img src="https://www.bungie.net/..."
    let mut from = 0;
    while let Some(pos) = html[from..].find("aria-label=\"") {
        let abs = from + pos + "aria-label=\"".len();
        let Some(end) = html[abs..].find('"') else { break };
        let name = html[abs..abs + end].to_string();
        let after = &html[abs + end..];
        let icon = after
            .find("<img src=\"")
            .filter(|&i| i < 300)
            .and_then(|i| {
                let s = abs + end + i + "<img src=\"".len();
                html[s..].find('"').map(|e| html[s..s + e].to_string())
            });
        if let Some(icon) = icon.filter(|u| u.contains("bungie.net")) {
            events.push((from + pos, None, Some((name, icon))));
        }
        from = abs + end;
    }

    events.sort_by_key(|e| e.0);

    let mut columns: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for (_, header, perk) in events {
        if let Some(h) = header {
            columns.push((h.to_string(), Vec::new()));
        } else if let Some((name, icon)) = perk {
            if let Some(last) = columns.last_mut() {
                // Dedupe (enhanced variants repeat the same aria-label).
                if !last.1.iter().any(|(n, _)| n == &name) {
                    last.1.push((name, icon));
                }
            }
        }
    }

    columns
        .into_iter()
        .filter(|(_, perks)| !perks.is_empty())
        .map(|(label, perks)| {
            serde_json::json!({
                "label": label,
                "perks": perks.into_iter().map(|(n, i)| serde_json::json!({ "name": n, "icon": i })).collect::<Vec<_>>(),
            })
        })
        .collect()
}

/// Fetch (or read cached) full weapon detail: the complete weapon object from
/// the page's astro-island props (sockets/plugs/statModifiers — the optimise
/// engine's input) plus the page-displayed base TTK strings and rework tag
/// (see extract_rev). Cache format v4; older-format caches are discarded and
/// refetched. Also subject to DETAIL_MAX_AGE / purge_all_weapon_detail_cache
/// above, so a weapon that gets reworked later still refreshes on its own.
pub async fn get_weapon_detail_inner(hash: u64) -> Result<serde_json::Value, String> {
    let path = detail_path(hash);
    let fresh = path
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .map(|age| age < DETAIL_MAX_AGE)
        .unwrap_or(false);
    if fresh {
        if let Ok(s) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                if v.get("v").and_then(|x| x.as_u64()) == Some(4) {
                    return Ok(v);
                }
            }
        }
    }
    let url = format!("https://d2ttk.com/weapons/{hash}/");
    let html = match fetch_text(&url).await {
        Ok(h) => h,
        Err(e) => {
            // Refetch failed (offline, d2ttk down, etc). A stale-but-parseable
            // cache still beats showing nothing, same policy as the weapon DB.
            if let Ok(s) = std::fs::read_to_string(&path) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                    if v.get("v").and_then(|x| x.as_u64()) == Some(4) {
                        eprintln!("weapon detail refresh failed for {hash}, using stale cache: {e}");
                        return Ok(v);
                    }
                }
            }
            return Err(format!("weapon page {e}"));
        }
    };

    let props = extract_island_props(&html);
    let weapon = props.as_ref().and_then(|p| p.get("weapon").cloned());
    let stat_group = props.as_ref().and_then(|p| p.get("statGroup").cloned());
    // Regex perk columns only as a fallback when the props parse fails.
    let columns = if weapon.is_none() {
        serde_json::json!(extract_perk_columns(&html))
    } else {
        serde_json::Value::Null
    };
    let detail = serde_json::json!({
        "v": 4,
        "hash": hash,
        "optimalTtk": extract_ttk(&html, "Optimal TTK"),
        "bodyTtk": extract_ttk(&html, "Body TTK"),
        "rev": extract_rev(&html),
        "weapon": weapon,
        "statGroup": stat_group,
        "columns": columns,
    });
    let _ = std::fs::create_dir_all(data_dir());
    let _ = std::fs::write(&path, serde_json::to_string(&detail).unwrap_or_default());
    Ok(detail)
}

// ---------------------------------------------------------------------------
// godroll.tv Community Godroll (requires the user's godroll.tv login session)
// ---------------------------------------------------------------------------
// The API only answers same-origin requests carrying the session cookie, so we
// run the fetch INSIDE Marco's godroll.tv webview and read the result back via
// the location.hash channel (same zero-trust pattern as the redeem checker).

fn godroll_cache_path(hash: u64) -> PathBuf {
    data_dir().join(format!("godroll_{hash}.json"))
}

/// Poll a webview's URL fragment for the `marco=` readback marker.
async fn read_hash_result(app: &AppHandle, label: &str, tries: u32) -> Option<serde_json::Value> {
    for _ in 0..tries {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let wv = app.get_webview(label)?;
        if let Ok(url) = wv.url() {
            if let Some(frag) = url.fragment() {
                if let Some(payload) = frag.strip_prefix("marco=") {
                    let decoded = crate::commands::pct_decode(payload);
                    let _ = wv.eval("history.replaceState(null, '', location.pathname + location.search);");
                    return serde_json::from_str(&decoded).ok();
                }
            }
        }
    }
    None
}

#[tauri::command]
pub async fn get_community_godroll(
    app: AppHandle,
    hash: u64,
    profile: Option<String>,
) -> Result<serde_json::Value, String> {
    // 24h cache.
    let path = godroll_cache_path(hash);
    if let (Ok(s), Ok(meta)) = (std::fs::read_to_string(&path), std::fs::metadata(&path)) {
        let fresh = meta
            .modified()
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|age| age < Duration::from_secs(24 * 3600))
            .unwrap_or(false);
        if fresh {
            if let Ok(v) = serde_json::from_str(&s) {
                return Ok(v);
            }
        }
    }

    // Reuse the logged-in godroll session webview; create it (hidden) if the
    // user hasn't opened that tab yet. We only need it to run a same-origin
    // fetch (session cookie), NOT to render — so hidden is fine (no flash).
    if app.get_webview("godroll").is_none() {
        crate::commands::ensure_web_panel(
            app.clone(),
            "godroll".into(),
            "https://godroll.tv".into(),
            0.0,
            0.0,
            600.0,
            400.0,
            profile,
        )
        .await?;
        if let Some(wv) = app.get_webview("godroll") {
            let _ = wv.hide();
        }
        // Give it a moment to load godroll.tv so same-origin fetch works.
        tokio::time::sleep(Duration::from_millis(600)).await;
    }

    // Fetch the encoded roll via godroll's API (a plain fetch — runs fine in a
    // hidden webview). We decode it ourselves, so there's no page navigation,
    // no button click, no rendering: ~1 round-trip.
    let script = format!(
        r#"(function() {{
  var report = function(o) {{ try {{ location.hash = 'marco=' + encodeURIComponent(JSON.stringify(o)); }} catch (e) {{}} }};
  try {{ if (location.hash) history.replaceState(null, '', location.pathname + location.search); }} catch (e) {{}}
  if (location.hostname.indexOf('godroll.tv') === -1) {{ report({{ status: 0, authStatus: 0 }}); return; }}
  var opts = {{ credentials: 'same-origin', headers: {{ 'X-App-Request': 'godroll-web' }} }};
  fetch('/api/auth/me', opts).then(function(a) {{
    return fetch('/api/godroll/{hash}', Object.assign({{ method: 'POST' }}, opts)).then(async function(r) {{
      var body = null; try {{ body = await r.json(); }} catch (e) {{}}
      report({{ status: r.status, authStatus: a.status, roll: body && body.roll, rollCount: body && body.rollCount }});
    }});
  }}).catch(function(e) {{ report({{ status: 0, authStatus: 0, err: String(e) }}); }});
}})();"#
    );

    let mut result: Option<serde_json::Value> = None;
    for _ in 0..3 {
        if let Some(wv) = app.get_webview("godroll") {
            let _ = wv.eval(&script);
        }
        result = read_hash_result(&app, "godroll", 20).await;
        if result.is_some() {
            break;
        }
    }
    let result = result.ok_or_else(|| "no_response (godroll session not loaded)".to_string())?;
    let status = result.get("status").and_then(|s| s.as_u64()).unwrap_or(0);
    let auth_status = result.get("authStatus").and_then(|s| s.as_u64()).unwrap_or(0);
    if auth_status != 0 && auth_status != 200 {
        return Err("login_required".into());
    }
    match status {
        200 => {}
        401 | 403 => return Err("login_required".into()),
        409 => return Err("not_enough_data".into()),
        other => return Err(format!("no_response (HTTP {other})")),
    }
    let roll = result
        .get("roll")
        .and_then(|r| r.as_str())
        .ok_or_else(|| "not_enough_data".to_string())?;
    let roll_count = result.get("rollCount").and_then(|c| c.as_u64());

    let decoded = decode_godroll_roll(hash, roll);
    eprintln!(
        "[community-godroll] decoded for {hash}: {}",
        serde_json::to_string(&decoded).unwrap_or_default().chars().take(300).collect::<String>()
    );
    let out = serde_json::json!({
        // picks = { socketIndex: [{index, active}] } — decoded roll positions.
        "picks": decoded.get("sockets").cloned().unwrap_or(serde_json::json!({})),
        "rollCount": roll_count,
    });
    let _ = std::fs::create_dir_all(data_dir());
    let _ = std::fs::write(&path, serde_json::to_string(&out).unwrap_or_default());
    Ok(out)
}

/// Decode godroll.tv's roll string (Base58 → LCG-keyed XOR → bit-unpack).
/// Self-contained: needs only the weapon hash. Returns
/// `{ sockets: {socketIndex: [{index, active}]}, masterwork, mod, enhanced }`.
fn decode_godroll_roll(hash: u64, encoded: &str) -> serde_json::Value {
    let bytes = match bs58::decode(encoded).into_vec() {
        Ok(b) => b,
        Err(_) => return serde_json::json!({ "sockets": {} }),
    };
    // XOR with an LCG keystream seeded by the weapon hash (32-bit).
    let mut t: u64 = (hash as u32) as u64;
    let xored: Vec<u8> = bytes
        .iter()
        .map(|b| {
            t = (1664525u64.wrapping_mul(t).wrapping_add(0x3c6e_f35f)) % 0x1_0000_0000;
            b ^ (t as u8)
        })
        .collect();

    // Bit-reader (MSB-first).
    fn read_bits(data: &[u8], bit: &mut usize, n: usize) -> u64 {
        let total = data.len() * 8;
        let mut v = 0u64;
        for _ in 0..n {
            if *bit >= total {
                break;
            }
            let byte = data[*bit / 8];
            let b = (byte >> (7 - (*bit % 8))) & 1;
            v = (v << 1) | b as u64;
            *bit += 1;
        }
        v
    }
    let total = xored.len() * 8;
    let mut bit = 0usize;

    if xored.len() < 2 {
        return serde_json::json!({ "sockets": {} });
    }
    let enhanced = read_bits(&xored, &mut bit, 1) == 1;
    let masterwork = read_bits(&xored, &mut bit, 3);
    let moddd = read_bits(&xored, &mut bit, 6);
    let mut sockets = serde_json::Map::new();
    loop {
        if bit + 9 > total {
            break;
        }
        let socket_index = read_bits(&xored, &mut bit, 4);
        let count = read_bits(&xored, &mut bit, 4) + 1;
        let has_more = read_bits(&xored, &mut bit, 1) == 1;
        if bit + (count as usize) * 10 > total {
            break;
        }
        let mut perks = Vec::new();
        for _ in 0..count {
            let index = read_bits(&xored, &mut bit, 5);
            let active = read_bits(&xored, &mut bit, 1) == 1;
            let step_raw = read_bits(&xored, &mut bit, 4);
            let _step: i64 = if step_raw == 15 { -1 } else { step_raw as i64 };
            perks.push(serde_json::json!({ "index": index, "active": active }));
        }
        if !perks.is_empty() {
            sockets.insert(socket_index.to_string(), serde_json::Value::Array(perks));
        }
        if !has_more {
            break;
        }
    }
    serde_json::json!({
        "sockets": sockets,
        "masterwork": masterwork,
        "mod": moddd,
        "enhanced": enhanced,
    })
}

// ---------------------------------------------------------------------------
// Overlay panels (independent always-on-top windows)
// ---------------------------------------------------------------------------

/// Latest weapon payload, so panels can PULL it on startup instead of relying
/// on catching the broadcast (fresh windows may not be listening yet).
pub struct OverlayDataState {
    pub last: Mutex<Option<serde_json::Value>>,
    pub last_panels: Mutex<Vec<String>>,
    pub seq: std::sync::atomic::AtomicU64,
}

impl Default for OverlayDataState {
    fn default() -> Self {
        Self {
            last: Mutex::new(None),
            last_panels: Mutex::new(vec!["stats".into(), "perks".into()]),
            seq: std::sync::atomic::AtomicU64::new(0),
        }
    }
}

/// The global overlay toggle shortcut currently registered (if any).
#[derive(Default)]
pub struct OverlayHotkeyState {
    pub combo: Mutex<Option<String>>,
}

/// The global "start OCR region calibration" shortcut currently registered (if any).
#[derive(Default)]
pub struct CalibrateHotkeyState {
    pub combo: Mutex<Option<String>>,
}

/// Live overlay settings the detection loop reads on every fire, so changing
/// the source / optimise mode / panels mid-detection takes effect immediately
/// (instead of being frozen at "Start auto-detect" time).
#[derive(Default)]
pub struct OverlaySettingsState {
    pub optimise: Mutex<Option<String>>,
    pub source: Mutex<Option<String>>,
    pub panels: Mutex<Option<Vec<String>>>,
    pub profile: Mutex<Option<String>>,
    // Live OCR capture region. The detection loop re-reads this every tick
    // (like the other fields here) so recalibrating while auto-detect is
    // already running takes effect immediately, instead of the loop being
    // stuck forever on whatever region was passed in at start_weapon_detection
    // time.
    pub region: Mutex<Option<CaptureRegion>>,
}

#[tauri::command]
pub fn set_overlay_settings(
    app: AppHandle,
    optimise: Option<String>,
    source: Option<String>,
    panels: Option<Vec<String>>,
    profile: Option<String>,
    region: Option<CaptureRegion>,
) -> Result<(), String> {
    let s = app.state::<OverlaySettingsState>();
    if let Ok(mut v) = s.optimise.lock() { *v = optimise; }
    if let Ok(mut v) = s.source.lock() { *v = source; }
    if let Ok(mut v) = s.panels.lock() { *v = panels; }
    if let Ok(mut v) = s.profile.lock() { *v = profile; }
    if region.is_some() {
        if let Ok(mut v) = s.region.lock() { *v = region; }
    }
    Ok(())
}

fn overlay_is_visible(app: &AppHandle) -> bool {
    PANELS.iter().any(|(label, _, _, _)| {
        app.get_webview_window(label)
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false)
    })
}

/// Toggle the overlay: hide if any panel is visible, otherwise re-show the
/// last-shown panels (only if a weapon has been loaded this session).
/// `hide_only` skips the re-show branch entirely — the key becomes a pure
/// "dismiss" hotkey that never brings the overlay back.
fn toggle_overlay(app: &AppHandle, hide_only: bool) {
    if overlay_is_visible(app) {
        for (label, _, _, _) in PANELS {
            if let Some(w) = app.get_webview_window(label) {
                let _ = w.hide();
            }
        }
        return;
    }
    if hide_only {
        return;
    }
    let has_data = app
        .state::<OverlayDataState>()
        .last
        .lock()
        .map(|l| l.is_some())
        .unwrap_or(false);
    if !has_data {
        return;
    }
    let enabled = app
        .state::<OverlayDataState>()
        .last_panels
        .lock()
        .map(|p| p.clone())
        .unwrap_or_else(|_| vec!["stats".into(), "perks".into()]);
    for (label, kind, w, h) in PANELS {
        if enabled.iter().any(|p| p == kind) {
            let _ = ensure_panel_window(app, label, kind, w, h);
            if let Some(win) = app.get_webview_window(label) {
                let _ = win.show();
            }
        }
    }
}

#[tauri::command]
pub fn get_overlay_data(app: AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<OverlayDataState>();
    let last = state.last.lock().map_err(|e| e.to_string())?;
    Ok(last.clone().unwrap_or(serde_json::Value::Null))
}

fn publish_overlay_data(app: &AppHandle, mut payload: serde_json::Value, seq: u64) {
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("seq".into(), serde_json::json!(seq));
    }
    if let Ok(mut last) = app.state::<OverlayDataState>().last.lock() {
        *last = Some(payload.clone());
    }
    let _ = app.emit("weapon-data", payload);
}

/// Register (or clear) the global overlay toggle shortcut.
#[tauri::command]
pub fn set_overlay_hotkey(app: AppHandle, combo: Option<String>, hide_only: bool) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let gs = app.global_shortcut();
    let state = app.state::<OverlayHotkeyState>();
    if let Ok(mut c) = state.combo.lock() {
        if let Some(old) = c.take() {
            if let Ok(sc) = crate::commands::parse_shortcut(&old) {
                let _ = gs.unregister(sc);
            }
        }
    }
    let Some(combo) = combo.filter(|c| !c.is_empty()) else { return Ok(()) };
    // Use the same normalizing parser as macro/loadout hotkeys (handles
    // single-letter combos like "Alt+X", which the raw Shortcut parser
    // rejects because it expects physical key codes like "KeyX").
    let sc: Shortcut = crate::commands::parse_shortcut(&combo)
        .map_err(|e| format!("invalid hotkey: {e}"))?;
    let app2 = app.clone();
    gs.on_shortcut(sc, move |_a, _s, ev| {
        if ev.state == ShortcutState::Pressed {
            toggle_overlay(&app2, hide_only);
        }
    })
    .map_err(|e| format!("hotkey unavailable (already in use?): {e}"))?;
    if let Ok(mut c) = state.combo.lock() {
        *c = Some(combo);
    }
    Ok(())
}

/// Register (or clear) the global "start OCR region calibration" shortcut.
/// Fires the same rect-mode calibration overlay as clicking the Calibrate
/// button, so you can re-calibrate without alt-tabbing back into Marco.
#[tauri::command]
pub fn set_calibrate_hotkey(app: AppHandle, combo: Option<String>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let gs = app.global_shortcut();
    let state = app.state::<CalibrateHotkeyState>();
    if let Ok(mut c) = state.combo.lock() {
        if let Some(old) = c.take() {
            if let Ok(sc) = crate::commands::parse_shortcut(&old) {
                let _ = gs.unregister(sc);
            }
        }
    }
    let Some(combo) = combo.filter(|c| !c.is_empty()) else { return Ok(()) };
    let sc: Shortcut = crate::commands::parse_shortcut(&combo)
        .map_err(|e| format!("invalid hotkey: {e}"))?;
    let app2 = app.clone();
    gs.on_shortcut(sc, move |_a, _s, ev| {
        if ev.state == ShortcutState::Pressed {
            let app3 = app2.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::commands::start_calibration_overlay(app3, Some("rect".into())).await;
            });
        }
    })
    .map_err(|e| format!("hotkey unavailable (already in use?): {e}"))?;
    if let Ok(mut c) = state.combo.lock() {
        *c = Some(combo);
    }
    Ok(())
}

/// Register (or clear) the global "DIM search" shortcut: brings Marco to
/// the front, switches to the DIM tab, and focuses DIM's search box.
#[derive(Default)]
pub struct DimSearchHotkeyState {
    pub combo: Mutex<Option<String>>,
    /// Set while a focus_dim_search run is in flight. Guards against a
    /// second hotkey press spawning a second concurrent run -- two runs
    /// racing on the same OS-global foreground/AttachThreadInput state is
    /// exactly what produced interleaved, stuck force_foreground calls in
    /// the past. In practice DIM_SEARCH_COOLDOWN below means a second press
    /// can't arrive while the first is still running anyway (one pass
    /// finishes in ~1-2s, the cooldown is 5s) -- this is a belt-and-
    /// suspenders check, not the primary guard.
    pub running: std::sync::atomic::AtomicBool,
    /// Timestamp of the last press that was actually accepted (i.e. wasn't
    /// itself rejected by the cooldown). Presses inside DIM_SEARCH_COOLDOWN
    /// of this are dropped outright, before they touch `running` at all --
    /// a hard "you can't press this again yet" gate.
    pub last_press: Mutex<Option<std::time::Instant>>,
}

/// Minimum gap between accepted "DIM search" hotkey presses. Exists so
/// panic-mashing the hotkey (e.g. because the window didn't pop instantly)
/// can't repeatedly kick off the force_foreground sequence -- each press
/// does a real synthetic Alt+Tab and fights the game for OS foreground, so
/// spamming it is both pointless (one run already handles staying on top
/// until the search box is focused) and something worth rate-limiting on
/// its own merits.
const DIM_SEARCH_COOLDOWN: Duration = Duration::from_secs(5);

#[tauri::command]
pub fn set_dim_search_hotkey(app: AppHandle, combo: Option<String>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let gs = app.global_shortcut();
    let state = app.state::<DimSearchHotkeyState>();
    if let Ok(mut c) = state.combo.lock() {
        if let Some(old) = c.take() {
            if let Ok(sc) = crate::commands::parse_shortcut(&old) {
                let _ = gs.unregister(sc);
            }
        }
    }
    let Some(combo) = combo.filter(|c| !c.is_empty()) else { return Ok(()) };
    let sc: Shortcut = crate::commands::parse_shortcut(&combo)
        .map_err(|e| format!("invalid hotkey: {e}"))?;
    let app2 = app.clone();
    gs.on_shortcut(sc, move |_a, _s, ev| {
        if ev.state == ShortcutState::Pressed {
            let dim_state = app2.state::<DimSearchHotkeyState>();

            // Hard cooldown gate, checked first and independent of
            // everything else below: a press inside the cooldown window is
            // dropped outright and never reaches focus_dim_search at all.
            let now = std::time::Instant::now();
            let mut last_press = match dim_state.last_press.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            if let Some(prev) = *last_press {
                if now.duration_since(prev) < DIM_SEARCH_COOLDOWN {
                    log_dim(format!(
                        "focus_dim_search: press ignored -- {}ms into the {}s cooldown",
                        now.duration_since(prev).as_millis(),
                        DIM_SEARCH_COOLDOWN.as_secs()
                    ));
                    return;
                }
            }
            *last_press = Some(now);
            drop(last_press);

            // Only actually spawn a new run if one isn't already in
            // flight (see doc comment on `running` -- this shouldn't
            // normally trigger given the cooldown above, but it's cheap
            // insurance against two concurrent force_foreground() calls).
            if dim_state
                .running
                .compare_exchange(
                    false,
                    true,
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                )
                .is_ok()
            {
                let app3 = app2.clone();
                tauri::async_runtime::spawn(async move {
                    focus_dim_search(app3.clone()).await;
                    app3.state::<DimSearchHotkeyState>()
                        .running
                        .store(false, std::sync::atomic::Ordering::SeqCst);
                });
            }
        }
    })
    .map_err(|e| format!("hotkey unavailable (already in use?): {e}"))?;
    if let Ok(mut c) = state.combo.lock() {
        *c = Some(combo);
    }
    Ok(())
}

/// Forces `hwnd` to the foreground even while another app (a fullscreen
/// game, in particular) currently holds focus.
///
/// A plain SetForegroundWindow (what Tauri's `set_focus()` calls) is
/// subject to Windows' foreground-lock: per Microsoft's own docs, it's
/// refused unless the calling process is already the foreground process,
/// was launched by it, or received the last input event -- none of which
/// is true for a background global-hotkey handler, which is exactly why
/// this quietly did nothing while tabbed into a game. Temporarily
/// attaching our thread's input queue to the current foreground thread's
/// queue (AttachThreadInput) satisfies that check -- it's the standard,
/// long-documented workaround.
///
/// This used to also inject a real synthetic Alt+Tab keystroke, because
/// that's the only thing that reliably yields a DirectX *exclusive*-
/// fullscreen game's exclusive mode. That's no longer relevant for
/// Destiny 2 specifically -- Bungie removed exclusive fullscreen, so its
/// "Fullscreen" display mode is borderless windowed now, which doesn't
/// hold exclusive mode in the first place. Dropping the injected keystroke
/// means no more OS task-switcher flash on every press. AttachThreadInput
/// + the zeroed foreground-lock-timeout + SwitchToThisWindow's fAltTab=true
/// (which asks Windows to treat this as an Alt+Tab-style switch for
/// z-order purposes, without actually sending Alt/Tab key events) still
/// covers pulling Marco above a topmost borderless-fullscreen window. If
/// this ever needs to fight *exclusive* fullscreen again (a different
/// game, or Bungie brings the option back), the real keystroke is the
/// fallback to reach for -- see git history for the removed block.
fn force_foreground(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
        SetWindowPos, ShowWindow, SwitchToThisWindow, SystemParametersInfoW, HWND_NOTOPMOST,
        HWND_TOPMOST, SPI_GETFOREGROUNDLOCKTIMEOUT, SPI_SETFOREGROUNDLOCKTIMEOUT, SW_RESTORE,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };

    unsafe {
        let before_fg = GetForegroundWindow();
        log_dim(format!(
            "force_foreground: start, target={:?}, current_foreground={:?}",
            hwnd.0, before_fg.0
        ));

        // Windows refuses a background process's SetForegroundWindow call
        // unless it's recently received input, was launched by the current
        // foreground app, or the "foreground lock timeout" has elapsed. A
        // fullscreen game holding foreground (especially one running
        // elevated, e.g. behind BattlEye/EAC) can make the AttachThreadInput
        // trick below fail silently -- exactly the "hotkey fires but Marco
        // never actually comes to the top" symptom. Zero out the lock
        // timeout for the duration of this call, then restore it after.
        // (pvParam carries the DWORD value itself here, not a pointer to a
        // buffer -- that's how this particular SPI code is documented.)
        let mut old_timeout: u32 = 0;
        let _ = SystemParametersInfoW(
            SPI_GETFOREGROUNDLOCKTIMEOUT,
            0,
            Some(&mut old_timeout as *mut u32 as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        let _ = SystemParametersInfoW(
            SPI_SETFOREGROUNDLOCKTIMEOUT,
            0,
            Some(0usize as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );

        let fg = GetForegroundWindow();
        let cur_thread = GetCurrentThreadId();
        let fg_thread = if fg.0.is_null() { 0 } else { GetWindowThreadProcessId(fg, None) };
        let attached = fg_thread != 0
            && fg_thread != cur_thread
            && AttachThreadInput(cur_thread, fg_thread, true).as_bool();
        log_dim(format!("force_foreground: AttachThreadInput ok={attached}"));

        let show_ok = ShowWindow(hwnd, SW_RESTORE);
        let sfw_ok = SetForegroundWindow(hwnd);
        let btt_ok = BringWindowToTop(hwnd);
        log_dim(format!(
            "force_foreground: ShowWindow ok={}, SetForegroundWindow ok={}, BringWindowToTop ok={}",
            show_ok.as_bool(), sfw_ok.as_bool(), btt_ok.is_ok()
        ));
        // SwitchToThisWindow is the same call Alt+Tab uses. It's more forceful
        // than SetForegroundWindow — it activates and raises the window even in
        // cases where SetForegroundWindow is silently refused (a background
        // hotkey handler fighting a fullscreen game for foreground). The second
        // arg (fAltTab = TRUE) tells Windows to treat it like a real Alt+Tab,
        // which is what actually pulls a borderless-fullscreen game's window
        // out of the top of the z-order -- without needing an actual injected
        // Alt/Tab keystroke to get that treatment.
        SwitchToThisWindow(hwnd, true);
        // Belt-and-suspenders z-order punch: TOPMOST then NOTOPMOST, which
        // (unlike a plain BringWindowToTop) forces Windows to re-evaluate
        // z-order even against an exclusive-fullscreen game surface.
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        let _ = SetWindowPos(hwnd, Some(HWND_NOTOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);

        if attached {
            let _ = AttachThreadInput(cur_thread, fg_thread, false);
        }

        let _ = SystemParametersInfoW(
            SPI_SETFOREGROUNDLOCKTIMEOUT,
            0,
            Some(old_timeout as usize as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );

        let final_fg = GetForegroundWindow();
        log_dim(format!(
            "force_foreground: done, final_foreground={:?}, target_was={:?}, matched={}",
            final_fg.0, hwnd.0, final_fg.0 == hwnd.0
        ));
    }
}


/// Brings the main window to the front, tells the frontend to switch to the
/// DIM tab, then (once the "dim" child webview exists — it's created lazily
/// the first time that tab is shown) focuses its search box. Runs the
/// foreground-forcing sequence exactly once — it used to keep re-punching
/// foreground every ~300ms for up to several seconds "just in case" the
/// game snapped focus back, which was overkill and visibly looked like it
/// was retriggering itself several times over. The 5s hotkey cooldown (see
/// set_dim_search_hotkey) is what stops spam now, so this just does the one
/// clean pass and stops.
pub async fn focus_dim_search(app: AppHandle) {
    log_dim("focus_dim_search: hotkey fired");

    // NOTE: this must be get_window(), not get_webview_window(). The rest of
    // this codebase (see ensure_web_panel) already gets "main" via
    // get_window() -- get_webview_window("main") was returning None on every
    // single call here (confirmed via the log this function writes), which
    // silently no-op'd every unminimize/show/force_foreground/set_focus call
    // below for however long this bug has existed. Window has the same
    // show/unminimize/hwnd/set_focus/set_always_on_top methods as
    // WebviewWindow, so nothing else here needs to change.
    //
    // This retry loop is just polling for the handle to exist (silent, no
    // visible effect) -- it's not the "keep punching foreground" loop this
    // used to have. Handles the case where the hotkey is pressed right after
    // Marco launches, before Tauri's window manager has "main" registered.
    let mut main = app.get_window("main");
    if main.is_none() {
        for _ in 0..30 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            main = app.get_window("main");
            if main.is_some() {
                break;
            }
        }
    }
    let Some(main) = main else {
        log_dim("focus_dim_search: 'main' window handle never resolved within 3s — bailing out");
        return;
    };

    let _ = main.set_always_on_top(true);
    let _ = main.unminimize();
    let _ = main.show();
    if let Ok(hwnd) = main.hwnd() {
        force_foreground(windows::Win32::Foundation::HWND(hwnd.0));
    }
    let _ = main.set_focus();

    let _ = app.emit("switch-tab", "dim");

    const SEARCH_FOCUS_JS: &str = r#"(function() {
  var el = document.querySelector(
    '#search-item, #search, input[name="filter"], input[type="search"], ' +
    'input[aria-label*="search" i], input[placeholder*="search" i], .search-input input, .search-bar input'
  );
  if (!el) {
    var candidates = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
    el = candidates.find(function (c) { return c.offsetParent !== null; });
  }
  if (el) { el.focus(); el.select && el.select(); }
  return !!el;
})();"#;

    // Same idea: poll (silently) for the "dim" webview to exist, then eval
    // the focus JS a small, fixed number of times to catch DIM's search box
    // mounting -- these are just JS calls, not additional foreground
    // punches, so there's nothing visible re-triggering here.
    let mut found_search_box = false;
    'outer: for i in 0..30 {
        if let Some(wv) = app.get_webview("dim") {
            log_dim(format!("focus_dim_search: 'dim' webview found after {}ms", i * 100));
            let _ = wv.set_focus();
            for j in 0..5 {
                let _ = wv.eval(SEARCH_FOCUS_JS);
                found_search_box = true;
                if j < 4 {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
            break 'outer;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    if !found_search_box {
        log_dim("focus_dim_search: 'dim' webview never appeared within 3s — giving up on search focus");
    }

    // Give the player a moment to actually see and click into the box
    // before dropping topmost, then we're done -- one pass, no retriggers.
    tokio::time::sleep(Duration::from_millis(800)).await;
    let _ = main.set_always_on_top(false);
}

/// Release EVERY global shortcut Marco holds (macro/loadout bindings and the
/// overlay toggle). Lets another app reclaim those keys without closing Marco.
#[tauri::command]
pub fn disable_all_hotkeys(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let _ = app.global_shortcut().unregister_all();
    if let Ok(mut hs) = app.state::<Mutex<crate::commands::HotkeyState>>().lock() {
        hs.ids.clear();
    }
    if let Ok(mut c) = app.state::<OverlayHotkeyState>().combo.lock() {
        *c = None;
    }
    if let Ok(mut c) = app.state::<CalibrateHotkeyState>().combo.lock() {
        *c = None;
    }
    if let Ok(mut c) = app.state::<DimSearchHotkeyState>().combo.lock() {
        *c = None;
    }
    if let Ok(mut c) = app.state::<DetectHotkeyState>().combo.lock() {
        *c = None;
    }
    Ok(())
}

/// Create both panel windows hidden ahead of time so first use is instant.
/// Called from setup (delayed) — failures are non-fatal.
pub fn prewarm_overlay_windows(app: &AppHandle) {
    for (label, kind, w, h) in PANELS {
        let _ = ensure_panel_window(app, label, kind, w, h);
    }
}

fn ensure_panel_window(app: &AppHandle, label: &str, kind: &str, w: f64, h: f64) -> Result<(), String> {
    if app.get_webview_window(label).is_some() {
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(format!("overlay.html?panel={kind}").into()),
    )
    .title(format!("Marco {kind}"))
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .inner_size(w, h)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Full weapon record from the cached weapons.json (stats etc.), by hash.
fn weapon_record(hash: u64) -> Option<serde_json::Value> {
    let s = std::fs::read_to_string(db_path()).ok()?;
    let list: Vec<serde_json::Value> = serde_json::from_str(&s).ok()?;
    list.into_iter().find(|w| w.get("hash").and_then(|h| h.as_u64()) == Some(hash))
}

/// Show the enabled overlay panels for a weapon: merge the weapons.json record
/// with the per-page detail (TTK/perk icons), broadcast it, show the windows.
#[tauri::command]
pub async fn show_overlay_panels(
    app: AppHandle,
    hash: u64,
    name: String,
    optimise: Option<String>,
    panels: Option<Vec<String>>,
    source: Option<String>,
    profile: Option<String>,
) -> Result<(), String> {
    let enabled: Vec<String> =
        panels.unwrap_or_else(|| vec!["ttk".into(), "stats".into(), "perks".into()]);
    let source = source.unwrap_or_else(|| "d2ttk".into());
    if let Ok(mut p) = app.state::<OverlayDataState>().last_panels.lock() {
        *p = enabled.clone();
    }
    let seq = app
        .state::<OverlayDataState>()
        .seq
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;

    // Show panels FIRST so the user gets instant feedback; the pages pull the
    // stage-1 payload themselves if they load after the emit.
    for (label, kind, w, h) in PANELS {
        let show = enabled.iter().any(|p| p == kind);
        if show {
            ensure_panel_window(&app, label, kind, w, h)?;
        }
        if let Some(win) = app.get_webview_window(label) {
            if show { let _ = win.show(); } else { let _ = win.hide(); }
        }
    }

    let record = weapon_record(hash).unwrap_or_else(|| serde_json::json!({ "hash": hash, "name": name }));

    let is_community = source == "community";

    // Stage 1: instant partial payload (name renders immediately).
    publish_overlay_data(
        &app,
        serde_json::json!({
            "record": record.clone(),
            "detail": null,
            "loading": true,
            "optimise": optimise.clone(),
            "source": source.clone(),
            // For community, mark loading so the panel shows "fetching godroll…".
            "communityRoll": if is_community { serde_json::json!({ "loading": true }) } else { serde_json::Value::Null },
        }),
        seq,
    );
    let _ = app.emit("weapon-detected", serde_json::json!({ "hash": hash, "name": name }));

    // Stage 2: d2ttk detail (cached = fast). Emit immediately so the weapon
    // shows without waiting on the (slower) community fetch.
    let detail = get_weapon_detail_inner(hash).await.unwrap_or_else(|e| {
        eprintln!("weapon detail unavailable for {hash}: {e}");
        serde_json::json!(null)
    });
    let current = app.state::<OverlayDataState>().seq.load(std::sync::atomic::Ordering::SeqCst);
    if current != seq {
        return Ok(());
    }
    publish_overlay_data(
        &app,
        serde_json::json!({
            "record": record,
            "detail": detail,
            "loading": false,
            "optimise": optimise,
            "source": source,
            "communityRoll": if is_community { serde_json::json!({ "loading": true }) } else { serde_json::Value::Null },
        }),
        seq,
    );

    // Stage 3 (community only): fetch the godroll roll in the BACKGROUND and
    // push it via a `community-roll` event so the panels aren't blocked on it.
    if is_community {
        let bg = app.clone();
        tauri::async_runtime::spawn(async move {
            let payload = match get_community_godroll(bg.clone(), hash, profile).await {
                Ok(v) => {
                    let _ = bg.emit("community-status", serde_json::json!({ "ok": true, "hash": hash }));
                    serde_json::json!({ "hash": hash, "seq": seq, "ok": true, "data": v })
                }
                Err(e) => {
                    let _ = bg.emit("community-status", serde_json::json!({ "ok": false, "hash": hash, "error": e.clone() }));
                    serde_json::json!({ "hash": hash, "seq": seq, "ok": false, "error": e })
                }
            };
            // Only apply if this is still the current weapon.
            let cur = bg.state::<OverlayDataState>().seq.load(std::sync::atomic::Ordering::SeqCst);
            if cur == seq {
                let _ = bg.emit("community-roll", payload);
            }
        });
    }
    Ok(())
}

/// Recover the overlay panels: put each at a sane default size + staggered
/// on-screen position, and show them. Fixes a panel lost off-screen or
/// collapsed to an invisible size.
#[tauri::command]
pub async fn reset_overlay_layout(app: AppHandle) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize};
    let positions = [(40.0, 40.0), (360.0, 40.0)];
    for (i, (label, kind, w, h)) in PANELS.iter().enumerate() {
        ensure_panel_window(&app, label, kind, *w, *h)?;
        if let Some(win) = app.get_webview_window(label) {
            let (px, py) = positions.get(i).copied().unwrap_or((60.0, 60.0));
            let _ = win.set_size(LogicalSize::new(*w, *h));
            let _ = win.set_position(LogicalPosition::new(px, py));
            let _ = win.show();
        }
    }
    Ok(())
}

/// Hide every overlay panel (✕ / Esc in any panel, or the main-app button).
#[tauri::command]
pub async fn hide_overlay(app: AppHandle) -> Result<(), String> {
    for (label, _, _, _) in PANELS {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.hide();
        }
    }
    Ok(())
}

/// Window-level alpha via layered-window attributes, applied to every panel.
/// EXPERIMENTAL on some setups; falls back gracefully (worst case: opaque).
#[tauri::command]
pub fn set_overlay_opacity(app: AppHandle, opacity: u8) -> Result<(), String> {
    use windows::Win32::Foundation::{COLORREF, HWND};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE,
        LWA_ALPHA, WS_EX_LAYERED,
    };
    for (label, _, _, _) in PANELS {
        let Some(win) = app.get_webview_window(label) else { continue };
        let hwnd = win.hwnd().map_err(|e| e.to_string())?;
        let hwnd = HWND(hwnd.0);
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED.0 as isize);
            SetLayeredWindowAttributes(hwnd, COLORREF(0), opacity, LWA_ALPHA)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Screen capture + OCR
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CaptureRegion {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// Capture the region (screen coordinates) and return the cropped RGBA image.
fn capture_region(region: CaptureRegion) -> Result<image::RgbaImage, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("monitor enumeration failed: {e}"))?;
    let monitor = monitors
        .iter()
        .find(|m| {
            let (mx, my) = (m.x().unwrap_or(0), m.y().unwrap_or(0));
            let (mw, mh) = (m.width().unwrap_or(0) as i32, m.height().unwrap_or(0) as i32);
            region.x >= mx && region.x < mx + mw && region.y >= my && region.y < my + mh
        })
        .or_else(|| monitors.first())
        .ok_or_else(|| "no monitors found".to_string())?;

    let full = monitor.capture_image().map_err(|e| format!("screen capture failed: {e}"))?;
    let rel_x = (region.x - monitor.x().unwrap_or(0)).max(0) as u32;
    let rel_y = (region.y - monitor.y().unwrap_or(0)).max(0) as u32;
    let w = region.w.min(full.width().saturating_sub(rel_x)).max(1);
    let h = region.h.min(full.height().saturating_sub(rel_y)).max(1);
    Ok(image::imageops::crop_imm(&full, rel_x, rel_y, w, h).to_image())
}

/// OCR an RGBA image with the Windows built-in engine (user's language pack).
fn ocr_image(img: &image::RgbaImage) -> Result<String, String> {
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Security::Cryptography::CryptographicBuffer;

    // RGBA -> BGRA for SoftwareBitmap.
    let (w, h) = (img.width() as i32, img.height() as i32);
    let mut bgra = img.as_raw().clone();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }

    let buffer = CryptographicBuffer::CreateFromByteArray(&bgra).map_err(|e| format!("{e}"))?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w, h)
        .map_err(|e| format!("{e}"))?;
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|e| format!("OCR engine unavailable: {e}"))?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| format!("{e}"))?
        .join()
        .map_err(|e| format!("OCR failed: {e}"))?;
    Ok(result.Text().map(|t| t.to_string()).unwrap_or_default())
}

fn normalize(s: &str) -> String {
    s.to_uppercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

/// Best fuzzy match of OCR text against the loaded weapon names.
///
/// Reworked weapons (e.g. a "Rev. 1" reissue) share the exact same name as
/// the original, so they tie on jaro_winkler score. Previously ties were
/// resolved by "whichever appears first in the JSON array", which is
/// arbitrary and could land on the superseded/old-season copy. Ties (and
/// near-ties within EPS, in case of float rounding) now prefer the
/// non-superseded entry, then the higher releaseVersion, so OCR always
/// resolves to the current version of a weapon.
const TIE_EPS: f64 = 1e-9;

fn best_match(app: &AppHandle, text: &str) -> Option<(u64, String, f64)> {
    let norm = normalize(text);
    if norm.len() < 4 {
        return None;
    }
    let state = app.state::<WeaponDbState>();
    let weapons = state.weapons.lock().ok()?;
    let mut best: Option<&WeaponEntry> = None;
    let mut best_score = 0.0f64;
    for w in weapons.iter() {
        let score = strsim::jaro_winkler(&norm, &normalize(&w.name));
        let is_better = match best {
            None => true,
            Some(b) => {
                if score > best_score + TIE_EPS {
                    true
                } else if score < best_score - TIE_EPS {
                    false
                } else {
                    // Tie: prefer current (not superseded), then newer release.
                    (!w.superseded, w.release_version) > (!b.superseded, b.release_version)
                }
            }
        };
        if is_better {
            best = Some(w);
            best_score = score;
        }
    }
    best.filter(|_| best_score >= 0.85)
        .map(|w| (w.hash, w.name.clone(), best_score))
}

/// One-shot capture + OCR + match, returning everything the tuning UI needs.
#[tauri::command]
pub async fn ocr_test_capture(app: AppHandle, region: CaptureRegion) -> Result<serde_json::Value, String> {
    let (img, text) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let img = capture_region(region)?;
        let text = ocr_image(&img)?;
        Ok((img, text))
    })
    .await
    .map_err(|e| format!("{e}"))??;

    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("{e}"))?;
    use base64::Engine as _;
    let png_b64 = base64::engine::general_purpose::STANDARD.encode(&png);

    let matched = best_match(&app, &text)
        .map(|(hash, name, score)| serde_json::json!({ "hash": hash, "name": name, "score": score }));
    Ok(serde_json::json!({ "png": png_b64, "text": text, "match": matched }))
}

// ---------------------------------------------------------------------------
// Auto-detection loop
// ---------------------------------------------------------------------------

pub struct DetectionState {
    pub running: Mutex<Option<tokio::task::AbortHandle>>,
}

/// Whether Destiny 2 is the current foreground (focused) window, by the
/// focused window's owning process name — mirrors the old WPF app's
/// `IsDestinyFocused()` (`GetWindowThreadProcessId` + `Process.ProcessName`
/// containing "destiny2"). Used to gate both the OCR weapon-detection loop
/// and (see `loadout.rs`) loadout-swap hotkeys, so neither fires
/// keystrokes/clicks into whatever app you happen to be alt-tabbed into.
///
/// NOTE: this used to check the window *title* for the literal string
/// "Destiny 2" instead. That's fragile — titles can be empty, truncated, or
/// differ depending on launcher (Steam/Battle.net/MS Store) and
/// fullscreen-exclusive mode — and was almost certainly why this gate kept
/// failing even while Destiny 2 was genuinely focused. The process name
/// (always `destiny2.exe`, however it was launched) is stable.
pub(crate) fn destiny_is_foreground() -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return false;
        }

        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };

        let mut buf = [0u16; 260];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(handle);

        if !ok {
            return false;
        }

        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let exe_name = path.rsplit(['\\', '/']).next().unwrap_or(&path);
        exe_name.to_ascii_lowercase().contains("destiny2")
    }
}

#[tauri::command]
pub async fn start_weapon_detection(
    app: AppHandle,
    region: CaptureRegion,
    interval_ms: Option<u64>,
    optimise: Option<String>,
    panels: Option<Vec<String>>,
    source: Option<String>,
    profile: Option<String>,
) -> Result<(), String> {
    stop_weapon_detection(app.clone()).await?;
    let interval = interval_ms.unwrap_or(500).clamp(200, 5000);
    // Seed the live settings so the very first detection uses them; the loop
    // re-reads this state each fire, so later dropdown changes (AND
    // recalibrating the region mid-detection) apply too.
    let _ = set_overlay_settings(app.clone(), optimise, source, panels, profile, Some(region));

    let loop_app = app.clone();
    let handle = tokio::spawn(async move {
        let mut last_hash: Option<u64> = None;
        let mut misses: u32 = 0;
        loop {
            tokio::time::sleep(Duration::from_millis(interval)).await;
            if !destiny_is_foreground() {
                continue;
            }
            // Read the CURRENT capture region each tick (not the one this
            // loop started with) so a mid-session recalibration is picked up
            // on the very next tick instead of requiring auto-detect to be
            // stopped and restarted.
            let cur_region = loop_app
                .state::<OverlaySettingsState>()
                .region
                .lock()
                .ok()
                .and_then(|v| *v)
                .unwrap_or(region);
            let ocr = tokio::task::spawn_blocking(move || {
                capture_region(cur_region).and_then(|img| ocr_image(&img))
            })
            .await;
            let text = match ocr {
                Ok(Ok(t)) => t,
                _ => continue,
            };
            match best_match(&loop_app, &text) {
                Some((hash, name, _score)) => {
                    misses = 0;
                    if last_hash != Some(hash) {
                        last_hash = Some(hash);
                        // Read the CURRENT settings each time (not a snapshot).
                        let st = loop_app.state::<OverlaySettingsState>();
                        let cur_optimise = st.optimise.lock().ok().and_then(|v| v.clone());
                        let cur_source = st.source.lock().ok().and_then(|v| v.clone());
                        let cur_panels = st.panels.lock().ok().and_then(|v| v.clone());
                        let cur_profile = st.profile.lock().ok().and_then(|v| v.clone());
                        let _ = show_overlay_panels(
                            loop_app.clone(),
                            hash,
                            name,
                            cur_optimise,
                            cur_panels,
                            cur_source,
                            cur_profile,
                        )
                        .await;
                    }
                }
                None => {
                    misses += 1;
                    if misses == 4 {
                        last_hash = None;
                        let _ = hide_overlay(loop_app.clone()).await;
                    }
                }
            }
        }
    })
    .abort_handle();

    let state = app.state::<DetectionState>();
    *state.running.lock().map_err(|e| e.to_string())? = Some(handle);
    let _ = app.emit("detection-state", true);
    Ok(())
}

#[tauri::command]
pub async fn stop_weapon_detection(app: AppHandle) -> Result<(), String> {
    let state = app.state::<DetectionState>();
    if let Some(h) = state.running.lock().map_err(|e| e.to_string())?.take() {
        h.abort();
    }
    let _ = app.emit("detection-state", false);
    Ok(())
}

/// One-shot version of the auto-detect loop: capture the region right now,
/// OCR it, match it against the weapon DB, and show the overlay panels if it
/// matched — for the "just hit a key and see the perk" case when someone
/// doesn't want continuous auto-detect running (and its steady OCR/CPU use)
/// the whole play session.
#[tauri::command]
pub async fn detect_once(
    app: AppHandle,
    region: CaptureRegion,
    optimise: Option<String>,
    panels: Option<Vec<String>>,
    source: Option<String>,
    profile: Option<String>,
) -> Result<serde_json::Value, String> {
    let text = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let img = capture_region(region)?;
        ocr_image(&img)
    })
    .await
    .map_err(|e| format!("{e}"))??;

    let matched = best_match(&app, &text);
    match matched {
        Some((hash, name, score)) => {
            show_overlay_panels(app.clone(), hash, name.clone(), optimise, panels, source, profile).await?;
            Ok(serde_json::json!({ "ok": true, "hash": hash, "name": name, "score": score, "text": text }))
        }
        None => Ok(serde_json::json!({ "ok": false, "text": text })),
    }
}

/// Register (or clear) the global "Detect now" shortcut: a single-shot
/// capture+OCR+match+show, gated on Destiny 2 actually being focused (like
/// the auto-detect loop and loadout hotkeys) so it doesn't fire off a
/// capture while you're alt-tabbed into something else.
#[derive(Default)]
pub struct DetectHotkeyState {
    pub combo: Mutex<Option<String>>,
}

#[tauri::command]
pub fn set_detect_hotkey(app: AppHandle, combo: Option<String>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let gs = app.global_shortcut();
    let state = app.state::<DetectHotkeyState>();
    if let Ok(mut c) = state.combo.lock() {
        if let Some(old) = c.take() {
            if let Ok(sc) = crate::commands::parse_shortcut(&old) {
                let _ = gs.unregister(sc);
            }
        }
    }
    let Some(combo) = combo.filter(|c| !c.is_empty()) else { return Ok(()) };
    let sc: Shortcut = crate::commands::parse_shortcut(&combo)
        .map_err(|e| format!("invalid hotkey: {e}"))?;
    let app2 = app.clone();
    gs.on_shortcut(sc, move |_a, _s, ev| {
        if ev.state == ShortcutState::Pressed {
            let app3 = app2.clone();
            tauri::async_runtime::spawn(async move {
                if !destiny_is_foreground() {
                    return;
                }
                let region = app3
                    .state::<OverlaySettingsState>()
                    .region
                    .lock()
                    .ok()
                    .and_then(|v| *v);
                let Some(region) = region else {
                    let _ = app3.emit("detect-once-result", serde_json::json!({ "ok": false, "text": "no capture region set" }));
                    return;
                };
                let st = app3.state::<OverlaySettingsState>();
                let cur_optimise = st.optimise.lock().ok().and_then(|v| v.clone());
                let cur_source = st.source.lock().ok().and_then(|v| v.clone());
                let cur_panels = st.panels.lock().ok().and_then(|v| v.clone());
                let cur_profile = st.profile.lock().ok().and_then(|v| v.clone());
                let result = detect_once(app3.clone(), region, cur_optimise, cur_panels, cur_source, cur_profile).await;
                let payload = result.unwrap_or_else(|e| serde_json::json!({ "ok": false, "text": e }));
                let _ = app3.emit("detect-once-result", payload);
            });
        }
    })
    .map_err(|e| format!("hotkey unavailable (already in use?): {e}"))?;
    if let Ok(mut c) = state.combo.lock() {
        *c = Some(combo);
    }
    Ok(())
}