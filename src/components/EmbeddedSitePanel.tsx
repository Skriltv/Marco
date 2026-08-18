import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { profileForAccount, type Account } from "../lib/accounts";

export interface SitePanelSite {
  /** Unique id for this site *within this panel*, e.g. "godroll" or "d2ttk" */
  id: string;
  /** Unique webview label, globally unique across the whole app (e.g. "dim", "godroll", "godroll-d2ttk") */
  webviewLabel: string;
  title: string;
  url: string;
}

interface Props {
  /** localStorage key for remembering which site of `sites` was last selected */
  storageKey: string;
  sites: SitePanelSite[];
  /** Whether this tab is the one currently selected */
  active: boolean;
  /** Account profile (isolated browser session). Changing it recreates the webviews. */
  profile?: string;
  /** When provided, enables the per-account "Login" export/import transfer bar.
   * Only passed to the DIM panel, so the feature appears there and not on Godroll. */
  accounts?: Account[];
}

const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
const DEFAULT_ZOOM = 100;

function loadSelected(storageKey: string, sites: SitePanelSite[]): string {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved && sites.some(s => s.id === saved)) return saved;
  } catch { /* ignore */ }
  return sites[0].id;
}

function loadZoomMap(storageKey: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(storageKey + ".zoom");
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch { return {}; }
}

/**
 * Docks one or more real, native child webviews inside this tab's content
 * area — one per entry in `sites` — and (when there's more than one) shows a
 * dropdown so the user can switch which site is on top, e.g. Godroll.tv vs
 * D2TTK. We use native child webviews (not <iframe>s) because most sites
 * (DIM, godroll.tv, D2TTK included) send X-Frame-Options / frame-ancestors
 * headers that block iframe embedding — a native child webview loads the
 * site as its own top-level document, so it isn't affected.
 *
 * Every site's webview stays mounted once created (just hidden when not
 * selected), the same "create once, toggle visibility" approach the
 * top-level tab bar already uses — so switching back and forth between e.g.
 * Godroll.tv and D2TTK doesn't reload or re-login either one.
 */
export default function EmbeddedSitePanel({ storageKey, sites, active, profile, accounts }: Props) {
  const [selected, setSelected] = useState(() => loadSelected(storageKey, sites));
  // --- Per-account DIM login transfer (only when `accounts` is provided) ---
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferId, setTransferId] = useState<string>(() => {
    const list = accounts ?? [];
    const match = list.find(a => (profileForAccount(a.id) ?? null) === (profile ?? null));
    return match?.id ?? list[0]?.id ?? "Main";
  });
  const [exportedToken, setExportedToken] = useState("");
  const [importText, setImportText] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferMsg, setTransferMsg] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const createdRef = useRef<Set<string>>(new Set());
  const createdProfileRef = useRef<Record<string, string | undefined>>({});
  // Zoom level (%) per site id within this panel, e.g. Godroll.tv and D2TTK
  // can be zoomed independently since they were designed at different sizes.
  const [zoomMap, setZoomMap] = useState<Record<string, number>>(() => loadZoomMap(storageKey));

  useEffect(() => {
    try { localStorage.setItem(storageKey, selected); } catch { /* ignore */ }
  }, [storageKey, selected]);

  const site = sites.find(s => s.id === selected) ?? sites[0];
  const zoom = zoomMap[site.id] ?? DEFAULT_ZOOM;

  function setZoom(pct: number) {
    setZoomMap(prev => {
      const next = { ...prev, [site.id]: pct };
      try { localStorage.setItem(storageKey + ".zoom", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    api.setWebPanelZoom(site.webviewLabel, pct / 100).catch(() => {});
  }

  function zoomStep(dir: 1 | -1) {
    const idx = ZOOM_STEPS.reduce((best, v, i) => (Math.abs(v - zoom) < Math.abs(ZOOM_STEPS[best] - zoom) ? i : best), 0);
    const nextIdx = Math.min(ZOOM_STEPS.length - 1, Math.max(0, idx + dir));
    setZoom(ZOOM_STEPS[nextIdx]);
  }

  function currentBounds(): api.PanelBounds | null {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  }

  async function reloadSite() {
    try {
      await api.closeWebPanel(site.webviewLabel);
      createdRef.current.delete(site.id);
      const bounds = currentBounds();
      if (bounds) {
        await api.ensureWebPanel(site.webviewLabel, site.url, bounds, profile);
        createdRef.current.add(site.id);
        createdProfileRef.current[site.id] = profile;
        await api.showWebPanel(site.webviewLabel);
        await api.setWebPanelZoom(site.webviewLabel, zoom / 100).catch(() => {});
      }
    } catch {
      /* best-effort */
    }
  }

  async function doExport() {
    setTransferBusy(true);
    setExportedToken("");
    setTransferMsg("Reading DIM login…");
    try {
      const tok = await api.exportDimLogin(profileForAccount(transferId) ?? null);
      setExportedToken(tok);
      setTransferMsg("Exported — copy the token below and paste it on the other PC.");
    } catch (e) {
      setTransferMsg("Export failed: " + e);
    } finally {
      setTransferBusy(false);
    }
  }

  async function doImport() {
    const token = importText.trim();
    if (!token) { setTransferMsg("Paste a token first."); return; }
    setTransferBusy(true);
    setTransferMsg("Importing…");
    try {
      await api.importDimLogin(profileForAccount(transferId) ?? null, token);
      setImportText("");
      setTransferMsg("Imported into this account's DIM login.");
      // If we just wrote to the account the visible DIM tab is showing,
      // reload it so DIM picks up the new login.
      if ((profileForAccount(transferId) ?? null) === (profile ?? null)) {
        await reloadSite();
      }
    } catch (e) {
      setTransferMsg("Import failed: " + e);
    } finally {
      setTransferBusy(false);
    }
  }

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(exportedToken);
      setTransferMsg("Token copied to clipboard.");
    } catch {
      setTransferMsg("Couldn't copy automatically — select the token and copy it manually.");
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function sync() {
      const bounds = currentBounds();
      if (!bounds) return;
      try {
        for (const s of sites) {
          const isSelected = s.id === site.id;
          // Account switched: tear down that site's old session first.
          if (createdRef.current.has(s.id) && createdProfileRef.current[s.id] !== profile) {
            await api.closeWebPanel(s.webviewLabel);
            createdRef.current.delete(s.id);
          }
          if (isSelected) {
            if (!createdRef.current.has(s.id)) {
              await api.ensureWebPanel(s.webviewLabel, s.url, bounds, profile);
              createdRef.current.add(s.id);
              createdProfileRef.current[s.id] = profile;
              await api.setWebPanelZoom(s.webviewLabel, (zoomMap[s.id] ?? DEFAULT_ZOOM) / 100).catch(() => {});
            } else {
              await api.setWebPanelBounds(s.webviewLabel, bounds);
            }
            if (cancelled) return;
            if (active) await api.showWebPanel(s.webviewLabel);
            else await api.hideWebPanel(s.webviewLabel);
          } else if (createdRef.current.has(s.id)) {
            await api.hideWebPanel(s.webviewLabel);
          }
        }
      } catch {
        /* best-effort — window may not be ready yet */
      }
    }

    sync();

    const ro = new ResizeObserver(() => { if (createdRef.current.has(site.id)) sync(); });
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener("resize", sync);

    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener("resize", sync);
      for (const s of sites) {
        if (createdRef.current.has(s.id)) api.hideWebPanel(s.webviewLabel).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, active, profile]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 bg-neutral-900/40 px-3 py-1">
        <div className="flex items-center gap-2">
          {sites.length > 1 ? (
            <select
              className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[11px] font-medium text-neutral-300 focus:border-purple-500 focus:outline-none"
              value={selected}
              onChange={e => setSelected(e.target.value)}
              title="Switch site"
            >
              {sites.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
          ) : (
            <span className="text-[11px] font-medium text-neutral-400">{site.title}</span>
          )}
          <button
            className="rounded border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-700 transition-colors"
            onClick={reloadSite}
            title="Reload current site"
          >
            ↻ Reload
          </button>
          <div className="flex items-center overflow-hidden rounded border border-neutral-700">
            <button
              className="px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-700 transition-colors disabled:opacity-40"
              onClick={() => zoomStep(-1)}
              disabled={zoom <= ZOOM_STEPS[0]}
              title="Zoom out"
            >
              −
            </button>
            <button
              className="border-x border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[11px] font-mono text-neutral-400 hover:bg-neutral-800 transition-colors"
              onClick={() => setZoom(DEFAULT_ZOOM)}
              title="Reset zoom to 100%"
            >
              {zoom}%
            </button>
            <button
              className="px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-700 transition-colors disabled:opacity-40"
              onClick={() => zoomStep(1)}
              disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
              title="Zoom in"
            >
              +
            </button>
          </div>
          {accounts && (
            <button
              className={"rounded border px-2 py-0.5 text-[11px] transition-colors " + (transferOpen ? "border-purple-700 bg-purple-950/50 text-purple-200" : "border-neutral-700 bg-neutral-800 text-neutral-300 hover:bg-neutral-700")}
              onClick={() => setTransferOpen(v => !v)}
              title="Export or import a saved account's DIM login"
            >
              ⇄ Login
            </button>
          )}
        </div>
        <span className="truncate text-[10px] text-neutral-600">{site.url}</span>
      </div>

      {accounts && transferOpen && (
        <div className="shrink-0 border-b border-neutral-800 bg-neutral-900/70 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
              Account:
              <select
                className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-200 focus:border-purple-500 focus:outline-none"
                value={transferId}
                onChange={e => { setTransferId(e.target.value); setExportedToken(""); setTransferMsg(""); }}
              >
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <button
              className="rounded border border-neutral-700 bg-neutral-800 px-2.5 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-700 transition-colors disabled:opacity-40"
              onClick={doExport}
              disabled={transferBusy}
            >
              Export login
            </button>
            <span className="text-[10px] text-neutral-600">reads the selected account's DIM login into a token</span>
          </div>

          {exportedToken && (
            <div className="mt-2 flex items-start gap-2">
              <textarea
                readOnly
                className="h-11 flex-1 resize-none rounded border border-neutral-700 bg-neutral-950 p-1.5 font-mono text-[10px] text-purple-300 focus:outline-none"
                value={exportedToken}
                onFocus={e => e.currentTarget.select()}
              />
              <button
                className="shrink-0 rounded border border-neutral-700 bg-neutral-800 px-2.5 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-700 transition-colors"
                onClick={copyToken}
              >
                Copy
              </button>
            </div>
          )}

          <div className="mt-2 border-t border-neutral-800 pt-2">
            <div className="mb-1 text-[11px] text-neutral-400">
              Import a token into <span className="text-neutral-200">{accounts.find(a => a.id === transferId)?.name ?? transferId}</span>:
            </div>
            <div className="flex items-start gap-2">
              <textarea
                placeholder="Paste a marco-dim-1:… token here"
                className="h-11 flex-1 resize-none rounded border border-neutral-700 bg-neutral-950 p-1.5 font-mono text-[10px] text-neutral-200 placeholder-neutral-600 focus:border-purple-500 focus:outline-none"
                value={importText}
                onChange={e => setImportText(e.target.value)}
              />
              <button
                className="shrink-0 rounded border border-purple-700 bg-purple-950/50 px-2.5 py-0.5 text-[11px] text-purple-200 hover:bg-purple-900/60 transition-colors disabled:opacity-40"
                onClick={doImport}
                disabled={transferBusy}
              >
                Import
              </button>
            </div>
          </div>

          <div className="mt-2 flex items-start gap-1.5 rounded border border-red-900 bg-red-950/30 px-2 py-1.5">
            <span className="text-[13px] leading-none text-red-400">⚠</span>
            <span className="text-[10px] leading-snug text-red-300">
              This token contains your DIM / Bungie login. Only move it to your own devices — anyone with it can access your account.
            </span>
          </div>

          {transferMsg && <div className="mt-1.5 text-[10px] text-neutral-500">{transferMsg}</div>}
        </div>
      )}

      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}