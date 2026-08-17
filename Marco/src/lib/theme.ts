export type ThemeId =
  | "graphite"
  | "ocean"
  | "forest"
  | "amber"
  | "rose"
  | "violet"
  | "teal"
  | "pink";

export interface ThemeDef {
  id: ThemeId;
  label: string;
  /** Swatch color shown in Settings — matches the theme's accent. */
  swatch: string;
}

export const THEMES: ThemeDef[] = [
  { id: "graphite", label: "Graphite", swatch: "#737373" },
  { id: "forest", label: "Forest", swatch: "#10b981" },
  { id: "ocean", label: "Ocean", swatch: "#3b82f6" },
  { id: "amber", label: "Amber", swatch: "#f97316" },
  { id: "rose", label: "Rose", swatch: "#f43f5e" },
  { id: "violet", label: "Violet", swatch: "#8b5cf6" },
  { id: "teal", label: "Teal", swatch: "#14b8a6" },
  { id: "pink", label: "Pink", swatch: "#ec4899" },
];

const THEME_KEY = "marco.theme";
const DEFAULT_THEME: ThemeId = "graphite";

export function loadTheme(): ThemeId {
  const saved = localStorage.getItem(THEME_KEY);
  return THEMES.some(t => t.id === saved) ? (saved as ThemeId) : DEFAULT_THEME;
}

export function saveTheme(id: ThemeId) {
  localStorage.setItem(THEME_KEY, id);
}

/** Sets the `data-theme` attribute the CSS in styles.css keys off of. */
export function applyTheme(id: ThemeId) {
  document.documentElement.dataset.theme = id;
}
