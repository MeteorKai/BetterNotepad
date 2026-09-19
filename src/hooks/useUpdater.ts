import { useCallback, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "latest"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export interface UpdateInfo {
  /** Version offered by the update endpoint. */
  version: string;
  /** Version currently running. */
  currentVersion: string;
  /** Release notes, may be empty. */
  notes: string;
  /** RFC 3339 publish date, may be empty. */
  date: string;
}

/** Percentage 0-100, or -1 when the server did not report a content length. */
export type UpdateProgress = number;

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Update checks against the `plugins.updater.endpoints` configured in
 * tauri.conf.json (a `latest.json` published alongside each GitHub release),
 * so this only works inside the packaged Tauri app — never in a plain browser.
 */
export function useUpdater() {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<UpdateProgress>(-1);

  // The Update handle owns a Rust-side resource, so it has to outlive the
  // `check()` call that produced it; the user may install hours later.
  const updateRef = useRef<Update | null>(null);
  const busyRef = useRef(false);
  // Read through a ref so `checkNow` keeps a stable identity: the startup effect
  // depends on it, and a changing identity would re-arm that effect on every
  // status change.
  const statusRef = useRef<UpdateStatus>("idle");
  statusRef.current = status;

  const closePending = useCallback(() => {
    const pending = updateRef.current;
    updateRef.current = null;
    // Releasing an already-released resource is harmless, but keep it quiet.
    pending?.close().catch(() => {});
  }, []);

  /**
   * `silent` mode is the startup check: it never moves the UI into an error
   * state, so a flaky network on launch is invisible unless there is good news.
   */
  const checkNow = useCallback(
    async (silent = false): Promise<Update | null> => {
      if (!isTauri() || busyRef.current) return null;
      if (statusRef.current === "downloading" || statusRef.current === "installing") return null;
      busyRef.current = true;

      if (!silent) {
        setStatus("checking");
        setError("");
        setInfo(null);
        setProgress(-1);
      }

      try {
        const update = await check({ timeout: 20000 });
        closePending();
        updateRef.current = update;

        if (update) {
          setInfo({
            version: update.version,
            currentVersion: update.currentVersion,
            notes: update.body ?? "",
            date: update.date ?? "",
          });
          setStatus("available");
        } else {
          setInfo(null);
          setStatus("latest");
        }
        return update;
      } catch (err) {
        if (!silent) {
          setError(messageOf(err));
          setStatus("error");
        }
        return null;
      } finally {
        busyRef.current = false;
      }
    },
    [closePending]
  );

  /**
   * Downloads and installs the pending update. `beforeInstall` runs first so the
   * caller can flush unsaved state: on Windows the installer terminates the app.
   */
  const install = useCallback(async (beforeInstall?: () => void) => {
    const update = updateRef.current;
    if (!update) return;

    beforeInstall?.();

    setError("");
    setStatus("downloading");
    setProgress(-1);

    let total = 0;
    let received = 0;

    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          setProgress(0);
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          setProgress(total > 0 ? Math.min(99, Math.round((received / total) * 100)) : -1);
        } else {
          setStatus("installing");
          setProgress(100);
        }
      });
      // On Windows the app is already gone by now; macOS/Linux fall through here.
      updateRef.current = null;
      await relaunch();
    } catch (err) {
      setError(messageOf(err));
      setStatus("error");
    }
  }, []);

  const reset = useCallback(() => {
    closePending();
    setStatus("idle");
    setInfo(null);
    setError("");
    setProgress(-1);
  }, [closePending]);

  return { status, info, error, progress, checkNow, install, reset };
}

export type Updater = ReturnType<typeof useUpdater>;
