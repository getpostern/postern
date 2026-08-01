// React root — the one style entry point (fonts → tokens → base), then the provider tree:
// TanStack Query (freshness polling + the inspector cache) and the ONE global ToastProvider (#77).
//
// No ThemeProvider: the paper world is the ground and there is NO night variant (soul §4; base.css
// reads neither prefers-color-scheme nor [data-theme]). The old dark-SaaS theme is retired in phase 3.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";

import "./styles/index.css";

import { queryClient } from "./api/queryClient";
import { ToastProvider } from "./kit";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root mount node");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
