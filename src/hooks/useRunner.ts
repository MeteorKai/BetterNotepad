import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "../i18n";

export interface InterpreterConfig {
  language: string;
  command: string;
  args: string[];
  enabled: boolean;
  available: boolean;
}

export interface RunLine {
  id: string;
  stream: "stdout" | "stderr";
  line: string;
  /** Purely informational notice from the app itself (cwd, hints). */
  notice?: boolean;
}

export interface RunExit {
  id: string;
  code: number | null;
}

const CONFIG_KEY = "betternotepad.interpreters";
const OUT_EVENT = "run://output";
const EXIT_EVENT = "run://exit";

function loadConfig(): InterpreterConfig[] {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function useRunner() {
  const [config, setConfig] = useState<InterpreterConfig[]>(loadConfig);
  const [output, setOutput] = useState<RunLine[]>([]);
  const [running, setRunning] = useState(false);
  const [lastExit, setLastExit] = useState<RunExit | null>(null);
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch {
      /* ignore */
    }
  }, [config]);

  // Stream run output / exit events for the current run.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unOut: (() => void) | undefined;
    let unExit: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      unOut = await listen<RunLine>(OUT_EVENT, (e) => {
        if (!cancelled && e.payload.id === runIdRef.current) {
          setOutput((prev) => [...prev, e.payload]);
        }
      });
      unExit = await listen<RunExit>(EXIT_EVENT, (e) => {
        if (cancelled) return;
        if (e.payload.id !== runIdRef.current) return;
        setRunning(false);
        setLastExit({ id: e.payload.id, code: e.payload.code });
        runIdRef.current = null;
      });
    })();
    return () => {
      cancelled = true;
      unOut?.();
      unExit?.();
    };
  }, []);

  const setInterpreter = useCallback((language: string, patch: Partial<InterpreterConfig>) => {
    setConfig((prev) =>
      prev.map((c) => (c.language === language ? { ...c, ...patch } : c))
    );
  }, []);

  const applyDetected = useCallback(async () => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    try {
      const detected = await invoke<InterpreterConfig[]>("detect_interpreters");
      setConfig((prev) => {
        const map = new Map(prev.map((c) => [c.language, c]));
        for (const d of detected) {
          const existing = map.get(d.language);
          if (d.available) {
            // Refresh the resolved PATH location; keep the user's enable state.
            map.set(d.language, {
              ...(existing ?? { language: d.language, args: d.args, enabled: true, available: true }),
              command: d.command,
              args: d.args,
            });
          } else if (!existing) {
            // Not found on PATH: add a disabled entry for manual configuration.
            map.set(d.language, { ...d, enabled: false });
          }
        }
        return Array.from(map.values());
      });
    } catch (err) {
      console.error("Failed to detect interpreters:", err);
    }
  }, []);

  // Auto-configure from the system PATH on startup.
  useEffect(() => {
    applyDetected();
  }, [applyDetected]);

  const run = useCallback(
    async (
      command: string,
      argsTemplate: string[],
      filePath: string,
      cwd?: string | null,
      hint?: string | null
    ): Promise<boolean> => {
      if (!("__TAURI_INTERNALS__" in window)) {
        setOutput([{ id: "local", stream: "stderr", line: t("run.desktopOnly") }]);
        return false;
      }
      const hasPlaceholder = argsTemplate.some((a) => a.includes("{file}"));
      const args = argsTemplate.map((a) => a.replaceAll("{file}", filePath));
      if (!hasPlaceholder) args.push(filePath);

      const dir = cwd?.trim() || null;
      const header: RunLine[] = [
        // Tell the user where the script will resolve relative paths. Without
        // this, a script writing "data.txt" appears to work while the file
        // lands somewhere unexpected — or fails outright.
        {
          id: "cwd",
          stream: "stderr",
          notice: true,
          line: dir ? t("run.in", { dir }) : t("run.inAppDir"),
        },
      ];
      if (hint) {
        header.push({ id: "cwd-hint", stream: "stderr", notice: true, line: hint });
      }
      setOutput(header);
      setLastExit(null);
      const id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      runIdRef.current = id;
      setRunning(true);
      try {
        // The working directory is decided by the caller and validated on the
        // Rust side; passing null means "inherit the app's directory".
        await invoke("run_program", { id, command, args, cwd: dir });
        return true;
      } catch (err) {
        console.error("Failed to run:", err);
        setRunning(false);
        runIdRef.current = null;
        setOutput((prev) => [
          ...prev,
          { id, stream: "stderr", line: String(err) },
        ]);
        return false;
      }
    },
    []
  );

  const stop = useCallback(async () => {
    if (runIdRef.current) {
      try {
        await invoke("stop_program", { id: runIdRef.current });
      } catch {
        /* ignore */
      }
    }
    setRunning(false);
    runIdRef.current = null;
  }, []);

  const clearOutput = useCallback(() => {
    setOutput([]);
    setLastExit(null);
  }, []);

  const showLocal = useCallback((line: string) => {
    setOutput([{ id: "local", stream: "stderr", line }]);
    setLastExit(null);
  }, []);

  return {
    config,
    setInterpreter,
    applyDetected,
    output,
    running,
    lastExit,
    run,
    stop,
    clearOutput,
    showLocal,
  };
}
