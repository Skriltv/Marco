import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../lib/api";
import { type Account, MAIN_ID, profileForAccount } from "../lib/accounts";

const LABEL = "redeem";
const REDEEM_URL = "https://www.bungie.net/7/en/codes/redeem";
const CODES_KEY = "marco.redeemCodes";
const SEEDED_KEY = "marco.redeemCodesSeeded";

const btn = "rounded border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-[11px] text-neutral-200 hover:bg-neutral-700 disabled:opacity-40 transition-colors";
const accent = "border-purple-800 bg-purple-900/40 hover:bg-purple-900/70 text-purple-200";

const DEFAULT_CODES = [
  "3CV-D6K-RD4", "3J9-AMM-7MG", "3TG-G67-PYD", "6AJ-XFR-9ND", "6LJ-GH7-TPA",
  "6MC-A3F-X3R", "7AM-PJR-GMX", "7D4-PKR-MD7", "7LD-PLJ-FN3", "7LV-GTK-T7J",
  "993-H3H-M6K", "9FY-KDD-PRT", "9LX-7YC-6TX", "9NG-KDD-PNG", "A67-C7X-3GN",
  "D6T-3JR-CKX", "D97-YCX-7JK", "DXL-XHC-X37", "F6K-D44-JH4", "F99-KPX-NCF",
  "FCX-P94-JCV", "FLK-TXG-P4A", "FMM-44A-RKP", "FPP-NHV-HNC", "HG7-YRG-HHF",
  "HN3-7K9-93G", "J64-HYC-HTD", "J6P-9YH-LLP", "JA9-PRC-XKX", "JGN-PX4-DFN",
  "JND-HLR-L69", "JRR-7YA-CCC", "JVG-VNT-GGG", "JXJ-HVA-RCX", "JYN-JAA-Y7D",
  "K9P-PVD-NR6", "L3P-XXR-GJ4", "L7T-CVV-3RD", "M3L-7DA-67C", "ML3-FD4-ND9",
  "MMX-3HF-CJ4", "PHV-6LF-9CP", "PKH-JL6-L4R", "PTD-GKG-CVN", "R9J-79m-j6C",
  "RA9-XPH-6KJ", "T67-JXY-PH6", "THR-33A-YKC", "TNN-DKM-6LG", "Tk7-D3p-FdF",
  "VA7-L7H-PNC", "VHT-6A7-3MM", "VMG-HXK-VAL", "VXN-V3T-MRP", "XFV-KHP-N97",
  "XMY-G9M-6XH", "XVK-RLA-RAM", "XVX-DKJ-CVM", "YAA-37T-FCN", "YRC-C3D-YNC",
];
const DEFAULT_CODES_TEXT = DEFAULT_CODES.join("\n");

function loadCodes(): string {
  try {
    const saved = localStorage.getItem(CODES_KEY);
    if (saved !== null) return saved;
    localStorage.setItem(SEEDED_KEY, "1");
    return DEFAULT_CODES_TEXT;
  } catch {
    return DEFAULT_CODES_TEXT;
  }
}

function saveCodes(text: string) {
  try { localStorage.setItem(CODES_KEY, text); } catch { /* ignore */ }
}

function parseCodes(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const c = raw.trim();
    if (!c || seen.has(c.toUpperCase())) continue;
    seen.add(c.toUpperCase());
    out.push(c);
  }
  return out;
}

interface Props {
  active: boolean;
  /** Same saved multi-login account list the DIM/Godroll/Overlay switcher uses. */
  accounts: Account[];
}

const ACTIVE_REDEEM_ACCOUNT_KEY = "marco.redeem.activeAccount";

export default function RedeemPanel({ active, accounts }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const createdRef = useRef(false);
  const createdProfileRef = useRef<string | undefined>(undefined);
  const wasSigningInRef = useRef(false);

  // Redeem gets its OWN independent account selection — reusing the same
  // saved logins as DIM/Godroll/Overlay, but picked separately, so you can
  // e.g. redeem codes on "Alt" while DIM stays on "Main", or vice versa.
  const [activeId, setActiveId] = useState<string>(
    () => localStorage.getItem(ACTIVE_REDEEM_ACCOUNT_KEY) ?? MAIN_ID,
  );
  useEffect(() => { localStorage.setItem(ACTIVE_REDEEM_ACCOUNT_KEY, activeId); }, [activeId]);
  const activeAccount = accounts.find(a => a.id === activeId) ?? accounts[0] ?? { id: MAIN_ID, name: "Main" };
  const profile = profileForAccount(activeAccount.id);

  const [codesText, setCodesText] = useState(loadCodes);
  const [editingCodes, setEditingCodes] = useState(false);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<{ i: number; total: number; code: string } | null>(null);
  const [status, setStatus] = useState("");
  // One entry per code actually submitted this run, so the item/response
  // for each code stays visible next to it instead of being overwritten by
  // the next code's status line.
  const [results, setResults] = useState<{ code: string; ok: boolean; msg: string; retry: boolean }[]>([]);
  // Codes already submitted in the current (possibly stopped-and-resumed)
  // session, so hitting Stop and then Redeem again picks up where it left
  // off instead of resubmitting everything from the top.
  const [attempted, setAttempted] = useState<Set<string>>(new Set());
  const [popupLabel, setPopupLabel] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);

  const codes = parseCodes(codesText);

  useEffect(() => { saveCodes(codesText); }, [codesText]);

  useEffect(() => {
    const unlistenProgress = listen<[number, number, string]>("redeem-progress", (e) => {
      const [i, total, code] = e.payload;
      setProgress({ i, total, code });
      setStatus("Submitting " + (i + 1) + " of " + total + ": " + code);
    });

    const unlistenResult = listen<any>("redeem-result", (e) => {
      const p = e.payload || {};
      const code = p.code ?? "";
      const ok = !!p.ok;
      const msg = p.msg ?? "";
      const retryTag = p.retry ? " (retry)" : "";
      // Keep the top status line to just the code + outcome — the full
      // Bungie response (where the item name lives) goes in the results
      // list below instead of cluttering this line with raw page text.
      setStatus((ok ? "✔ " : "✘ ") + code + retryTag);
      // Newest first, so with only ~3 rows visible the code that just
      // finished is always in view without having to scroll down to it.
      setResults(rs => [{ code, ok, msg, retry: !!p.retry }, ...rs]);
      setAttempted(prev => (prev.has(code) ? prev : new Set(prev).add(code)));
    });

    const unlistenDone = listen<any>("redeem-complete", (e) => {
      setRunning(false);
      setStopping(false);
      setProgress(null);
      let submittedCount = 0;
      if (typeof e.payload === "number") {
        submittedCount = e.payload;
      } else if (e.payload && typeof e.payload === "object" && "submitted" in e.payload) {
        submittedCount = e.payload.submitted;
      }
      const signedOut = e.payload && typeof e.payload === "object" && e.payload.signedOut;
      const wasStopped = e.payload && typeof e.payload === "object" && e.payload.stopped;
      if (signedOut) {
        setStatus("Stopped — looks like you're signed out on this tab. Sign in to Bungie.net below, then hit Redeem again.");
      } else if (wasStopped) {
        setStatus("Stopped early — see the results below for what was submitted before you hit Stop.");
      } else {
        setStatus("Done — submitted " + submittedCount + " code(s). See the item next to each code below.");
      }
    });

    const unlistenNav = listen<[string, string, boolean]>("web-panel-navigated", (e) => {
      const [parentLabel, navUrl, isOauth] = e.payload;
      if (parentLabel !== LABEL) return;
      setIsSigningIn(isOauth);

      if (isOauth) {
        wasSigningInRef.current = true;
        return;
      }

      // Bungie.net's sign-in flow redirects back to bungie.net's own home
      // page rather than back to the redeem page. If we were just signing
      // in and landed anywhere on bungie.net other than the redeem page,
      // snap the panel back to the redeem page automatically.
      if (!wasSigningInRef.current) return;
      try {
        const parsed = new URL(navUrl);
        const path = parsed.pathname.replace(/\/+$/, "");
        const isRedeemPage = parsed.hostname.endsWith("bungie.net") && path === "/7/en/codes/redeem";
        if (isRedeemPage) {
          wasSigningInRef.current = false;
        } else if (parsed.hostname.endsWith("bungie.net")) {
          // Bungie's flow often lands on its own interstitial ("You're
          // logged in! Continue to Bungie.net.") before the redeem page —
          // that link's click is what actually finalizes the session. Nudge
          // it forward in place (click "Continue" if present, else soft-
          // navigate) instead of tearing the whole panel down: destroying
          // it here killed the interstitial before the session finished
          // establishing, so the "reset" redeem page just asked to sign in
          // again. Leave wasSigningInRef set so we keep nudging through any
          // further intermediate hops until we actually land on the redeem
          // page above.
          api.continueSignIn(LABEL, REDEEM_URL).catch(() => {});
        }
      } catch { /* ignore unparsable urls */ }
    });

    const unlistenPopupOpened = listen<[string, string]>("web-panel-popup-opened", (e) => {
      const [parentLabel, popup] = e.payload;
      if (parentLabel === LABEL) setPopupLabel(popup);
    });
    const unlistenPopupClosed = listen<[string, string]>("web-panel-popup-closed", (e) => {
      const [parentLabel] = e.payload;
      if (parentLabel === LABEL) setPopupLabel(null);
    });

    return () => {
      unlistenProgress.then(f => f());
      unlistenResult.then(f => f());
      unlistenDone.then(f => f());
      unlistenNav.then(f => f());
      unlistenPopupOpened.then(f => f());
      unlistenPopupClosed.then(f => f());
    };
  }, []);

  function currentBounds(): api.PanelBounds | null {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  }

  useEffect(() => {
    let cancelled = false;

    async function sync() {
      const bounds = currentBounds();
      if (!bounds) return;
      try {
        if (createdRef.current && createdProfileRef.current !== profile) {
          await api.closeWebPanel(LABEL);
          createdRef.current = false;
        }

        if (!createdRef.current) {
          await api.ensureWebPanel(LABEL, REDEEM_URL, bounds, profile);
          createdRef.current = true;
          createdProfileRef.current = profile;
        } else {
          await api.setWebPanelBounds(LABEL, bounds);
        }
        if (cancelled) return;
        if (active) await api.showWebPanel(LABEL);
        else await api.hideWebPanel(LABEL);
      } catch { /* best-effort */ }
    }

    sync();

    const ro = new ResizeObserver(() => { if (createdRef.current) sync(); });
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener("resize", sync);

    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener("resize", sync);
      if (createdRef.current) api.hideWebPanel(LABEL).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, profile]);

  /** Close/recreate the redeem webview pointed back at the Bungie redeem URL. */
  async function resetToRedeemPage() {
    try {
      await api.closeWebPanel(LABEL);
      createdRef.current = false;
      const bounds = currentBounds();
      if (bounds) {
        await api.ensureWebPanel(LABEL, REDEEM_URL, bounds, profile);
        createdRef.current = true;
        createdProfileRef.current = profile;
        await api.showWebPanel(LABEL);
      }
      setStatus("Reset back to code redemption page.");
    } catch {
      /* best-effort */
    }
  }

  async function closeSignIn() {
    try {
      if (popupLabel) {
        await api.closeWebPanel(popupLabel).catch(() => {});
        setPopupLabel(null);
      }
      setIsSigningIn(false);
      wasSigningInRef.current = false;
      await resetToRedeemPage();
    } catch {
      /* best-effort */
    }
  }

  async function redeemAll() {
    if (codes.length === 0) { setStatus("Add some codes first"); setEditingCodes(true); return; }
    if (!createdRef.current || !active) {
      setStatus("Open this tab and sign in to Bungie.net below first");
      return;
    }

    // Skip whatever we already submitted before the last Stop, so this
    // continues the cycle instead of starting back at code #1. If every
    // code in the list has already been attempted this session (e.g. a
    // run finished normally, or the list was fully replaced), that's a
    // fresh pass — clear the slate and submit everything again.
    const remaining = codes.filter(c => !attempted.has(c));
    const toSubmit = remaining.length > 0 ? remaining : codes;
    const resuming = toSubmit.length < codes.length;

    if (!resuming) {
      setAttempted(new Set());
      setResults([]);
    }

    setRunning(true);
    setStopping(false);
    setStatus(resuming
      ? "Resuming — " + toSubmit.length + " code(s) left..."
      : "Starting " + toSubmit.length + " code(s)...");
    try {
      await api.redeemCodes(LABEL, toSubmit);
    } catch (e) {
      setStatus("Failed: " + e);
      setRunning(false);
    }
  }

  async function stopRedeeming() {
    if (!running || stopping) return;
    setStopping(true);
    setStatus("Stopping after the current code finishes...");
    try {
      await api.stopRedeem();
    } catch (e) {
      setStatus("Couldn't stop: " + e);
      setStopping(false);
    }
  }

  function resetToDefaults() {
    setCodesText(DEFAULT_CODES_TEXT);
    setAttempted(new Set());
    setResults([]);
    setStatus("Restored the default " + DEFAULT_CODES.length + " code(s)");
  }

  const showCloseSignIn = isSigningIn || popupLabel !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-neutral-800 bg-neutral-900/40 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-neutral-400">Destiny 2 Code Redeemer</span>
          <div className="flex items-center gap-1 text-[11px]">
            <span className="text-neutral-600">Account:</span>
            <select
              className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-[11px] text-neutral-200 focus:border-purple-500 focus:outline-none"
              value={activeAccount.id}
              onChange={e => setActiveId(e.target.value)}
              title="Which saved login this tab redeems on — independent of the DIM tab's account"
            >
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <span className="flex-1" />
          {showCloseSignIn && (
            <button
              className={btn + " " + accent}
              title="Cancel sign-in and return to code redemption page"
              onClick={closeSignIn}
            >
              ✕ Close sign-in
            </button>
          )}
          <button className={btn} onClick={() => setEditingCodes(v => !v)}>
            {editingCodes ? "Hide codes" : "Edit codes (" + codes.length + ")"}
          </button>
          <button
            className={btn + " border-red-800 bg-red-900/40 hover:bg-red-900/70 text-red-200"}
            disabled={!running || stopping}
            onClick={stopRedeeming}
            title="Stop after the code currently being submitted finishes"
          >
            {stopping ? "Stopping..." : "■ Stop"}
          </button>
          <button className={btn + " " + accent} disabled={running || codes.length === 0} onClick={redeemAll}>
            {running
              ? "Redeeming..."
              : (() => {
                  const left = codes.filter(c => !attempted.has(c)).length;
                  return left > 0 && left < codes.length
                    ? "Resume Redeeming (" + left + " left)"
                    : "Redeem All on Current Account";
                })()}
          </button>
        </div>
        {editingCodes && (
          <>
            <textarea
              className="h-24 w-full resize-none rounded border border-neutral-700 bg-neutral-950 p-2 font-mono text-[11px] text-neutral-100 placeholder-neutral-600 focus:border-purple-500 focus:outline-none"
              value={codesText}
              onChange={e => setCodesText(e.target.value)}
              placeholder={"One code per line (or comma-separated), e.g.\nABC-DEF-GHI\nXYZ123"}
              spellCheck={false}
            />
            <div className="flex items-center gap-2">
              <button className={btn} onClick={resetToDefaults}>
                Reset to default list ({DEFAULT_CODES.length})
              </button>
              <span className="text-[10px] text-neutral-600">
                Add new codes above the rest — order doesn't matter, dupes are dropped automatically.
              </span>
            </div>
          </>
        )}
        {status && (
          <div className="text-[10px] text-neutral-500">
            {status}
            {running && progress && (
              <span className="ml-2 text-purple-400">
                ({progress.i + 1}/{progress.total})
              </span>
            )}
          </div>
        )}
        {results.length > 0 && (
          <div className="max-h-[76px] overflow-y-auto rounded border border-neutral-800 bg-neutral-950/60">
            {results.map((r, idx) => (
              <div
                key={idx}
                className="flex items-start gap-2 border-b border-neutral-900 px-2 py-1 text-[10px] last:border-b-0"
              >
                <span className={r.ok ? "text-green-400" : "text-red-400"}>{r.ok ? "✔" : "✘"}</span>
                <span className="shrink-0 font-mono text-neutral-300">{r.code}</span>
                {r.retry && <span className="shrink-0 text-purple-400">(retry)</span>}
                {/* This is Bungie's own confirmation/error text, which is where
                    the redeemed item's name actually comes from — Marco has no
                    separate code→item list to draw on. */}
                <span className="text-neutral-500">{r.msg}</span>
              </div>
            ))}
          </div>
        )}
        <div className="text-[10px] text-neutral-600">
          Log into Bungie.net in the panel below first — use the Account picker above to choose which saved
          login this tab redeems on (independent of whichever account is active on the DIM tab) — then hit
          "Redeem All on Current Account" to fill and submit every code in the list on the real page one at a
          time. Watch the page below for each code's actual success/error message.
        </div>
      </div>
      <div ref={containerRef} className="relative min-h-0 flex-1" />
    </div>
  );
}