import {
  CellStyleModule,
  ClientSideRowModelModule,
  DateFilterModule,
  ModuleRegistry,
  NumberFilterModule,
  QuickFilterModule,
  RowStyleModule,
  TextFilterModule,
  TooltipModule,
  ValidationModule,
} from "ag-grid-community";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { syncGridMode } from "./theme";
import "./styles.css";

// Only the grid features the dashboard uses, to keep the bundle small.
ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  TextFilterModule,
  NumberFilterModule,
  DateFilterModule,
  QuickFilterModule,
  CellStyleModule,
  RowStyleModule,
  TooltipModule,
  ...(import.meta.env.DEV ? [ValidationModule] : []),
]);
syncGridMode();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
