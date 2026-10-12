import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { t } from "../i18n";

type Phase = "idle" | "checking" | "latest" | "downloading" | "preparing" | "installing" | "cancelled" | "error";
type FailureStage = "checking" | "downloading" | "preparing" | "installing";

interface UpdateState {
  phase: Phase;
  version: string;
  downloaded: number;
  total: number;
  error: string;
  errorReason: string;
}

const initialState: UpdateState = { phase: "idle", version: "", downloaded: 0, total: 0, error: "", errorReason: "" };

function httpFailureReason(status: number, stage: FailureStage): string {
  if (status === 404) return stage === "downloading" ? t("about.updateAssetMissing") : t("about.updateManifestMissing");
  if (status === 401 || status === 403) return t("about.updateHttpRefused", { status });
  if (status === 429) return t("about.updateHttpLimited");
  if (status >= 500) return t("about.updateHttpServer", { status });
  if (status >= 200 && status < 300) return t("about.updateEndpointUnavailable");
  return t("about.updateHttpOther", { status });
}

function failureReason(error: string, stage: FailureStage): string {
  const status = error.match(/status(?: code)?\s*:?\s*(\d{3})/i);
  if (status) return httpFailureReason(Number(status[1]), stage);
  if (/timed? out|timeout/i.test(error)) return t("about.updateTimeout");
  if (/certificate|\btls\b|\bssl\b/i.test(error)) return t("about.updateTls");
  if (/\bdns\b|lookup address|resolve.*host/i.test(error)) return t("about.updateDns");
  if (/different key|public key.*(?:match|signature)/i.test(error)) return t("about.updateSignatureKey");
  if (/signed for version|signature does not specify the version/i.test(error)) return t("about.updateSignatureVersion");
  if (/signature|invalid encoding in minisign|invalid (?:symbol|byte)/i.test(error) && stage !== "checking") return t("about.updateSignatureInvalid");
  if (/fallback platforms|platform.*not found|unsupported application architecture|unsupported os/i.test(error)) return t("about.updatePlatform");
  if (/error decoding response body/i.test(error)) return t("about.updateManifestReadFailed");
  if (/missing field|expected .* at line|untagged enum|parsing .*version|pub_date|invalid type/i.test(error)) return t("about.updateManifestInvalid");
  if (/endpoints set|secure protocol|not allowed|not permitted|command.*not found/i.test(error)) return t("about.updateConfiguration");
  if (/os error 1223\b|authentication failed or was cancelled/i.test(error)) return t("about.updateAuthorizationCancelled");
  if (/os error 112\b|disk full|no space left|not enough space/i.test(error)) return t("about.updateDiskSpace");
  if (/os error 32\b|sharing violation|used by another process/i.test(error)) return t("about.updateFileLocked");
  if (/os error 5\b|access.*denied|permission denied/i.test(error)) return t("about.updatePermission");
  if (/invalid updater binary format|binary.*not found in.*archive/i.test(error)) return t("about.updatePackageInvalid");
  if (/error sending request|connection|network|connect error/i.test(error)) return t("about.updateNetwork");
  switch (stage) {
    case "checking": return t("about.updateCheckFailed");
    case "downloading": return t("about.updateDownloadFailed");
    case "preparing": return t("about.updatePrepareFailed");
    case "installing": return t("about.updateInstallFailed");
  }
}

export function useUpdater(prepareInstall: () => Promise<boolean>) {
  const [state, setState] = useState<UpdateState>(initialState);
  const busyRef = useRef(false);
  const prepareRef = useRef(prepareInstall);
  prepareRef.current = prepareInstall;

  const checkAndInstall = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setState({ ...initialState, phase: "checking" });
    let update: Update | null = null;
    let stage: FailureStage = "checking";
    const fail = (errorReason: string, error = "") => setState((s) => ({ ...s, phase: "error", errorReason, error }));
    try {
      if (!("__TAURI_INTERNALS__" in window)) {
        fail(t("about.updateDesktopOnly"));
        return;
      }
      if (!await invoke<boolean>("update_installation_supported")) {
        fail(t("about.updateInstallRequired"));
        return;
      }
      update = await check({ timeout: 15000 });
      if (!update) {
        setState({ ...initialState, phase: "latest" });
        return;
      }
      setState({ ...initialState, phase: "downloading", version: update.version });
      stage = "downloading";
      await update.download((event) => {
        setState((s) => {
          if (event.event === "Started") return { ...s, total: event.data.contentLength ?? 0 };
          if (event.event === "Progress") return { ...s, downloaded: s.downloaded + event.data.chunkLength };
          return s;
        });
      }, { timeout: 120000 });
      // download() verifies the signature. Never exit before it and the save gate succeed.
      setState((s) => ({ ...s, phase: "preparing" }));
      stage = "preparing";
      if (!await invoke<boolean>("update_installation_supported")) {
        fail(t("about.updateInstallRequired"));
        return;
      }
      if (!await prepareRef.current()) {
        setState((s) => ({ ...s, phase: "cancelled" }));
        return;
      }
      setState((s) => ({ ...s, phase: "installing" }));
      stage = "installing";
      // On Windows the NSIS updater exits this process and restarts the installed app.
      await update.install();
    } catch (err) {
      let error = err instanceof Error ? err.message : String(err);
      let reason = failureReason(error, stage);
      // The updater discards non-2xx HTTP statuses. Probe only this opaque error,
      // rather than claiming every missing response is a network/404 failure.
      if (stage === "checking" && error.includes("Could not fetch a valid release JSON from the remote")) {
        try {
          const status = await invoke<number>("update_endpoint_status");
          reason = httpFailureReason(status, stage);
          error += `\nHTTP ${status}`;
        } catch (diagnosticError) {
          const detail = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
          reason = failureReason(detail, stage);
          error += `\n${detail}`;
        }
      }
      fail(reason, error);
    } finally {
      if (update) await update.close().catch(() => {});
      busyRef.current = false;
    }
  }, []);

  const busy = ["checking", "downloading", "preparing", "installing"].includes(state.phase);
  const percent = state.total > 0 ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : null;
  let message = "";
  switch (state.phase) {
    case "checking": message = t("about.updateChecking"); break;
    case "latest": message = t("about.updateLatest"); break;
    case "downloading": message = t("about.updateDownloading", {
      version: state.version,
      progress: percent === null ? `${(state.downloaded / 1048576).toFixed(1)} MiB` : `${percent}%`,
    }); break;
    case "preparing": message = t("about.updatePreparing"); break;
    case "installing": message = t("about.updateInstalling"); break;
    case "cancelled": message = t("about.updateCancelled"); break;
    case "error": message = state.errorReason; break;
  }
  return { state, busy, busyRef, percent, message, checkAndInstall };
}

export type AppUpdater = ReturnType<typeof useUpdater>;
