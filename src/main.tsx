import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Toaster } from "sonner";
import { StoreProvider } from "./StoreContext";
import { LogProvider } from "./LogContext";
import { ErrorProvider } from "./ErrorContext";
import { DialogProvider } from "./DialogContext";
import "./i18next";
import { PlatformProvider } from "./PlatformContext";
import { AppErrorBoundary } from "./AppErrorBoundary";

// Safe browser preview mock for Tauri internals
if (typeof window !== "undefined" && !(window as any).__TAURI_INTERNALS__) {
  (window as any).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: any) => {
      console.log(`[nyx.loader preview] invoke: ${cmd}`, args);
      if (cmd === "keyring_available") return false;
      if (cmd === "list_devices") return [];
      if (cmd === "logged_in_as") return null;
      if (cmd === "has_stored_rppairing") return false;
      return null;
    },
    transformCallback: () => 0,
    metadata: {
      currentWindow: { label: "main" },
    },
  };
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <PlatformProvider>
        <StoreProvider>
          <ErrorProvider>
            <DialogProvider>
              <LogProvider>
                <App />
              </LogProvider>
            </DialogProvider>
          </ErrorProvider>
        </StoreProvider>
      </PlatformProvider>
      <Toaster richColors expand />
    </AppErrorBoundary>
  </React.StrictMode>,
);
