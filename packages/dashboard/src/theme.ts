import { colorSchemeVariable, themeQuartz } from "ag-grid-community";

/** One AG Grid theme that follows the page: colors come from the same CSS variables as the rest of the UI. */
export const gridTheme = themeQuartz.withPart(colorSchemeVariable).withParams({
  accentColor: "var(--accent)",
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--text)",
  headerBackgroundColor: "var(--surface-2)",
  headerTextColor: "var(--muted)",
  borderColor: "var(--border)",
  oddRowBackgroundColor: "transparent",
  rowHoverColor: "var(--hover)",
  fontFamily: "inherit",
  fontSize: 14,
  headerFontWeight: 600,
  wrapperBorderRadius: 8,
  spacing: 7,
});

export function syncGridMode() {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => (document.body.dataset.agThemeMode = mq.matches ? "dark" : "light");
  apply();
  mq.addEventListener("change", apply);
}
