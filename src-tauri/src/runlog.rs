//! Per-run output logs.
//!
//! The panel is only a window onto a run. Both renderers keep a bounded number
//! of lines — xterm's scrollback, and the text view's line cap — because an
//! unbounded list is what makes the window slow, so a script printing tens of
//! thousands of lines has its early output scrolled out of reach for good.
//!
//! So every run also writes its complete output to a file under the app's log
//! directory. The panel reports the path when the run ends and offers a button
//! that opens the file in the editor, where the built-in find can search all of
//! it. Nothing about the panel's size can hide output any more.
//!
//! The log is written by the same threads that read the child's output, not by
//! the frontend, so a log is complete even when the UI dropped lines: the text
//! view's cap, a frontend that never drew the tail, or a run the user stopped
//! early all still leave a full file behind.

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

/// The log a finished run produced, in the shape the frontend expects. Carried
/// on the exit event (piped output) or the exit chunk (terminal output).
#[derive(Clone, Serialize)]
pub struct RunLogInfo {
    pub path: String,
    /// Lines written, not lines displayed: the panel's cap does not apply here.
    pub lines: u64,
    pub bytes: u64,
}

struct Inner {
    file: BufWriter<File>,
    bytes: u64,
    lines: u64,
}

/// A run's log file. Cloned as an `Arc` into every thread that produces output.
pub struct RunLog {
    path: PathBuf,
    inner: Mutex<Inner>,
}

impl RunLog {
    /// Creates the log (and its directory), pruning the oldest files.
    ///
    /// The name carries the local start time so a directory listing reads in run
    /// order. Two runs inside one second would collide on it, hence the suffix
    /// loop — appending to the previous run's file instead of starting a new one
    /// would silently merge two runs.
    pub fn create(dir: &Path) -> std::io::Result<Arc<Self>> {
        fs::create_dir_all(dir)?;
        // The caller is about to add one, so it may keep one less than the cap.
        prune(dir, MAX_RUN_LOGS - 1);
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let mut path = dir.join(format!("run-{}.log", stamp));
        let mut n = 1;
        while path.exists() {
            path = dir.join(format!("run-{}-{}.log", stamp, n));
            n += 1;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Arc::new(Self {
            path,
            inner: Mutex::new(Inner {
                file: BufWriter::new(file),
                bytes: 0,
                lines: 0,
            }),
        }))
    }

    /// Raw bytes, for the terminal path. ANSI sequences have to survive into the
    /// log so it reads the way the panel did.
    pub fn write_bytes(&self, data: &[u8]) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if inner.file.write_all(data).is_err() {
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
        if inner.file.write_all(line.as_bytes()).is_err() {
            return;
        }
        if inner.file.write_all(b"\r\n").is_err() {
            return;
        }
        inner.bytes += line.len() as u64 + 2;
        inner.lines += 1;
    }

    /// Push everything to disk. Called before the exit event, so a reader that
    /// opens the file the moment the run ends sees the whole thing.
    pub fn flush(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            let _ = inner.file.flush();
        }
    }

    fn info(&self) -> RunLogInfo {
        let (bytes, lines) = self.stats();
        RunLogInfo {
            path: self.path.to_string_lossy().into_owned(),
            lines,
            bytes,
        }
    }

    /// `(bytes, lines)` written so far.
    fn stats(&self) -> (u64, u64) {
        self.inner
            .lock()
            .map(|inner| (inner.bytes, inner.lines))
            .unwrap_or((0, 0))
    }
}

/// Where run logs live: the app's own log directory, so they never land in the
/// user's project — a script writing to its cwd cannot bury them, and the
/// project folder stays free of files nobody asked for.
pub fn log_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("runs")
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
    pub fn start(&self, app: &AppHandle, id: &str) -> Option<Arc<RunLog>> {
        let log = RunLog::create(&log_dir(app)).ok()?;
        if let Ok(mut map) = self.0.lock() {
            map.insert(id.to_string(), log.clone());
        }
        Some(log)
    }

    /// Removes `id` from the registry, flushes what it wrote and describes it.
    /// Called by whichever thread ends the run, so the exit event can carry the
    /// path. Returns `None` when there was no log (or it was already reported).
    pub fn finish(&self, id: &str) -> Option<RunLogInfo> {
        let log = match self.0.lock() {
            Ok(mut map) => map.remove(id),
            Err(_) => None,
        }?;
        log.flush();
        Some(log.info())
    }
}

/// Convenience wrapper for the threads that end a run.
pub fn finish(app: &AppHandle, id: &str) -> Option<RunLogInfo> {
    app.state::<RunLogs>().finish(id)
}

/// Deletes all but the `keep` newest logs. Failures are ignored: a log that
/// cannot be removed is not a reason to refuse to run anything.
fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut logs: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension() == Some(std::ffi::OsStr::new("log"))
                && path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("run-"))
        })
        .collect();
    // The names start with a sortable timestamp, so a plain sort is also
    // oldest-first.
    logs.sort();
    let excess = logs.len().saturating_sub(keep);
    for path in logs.iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bn-runlog-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn writes_lines_and_reports_them() {
        let dir = scratch("lines");
        let log = RunLog::create(&dir).unwrap();
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
        let log = RunLog::create(&dir).unwrap();
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
        let a = RunLog::create(&dir).unwrap();
        let b = RunLog::create(&dir).unwrap();
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

        RunLog::create(&dir).unwrap();

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
        let log = RunLog::create(&dir).unwrap();
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
    fn registry_hands_the_log_back_once() {
        let dir = scratch("registry");
        fs::create_dir_all(&dir).unwrap();
        let logs = RunLogs::default();
        let log = RunLog::create(&dir).unwrap();
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
