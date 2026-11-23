//! Locally retained output, with a disk limit independent of terminal scrollback.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// How many run logs to keep. Older ones are deleted when a new run starts, so
/// the directory stays small without ever touching anything outside it.
const MAX_RUN_LOGS: usize = 20;
const MAX_LOG_BYTES: u64 = 16 * 1024 * 1024;

/// The log a finished run produced, in the shape the frontend expects. Carried
/// on the exit event (piped output) or the exit chunk (terminal output).
#[derive(Clone, Serialize)]
pub struct RunLogInfo {
    pub path: String,
    /// Lines written, not lines displayed: the panel's cap does not apply here.
    pub lines: u64,
    pub bytes: u64,
    pub truncated: bool,
}

struct Inner {
    file: BufWriter<File>,
    bytes: u64,
    lines: u64,
    truncated: bool,
}

/// A run's log file. Cloned as an `Arc` into every thread that produces output.
pub struct RunLog {
    path: PathBuf,
    inner: Mutex<Inner>,
}

impl RunLog {
    fn create(dir: &Path, active: &HashMap<String, Arc<Self>>) -> std::io::Result<Arc<Self>> {
        fs::create_dir_all(dir)?;
        prune(dir, active)?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        // Exclusive creation prevents two runs from ever sharing a file.
        let mut n = 0;
        let (path, file) = loop {
            let name = if n == 0 { format!("run-{stamp}.log") } else { format!("run-{stamp}-{n}.log") };
            let path = dir.join(name);
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => break (path, file),
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
                Err(err) => return Err(err),
            }
        };
        Ok(Arc::new(Self {
            path,
            inner: Mutex::new(Inner {
                file: BufWriter::new(file),
                bytes: 0,
                lines: 0,
                truncated: false,
            }),
        }))
    }

    /// Raw bytes, for the terminal path. ANSI sequences have to survive into the
    /// log so it reads the way the panel did.
    pub fn write_bytes(&self, data: &[u8]) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if data.is_empty() || inner.truncated {
            return;
        }
        if data.len() as u64 > MAX_LOG_BYTES - inner.bytes || inner.file.write_all(data).is_err() {
            inner.truncated = true;
            return;
        }
        inner.bytes += data.len() as u64;
        inner.lines += data.iter().filter(|b| **b == b'\n').count() as u64;
    }

    /// One line, for the piped path, which hands over already-split lines.
    pub fn write_line(&self, line: &str) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if inner.truncated {
            return;
        }
        if line.len() as u64 + 2 > MAX_LOG_BYTES - inner.bytes
            || inner.file.write_all(line.as_bytes()).is_err()
            || inner.file.write_all(b"\r\n").is_err()
        {
            inner.truncated = true;
            return;
        }
        inner.bytes += line.len() as u64 + 2;
        inner.lines += 1;
    }

    /// Push everything to disk. Called before the exit event, so a reader that
    /// opens the file the moment the run ends sees the whole thing.
    pub fn flush(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.file.flush().is_err() {
                inner.truncated = true;
            }
        }
    }

    fn info(&self) -> RunLogInfo {
        let (bytes, lines, truncated) = self.inner.lock()
            .map(|inner| (inner.bytes, inner.lines, inner.truncated))
            .unwrap_or((0, 0, true));
        RunLogInfo { path: self.path.to_string_lossy().into_owned(), lines, bytes, truncated }
    }
}

/// Where run logs live: the app's own log directory, so they never land in the
/// user's project — a script writing to its cwd cannot bury them, and the
/// project folder stays free of files nobody asked for.
fn log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_log_dir().map(|path| path.join("runs")).map_err(|err| err.to_string())
}

/// Logs of the runs currently in flight, keyed by run id.
///
/// A registry rather than a variable owned by the run's own thread, because the
/// run does not always end where it started: pressing Stop tears the process
/// down from an IPC handler, and that is precisely when a runaway script's log
/// is worth handing back.
#[derive(Default)]
pub struct RunLogs(Mutex<HashMap<String, Arc<RunLog>>>);

impl RunLogs {
    /// Starts a log for `id`. `None` if the file could not be created — a run
    /// must never fail because its log did.
    pub fn start(&self, app: &AppHandle, id: &str, enabled: bool) -> Option<Arc<RunLog>> {
        if !enabled {
            return None;
        }
        // Serialize creation with clearing so a new file can't be mistaken
        // for an old, completed log in the gap before registration.
        let mut map = self.0.lock().ok()?;
        let log = RunLog::create(&log_dir(app).ok()?, &map).ok()?;
        map.insert(id.to_string(), log.clone());
        Some(log)
    }

    fn clear(&self, dir: &Path) -> Result<ClearLogs, String> {
        let active = self.0.lock().map_err(|err| err.to_string())?;
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(ClearLogs::default()),
            Err(err) => return Err(err.to_string()),
        };
        let mut result = ClearLogs::default();
        for entry in entries {
            let Ok(entry) = entry else { result.failed += 1; continue };
            let path = entry.path();
            if !is_run_log(&path) {
                continue;
            }
            if active.values().any(|log| log.path == path) {
                result.active += 1;
                continue;
            }
            match fs::remove_file(path) {
                Ok(()) => result.removed += 1,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {},
                Err(_) => result.failed += 1,
            }
        }
        Ok(result)
    }

    /// Removes `id` from the registry, flushes what it wrote and describes it.
    /// Called by whichever thread ends the run, so the exit event can carry the
    /// path. Returns `None` when there was no log (or it was already reported).
    pub fn finish(&self, id: &str) -> Option<RunLogInfo> {
        let mut active = self.0.lock().ok()?;
        let log = active.get(id)?;
        log.flush();
        let info = log.info();
        active.remove(id);
        Some(info)
    }
}

#[derive(Default, Serialize)]
pub struct ClearLogs {
    removed: usize,
    active: usize,
    failed: usize,
}

#[tauri::command]
pub async fn clear_run_logs(app: AppHandle) -> Result<ClearLogs, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<RunLogs>().clear(&log_dir(&app)?)
    }).await.map_err(|err| err.to_string())?
}

fn is_run_log(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else { return false };
    let Some(stamp) = name.strip_prefix("run-").and_then(|name| name.strip_suffix(".log")) else { return false };
    let mut parts = stamp.split('-');
    let digits = |part: &str, len| part.len() == len && part.bytes().all(|byte| byte.is_ascii_digit());
    parts.next().is_some_and(|date| digits(date, 8))
        && parts.next().is_some_and(|time| digits(time, 6))
        && parts.next().is_none_or(|suffix| !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()))
        && parts.next().is_none()
}

/// Convenience wrapper for the threads that end a run.
pub fn finish(app: &AppHandle, id: &str) -> Option<RunLogInfo> {
    app.state::<RunLogs>().finish(id)
}

// Make space without deleting a live session's log. If all slots are busy or
// locked, skip recording this run rather than exceed the disk cap.
fn prune(dir: &Path, active: &HashMap<String, Arc<RunLog>>) -> std::io::Result<()> {
    let mut logs = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if is_run_log(&path) { logs.push(path); }
    }
    logs.sort_by_cached_key(|path| {
        let name = path.file_stem().unwrap_or_default().to_string_lossy();
        let stamp = &name[4..19];
        let sequence = name.get(20..).and_then(|suffix| suffix.parse::<u64>().ok()).unwrap_or(0);
        (stamp.to_owned(), sequence)
    });
    let mut count = logs.len();
    for path in logs {
        if count < MAX_RUN_LOGS { return Ok(()); }
        if active.values().any(|log| log.path == path) { continue; }
        match fs::remove_file(path) {
            Ok(()) => count -= 1,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => count -= 1,
            Err(_) => {},
        }
    }
    if count < MAX_RUN_LOGS { Ok(()) } else { Err(std::io::Error::other("Run log directory is full")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_log(dir: &Path) -> std::io::Result<Arc<RunLog>> {
        RunLog::create(dir, &HashMap::new())
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bn-runlog-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn writes_lines_and_reports_them() {
        let dir = scratch("lines");
        let log = create_log(&dir).unwrap();
        log.write_line("hello");
        log.write_line("world");
        log.flush();

        let info = log.info();
        assert_eq!(info.lines, 2);
        // "hello\r\n" + "world\r\n"
        assert_eq!(info.bytes, 14);
        assert_eq!(fs::read_to_string(&info.path).unwrap(), "hello\r\nworld\r\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn counts_newlines_in_raw_bytes() {
        let dir = scratch("bytes");
        let log = create_log(&dir).unwrap();
        // A terminal stream with a carriage return that is not a newline: the
        // byte count grows but the line count must not.
        log.write_bytes(b"progress 50%\rprogress 100%\n");
        assert_eq!(log.info().lines, 1);
        // 12 + 1 + 13 + 1
        assert_eq!(log.info().bytes, 27);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_logs_in_the_same_second_do_not_collide() {
        let dir = scratch("collide");
        let a = create_log(&dir).unwrap();
        let b = create_log(&dir).unwrap();
        assert_ne!(a.info().path, b.info().path);
        a.write_line("first");
        b.write_line("second");
        a.flush();
        b.flush();
        // Each file holds only its own run's output.
        assert_eq!(fs::read_to_string(a.info().path).unwrap(), "first\r\n");
        assert_eq!(fs::read_to_string(b.info().path).unwrap(), "second\r\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_keeps_the_newest_logs() {
        let dir = scratch("prune");
        fs::create_dir_all(&dir).unwrap();
        for i in 0..MAX_RUN_LOGS + 5 {
            fs::write(dir.join(format!("run-20200101-0000{:02}.log", i)), b"x").unwrap();
        }
        // A bystander file that must survive: the directory belongs to the app,
        // but prune only ever removes what it named itself.
        fs::write(dir.join("notes.txt"), b"keep me").unwrap();

        create_log(&dir).unwrap();

        let logs = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension() == Some(std::ffi::OsStr::new("log")))
            .count();
        assert_eq!(logs, MAX_RUN_LOGS);
        assert!(dir.join("notes.txt").exists());
        // The oldest were the ones dropped.
        assert!(!dir.join("run-20200101-000000.log").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn chunked_raw_bytes_land_byte_for_byte() {
        let dir = scratch("raw");
        let log = create_log(&dir).unwrap();
        // Terminal output arrives in arbitrary slices, so a chunk boundary can
        // fall inside a multi-byte character. The log must not care: it takes
        // bytes and never decodes them, which is also what keeps the colours and
        // carriage returns it stores readable the way the panel was.
        let stream = "\u{1b}[32m正在扫描… 完成\u{1b}[0m\r\n进度 1/2\r进度 2/2\r\n".repeat(3);
        let bytes = stream.as_bytes();
        for piece in bytes.chunks(5) {
            log.write_bytes(piece);
        }
        log.flush();

        let info = log.info();
        assert_eq!(fs::read(&info.path).unwrap(), bytes);
        assert_eq!(info.bytes, bytes.len() as u64);
        // Two real newlines per repetition; the lone `\r` redraws are not lines.
        assert_eq!(info.lines, 6);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn marks_truncated_log_and_stops_at_the_byte_limit() {
        let dir = tempfile::tempdir().unwrap();
        let log = create_log(dir.path()).unwrap();
        let piece = [b'x'; 64 * 1024];
        for _ in 0..MAX_LOG_BYTES / piece.len() as u64 {
            log.write_bytes(&piece);
        }
        assert!(!log.info().truncated);
        log.write_line("omitted");
        log.flush();
        let info = log.info();
        assert!(info.truncated);
        assert_eq!(fs::metadata(info.path).unwrap().len(), MAX_LOG_BYTES);
    }

    #[test]
    fn clearing_completed_logs_leaves_active_logs_and_other_files_alone() {
        let dir = tempfile::tempdir().unwrap();
        let logs = RunLogs::default();
        let active = create_log(dir.path()).unwrap();
        logs.0.lock().unwrap().insert("active".into(), active.clone());
        let completed = dir.path().join("run-20200101-000000.log");
        let unrelated = dir.path().join("run-notes.log");
        fs::write(&completed, "old output").unwrap();
        fs::write(&unrelated, "not a BetterNotepad log").unwrap();

        let result = logs.clear(dir.path()).unwrap();
        assert_eq!((result.removed, result.active, result.failed), (1, 1, 0));
        assert!(!completed.exists());
        assert!(unrelated.is_file());
        assert!(active.path.is_file());
    }

    #[test]
    fn registry_hands_the_log_back_once() {
        let dir = scratch("registry");
        fs::create_dir_all(&dir).unwrap();
        let logs = RunLogs::default();
        let log = create_log(&dir).unwrap();
        log.write_line("only once");
        logs.0.lock().unwrap().insert("run-1".into(), log);

        let info = logs.finish("run-1").expect("first finish reports the log");
        assert_eq!(info.lines, 1);
        assert_eq!(fs::read_to_string(&info.path).unwrap(), "only once\r\n");
        // The second finish has nothing to report: it must not resurrect the
        // path on a later, unrelated exit event.
        assert!(logs.finish("run-1").is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
