import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { invoke } from "@tauri-apps/api/core";
import type { DesktopSession } from "./hooks/useTabs";
import "./styles.css";
import "./workbench.css";

async function start() {
  let desktopSession: DesktopSession | undefined;
  if ("__TAURI_INTERNALS__" in window) {
    try {
      desktopSession = { contents: await invoke<string | null>("load_session_backup") };
    } catch (error) {
      console.warn("Failed to read the desktop session:", error);
      desktopSession = { contents: null, loadFailed: true };
    }
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App desktopSession={desktopSession} />
    </React.StrictMode>
  );
}

void start();
