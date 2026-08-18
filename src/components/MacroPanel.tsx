import { useEffect, useState, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../lib/api";
import type { MacroFile, MacroBinding } from "../lib/api";

const btn = "rounded border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-[11px] text-neutral-200 hover:bg-neutral-700 disabled:opacity-40 transition-colors";
const accent = "border-purple-800 bg-purple-900/40 hover:bg-purple-900/70 text-purple-200";
const danger = "border-red-800 bg-red-900/40 hover:bg-red-900/70 text-red-200";

export default function MacroPanel() {
  const [files, setFiles] = useState<MacroFile[]>([]);
  const [bindings, setBindings] = useState<MacroBinding[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [editorName, setEditorName] = useState("");
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { refresh(); }, []);
  useEffect(() => { api.registerHotkeys(bindings).catch(() => {}); }, [bindings]);

  useEffect(() => {
    const unlisten = listen("macros-changed", () => {
      refresh();
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  async function refresh() {
    try {
      const list = await api.listMacros();
      setFiles(list);
      const existing = await api.loadBindings();
      setBindings(existing);
    } catch (e) { setStatus(String(e)); }
  }

  async function run(file: string) {
    setStatus("Running " + file + "...");
    try { await api.runMacro(file); setStatus("Ran " + file); }
    catch (e) { setStatus(String(e)); }
  }

  function startNew() {
    setEditing("new"); setEditorName(""); setEditorContent("");
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  async function startEdit(file: string) {
    setEditing(file);
    try {
      const content = await api.readMacroContent(file);
      setEditorContent(content);
    } catch { setEditorContent(""); }
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  async function saveEditor() {
    if (!editing) return;
    const name = editing === "new" ? editorName : editing;
    if (!name) { setStatus("Name required"); return; }
    const fname = name.endsWith(".ahk") ? name : name + ".ahk";
    try {
      await api.saveMacroContent(fname, editorContent);
      setStatus("Saved " + fname);
      setEditing(null);
      refresh();
    } catch (e) { setStatus("Save failed: " + e); }
  }

  async function deleteFile(file: string) {
    try {
      await api.deleteMacro(file);
      const next = bindings.filter(b => b.file !== file);
      setBindings(next);
      api.saveBindings(next).catch(() => {});
      if (editing === file) setEditing(null);
      setStatus("Deleted " + file);
      refresh();
    } catch (e) { setStatus(String(e)); }
  }

  function assignHotkey(file: string) {
    setRecording(file);
    setStatus('Press a key combo for "' + file + '"...');
    const handler = async (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("Ctrl");
      if (e.altKey) mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (["Control","Alt","Shift","Meta"].includes(key)) return;
      const combo = [...mods, key].join("+");
      window.removeEventListener("keydown", handler);
      setBindings(prev => {
        const next = prev.filter(b => b.file !== file);
        next.push({ name: file.replace(".ahk",""), file, hotkey: combo, enabled: true });
        api.saveBindings(next).catch(() => {});
        return next;
      });
      setRecording(null);
      setStatus("Bound " + file + " -> " + combo);
    };
    window.addEventListener("keydown", handler);
    setTimeout(() => {
      window.removeEventListener("keydown", handler);
      if (recording === file) { setRecording(null); setStatus(""); }
    }, 5000);
  }

  function toggleBinding(file: string) {
    setBindings(prev => {
      const next = prev.map(b => b.file === file ? {...b, enabled: !b.enabled} : b);
      api.saveBindings(next).catch(() => {});
      return next;
    });
  }

  const selectedFile = files.find(f => f.name === editing) ?? null;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex w-[260px] shrink-0 flex-col border-r border-neutral-800 bg-neutral-950/60">
        <div className="flex items-center gap-1.5 border-b border-neutral-800 px-2 py-1.5">
          <button className={btn + " " + accent} onClick={startNew}>+ New</button>
          <button className={btn} onClick={refresh} title="Refresh">↻</button>
          <button className={btn} onClick={() => api.openMacrosFolder()} title="Open folder">📁</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {files.length === 0 ? (
            <div className="mt-12 text-center text-[11px] text-neutral-600">
              No macros yet.<br/>Click <span className="text-purple-400">+ New</span> to create one.
            </div>
          ) : (
            files.map(f => {
              const binding = bindings.find(b => b.file === f.name);
              const isActive = editing === f.name;
              return (
                <div key={f.name} className={"mb-0.5 rounded border px-2 py-1.5 " + (isActive ? "border-purple-600 bg-purple-950/30" : "border-transparent hover:border-neutral-700 hover:bg-neutral-900")}>
                  <div className="flex items-center gap-1">
                    <button className="flex-1 truncate text-left text-[12px] text-neutral-200 hover:text-purple-300"
                      onClick={() => startEdit(f.name)}>{f.name}</button>
                    {binding?.hotkey && (
                      <span className={"cursor-pointer rounded px-1.5 py-0 text-[10px] font-mono " + (binding.enabled ? "bg-purple-900/50 text-purple-300" : "bg-neutral-800 text-neutral-500 line-through")}
                        onClick={e => { e.stopPropagation(); toggleBinding(f.name); }}
                        title={binding.enabled ? "Disable" : "Enable"}>{binding.hotkey}</span>
                    )}
                    <button className={"rounded px-1.5 py-0.5 text-[10px] " + (recording === f.name ? "bg-amber-900/50 text-amber-300 animate-pulse" : "text-neutral-600 hover:bg-purple-900/30 hover:text-purple-300")}
                      onClick={e => { e.stopPropagation(); assignHotkey(f.name); }} title="Set hotkey">⌨</button>
                    <button className="rounded px-1.5 py-0.5 text-[10px] text-neutral-600 hover:bg-emerald-900/30 hover:text-emerald-300"
                      onClick={e => { e.stopPropagation(); run(f.name); }} title="Run">▶</button>
                  </div>
                  <div className="mt-0.5 flex gap-2 text-[10px] text-neutral-600">
                    <span>{f.size > 0 ? (f.size / 1024).toFixed(1) + " KB" : "empty"}</span>
                    {binding && !binding.enabled && <span className="text-neutral-700">disabled</span>}
                    {recording === f.name && <span className="text-amber-400">listening...</span>}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div className="border-t border-neutral-800 px-2 py-1 text-[10px] text-neutral-600">
          {status || files.length + " macro" + (files.length !== 1 ? "s" : "")}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col bg-neutral-950">
        {editing ? (<>
          <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
            {editing === "new" ? (
              <input className="w-48 rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs text-neutral-100 placeholder-neutral-600 focus:border-purple-500 focus:outline-none"
                placeholder="macro_name.ahk" value={editorName}
                onChange={e => setEditorName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") saveEditor(); }} autoFocus />
            ) : (<>
              <span className="font-mono text-xs text-neutral-300">{editing}</span>
              {selectedFile?.size !== undefined && <span className="text-[10px] text-neutral-600">{(selectedFile.size / 1024).toFixed(1)} KB</span>}
            </>)}
            <span className="flex-1" />
            <button className={btn + " " + accent} onClick={saveEditor}>Save</button>
            <button className={btn + " " + danger} onClick={() => deleteFile(editing === "new" ? editorName : editing)}>Delete</button>
            <button className={btn} onClick={() => setEditing(null)}>Close</button>
          </div>
          <textarea ref={textareaRef}
            className="min-h-0 flex-1 resize-none bg-neutral-950 p-3 font-mono text-[13px] leading-relaxed text-emerald-200 placeholder-neutral-700 focus:outline-none"
            value={editorContent} onChange={e => setEditorContent(e.target.value)}
            placeholder={"; Write your AHK script here...\n#Persistent\nF1::\n  Send, Hello World\n  return"}
            spellCheck={false} />
        </>) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-neutral-600">
            <span className="text-3xl opacity-20">⌨</span>
            <span>Select a macro or click <span className="text-purple-400">+ New</span></span>
          </div>
        )}
      </div>
    </div>
  );
}