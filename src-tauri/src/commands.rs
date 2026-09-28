use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::runlog::{self, RunLog, RunLogInfo};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

// Windows: spawn child processes without opening a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn build_command(name: &str) -> Command {
    let mut cmd = Command::new(name);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[derive(Clone, Serialize)]
pub struct FileContent {
    pub content: String,
    pub encoding: String,
}

// Decode a file's raw bytes to UTF-8 and report the detected encoding. BOM is
// honored first, then strict UTF-8 validation, then a GBK fallback — GBK covers
// GB2312 and is the overwhelmingly common non-UTF-8 encoding on Chinese Windows.
fn decode_bytes(bytes: &[u8]) -> (String, String) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (text, _, _) = encoding_rs::UTF_8.decode(&bytes[3..]);
        return (text.into_owned(), "utf-8-bom".into());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return (text.into_owned(), "utf-16le".into());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return (text.into_owned(), "utf-16be".into());
    }
    if std::str::from_utf8(bytes).is_ok() {
        return (String::from_utf8_lossy(bytes).into_owned(), "utf-8".into());
    }
    let (text, _, _) = encoding_rs::GBK.decode(bytes);
    (text.into_owned(), "gbk".into())
}

// Encode UTF-8 text back into the chosen on-disk encoding (prepending a BOM
// where the encoding calls for one).
fn encode_text(text: &str, encoding: &str) -> Vec<u8> {
    match encoding {
        "utf-8-bom" => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(text.as_bytes());
            out
        }
        "utf-16le" => {
            // encoding_rs's generic encode() does NOT emit UTF-16 bytes for the
            // UTF-16 encodings, so build the code units manually.
            let mut out = vec![0xFF, 0xFE];
            for unit in text.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
            out
        }
        "utf-16be" => {
            let mut out = vec![0xFE, 0xFF];
            for unit in text.encode_utf16() {
                out.extend_from_slice(&unit.to_be_bytes());
            }
            out
        }
        "gbk" => encoding_rs::GBK.encode(text).0.into_owned(),
        _ => text.as_bytes().to_vec(),
    }
}

#[tauri::command]
pub fn read_file(path: String) -> Result<FileContent, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    let (content, encoding) = decode_bytes(&bytes);
    Ok(FileContent { content, encoding })
}

#[tauri::command]
pub fn write_file(path: String, content: String, encoding: Option<String>) -> Result<(), String> {
    let enc = encoding.unwrap_or_else(|| "utf-8".to_string());
    let bytes = encode_text(&content, &enc);
    fs::write(&path, bytes).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
pub fn file_exists(path: String) -> bool {
    PathBuf::from(&path).exists()
}

#[tauri::command]
pub fn get_file_name(path: String) -> String {
    PathBuf::from(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Untitled".to_string())
}

// ==== Files handed to us by the OS ===========================================
//
// A file can reach the app two ways:
//   * cold start  — Windows "Open with" puts the path on our own command line;
//   * warm start  — BetterNotepad is already running, so the second process is
//                   killed by the single-instance plugin and its command line is
//                   forwarded to us instead (see `queue_forwarded_open_files`).
// Both funnel through `extract_file_args` so they behave identically.

/// Paths forwarded by a second instance that the webview has not consumed yet.
///
/// Deliberately a plain `static` rather than Tauri managed state: the
/// single-instance callback can fire as soon as the plugin's hidden window
/// exists, which happens inside `App::build` — earlier than we can be certain
/// our own `.manage()` has run.
static PENDING_OPEN_FILES: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Pull file paths out of a raw `argv`.
///
/// The first element is always the executable path and must be dropped: on a
/// cold start it is our own `argv[0]`, and for a forwarded second instance the
/// plugin sends that process's `std::env::args()` verbatim — it does *not* skip
/// `argv[0]` for us.
///
/// Everything else is kept only if it resolves to an existing file, which also
/// screens out dev-server flags and stray arguments.
fn extract_file_args(argv: &[String], cwd: &str) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();

    for raw in argv.iter().skip(1) {
        let arg = raw.trim();
        if arg.is_empty() || arg.starts_with('-') {
            continue;
        }

        let path = Path::new(arg);
        let resolved = if path.is_absolute() {
            path.to_path_buf()
        } else {
            Path::new(cwd).join(path)
        };

        if !resolved.is_file() {
            continue;
        }

        let value = resolved.to_string_lossy().to_string();
        let duplicate = files.iter().any(|existing| {
            if cfg!(windows) {
                existing.eq_ignore_ascii_case(&value)
            } else {
                existing == &value
            }
        });
        if !duplicate {
            files.push(value);
        }
    }

    files
}

/// Cold start: the paths Windows passed on our own command line.
#[tauri::command]
pub fn get_startup_files() -> Vec<String> {
    let argv: Vec<String> = std::env::args().collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    extract_file_args(&argv, &cwd.to_string_lossy())
}

/// Warm start: called from the single-instance callback, which runs on the
/// plugin's message loop. Buffers the paths and returns them so the caller can
/// also emit them to the frontend.
pub fn queue_forwarded_open_files(argv: &[String], cwd: &str) -> Vec<String> {
    let files = extract_file_args(argv, cwd);
    if files.is_empty() {
        return files;
    }

    let mut pending = match PENDING_OPEN_FILES.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    for file in &files {
        if !pending.iter().any(|p| p == file) {
            pending.push(file.clone());
        }
    }
    drop(pending);

    files
}

/// The webview drains this once on mount. It exists because a forwarded path can
/// arrive while the frontend is still booting and has no event listener yet —
/// a duplicate delivery is harmless, since the tab list de-dupes by path.
#[tauri::command]
pub fn take_pending_open_files() -> Vec<String> {
    let mut pending = match PENDING_OPEN_FILES.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    std::mem::take(&mut *pending)
}

#[tauri::command]
pub fn rename_file(path: String, new_name: String) -> Result<String, String> {
    if new_name.trim().is_empty() {
        return Err("New name cannot be empty".into());
    }
    let old = PathBuf::from(&path);
    let new_path = old
        .parent()
        .map(|p| p.join(new_name.trim()))
        .ok_or_else(|| "Invalid path".to_string())?;
    std::fs::rename(&old, &new_path).map_err(|e| format!("Failed to rename: {}", e))?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| format!("Failed to delete directory: {}", e))
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("Failed to delete file: {}", e))
    }
}

#[tauri::command]
pub fn create_file(parent: String, name: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Name cannot be empty".into());
    }
    let path = PathBuf::from(&parent).join(name);
    if path.exists() {
        return Err("A file or folder with that name already exists".into());
    }
    std::fs::write(&path, "").map_err(|e| format!("Failed to create file: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_folder(parent: String, name: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Name cannot be empty".into());
    }
    let path = PathBuf::from(&parent).join(name);
    if path.exists() {
        return Err("A file or folder with that name already exists".into());
    }
    std::fs::create_dir(&path).map_err(|e| format!("Failed to create folder: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

// =====================================================================
// Built-in code runner
// =====================================================================

/// One live piped run: the child, plus the two flags the output pump and the
/// exit watcher use to hand the tail over cleanly.
///
/// The flags live here rather than in the spawning thread's stack because the
/// run does not always end there. Pressing Stop tears the process down from an
/// IPC handler, and it has to be able to wait for the pump the same way the
/// watcher does — otherwise the log it reports would be missing whatever the
/// child wrote just before it died.
pub struct RunEntry {
    child: Child,
    /// Set once the child is known to be gone, by whichever thread notices
    /// first. The pump only flushes its tail after this.
    exited: Arc<AtomicBool>,
    /// Set by the pump once the tail has been handed over. The exit event waits
    /// for this so the last lines cannot land behind it and be dropped.
    pump_done: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct RunState(pub Mutex<HashMap<String, RunEntry>>);

// stdin is kept apart from the `Child` because the child handle is moved into
// `RunState` while the stdout/stderr reader threads run: whoever holds the
// write end drives the program, so it must outlive the spawn call and stay
// reachable from a Tauri command. Every write is flushed immediately —
// `input()` blocks on the line, so buffering it would deadlock the script.
#[derive(Default)]
pub struct StdinState(pub Mutex<HashMap<String, Arc<Mutex<ChildStdin>>>>);

fn write_line(stdin: &Arc<Mutex<ChildStdin>>, data: &str) -> Result<(), String> {
    let mut guard = stdin
        .lock()
        .map_err(|_| "Standard input is no longer available".to_string())?;
    // A bare "\n" is the Enter key on an empty line — do not append a second
    // newline, and do not swallow an intentional trailing one.
    let payload = if data.ends_with('\n') {
        data.to_string()
    } else {
        format!("{}\n", data)
    };
    guard
        .write_all(payload.as_bytes())
        .and_then(|_| guard.flush())
        .map_err(|e| format!("Failed to write to standard input: {}", e))
}

#[derive(Clone, Serialize)]
pub struct InterpreterInfo {
    pub language: String,
    pub command: String,
    pub args: Vec<String>,
    pub available: bool,
}

/// One line of program output, as carried inside a [`RunLines`] batch.
#[derive(Clone, Serialize)]
pub struct RunLine {
    pub stream: String,
    pub line: String,
}

/// Payload of the `run://output` event: every line the program printed since
/// the previous batch.
///
/// Batched instead of one event per line because every `emit` costs a
/// `webview.eval` that Tauri posts to the *main thread* (see
/// [`OUTPUT_FLUSH_MS`]) — the same thread that has to keep answering the
/// window's messages. One event per line means a program printing thousands of
/// lines a second fills that queue faster than it drains, and the window stops
/// responding: it cannot be dragged, menus do not open, and Windows marks it
/// as not responding.
#[derive(Clone, Serialize)]
pub struct RunLines {
    pub id: String,
    pub lines: Vec<RunLine>,
}

/// How long the output pump waits before flushing what it has buffered.
///
/// This is the cap on how much IPC a run can generate: at most one event per
/// interval, whatever the program's output rate. 60 ms is well below the
/// threshold where a human notices latency, and it cuts a chatty run from
/// thousands of main-thread messages per second to ~16.
const OUTPUT_FLUSH_MS: u64 = 60;

/// Ceiling on one batch, so a sudden burst cannot build a single huge event.
const OUTPUT_FLUSH_MAX_LINES: usize = 400;

#[derive(Clone, Serialize)]
pub struct RunExit {
    pub id: String,
    pub code: Option<i32>,
    /// The complete output of this run, on disk. `None` only when the log file
    /// could not be created. The panel is capped, this is not, so the path is
    /// how output survives a script that prints more than the panel can show.
    pub log: Option<RunLogInfo>,
}

const LANGUAGE_PRESETS: &[(&str, &[&str], &[&str])] = &[
    ("python", &["python", "python3"], &[]),
    ("php", &["php"], &[]),
    ("node", &["node"], &[]),
    ("ruby", &["ruby"], &[]),
    ("go", &["go"], &["run"]),
    ("bash", &["bash"], &[]),
    ("perl", &["perl"], &[]),
    ("lua", &["lua"], &[]),
];

// Resolve the first absolute path of a command found on PATH. Reads the PATH
// environment variable directly (proper Unicode on Windows, no console codepage
// issues) instead of spawning `where`/`which` and parsing their output.
fn find_command(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    let path_str = path.to_string_lossy();
    let sep = if cfg!(windows) { ';' } else { ':' };

    #[cfg(windows)]
    let extensions: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ";.COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .filter(|e| !e.is_empty())
        .map(|e| e.to_lowercase())
        .collect();

    for dir in path_str.split(sep) {
        if dir.is_empty() {
            continue;
        }
        let base = PathBuf::from(dir).join(name);
        if base.is_file() {
            return Some(base.to_string_lossy().to_string());
        }
        #[cfg(windows)]
        for ext in &extensions {
            let candidate = PathBuf::from(dir).join(format!("{}{}", name, ext));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

#[tauri::command]
pub fn detect_interpreters() -> Vec<InterpreterInfo> {
    LANGUAGE_PRESETS
        .iter()
        .map(|(language, candidates, args)| {
            let found = candidates.iter().find_map(|c| find_command(c));
            InterpreterInfo {
                language: language.to_string(),
                command: found.clone().unwrap_or_else(|| candidates[0].to_string()),
                args: args.iter().map(|s| s.to_string()).collect(),
                available: found.is_some(),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Interactive shells
// ---------------------------------------------------------------------------

/// One interactive shell the output panel can offer.
///
/// `command` is the resolved absolute path when the shell exists and the bare
/// name when it does not; the frontend keys on `available`, so the placeholder
/// is never spawned.
#[derive(Clone, Serialize)]
pub struct ShellInfo {
    /// Stable id used as the user's stored preference (`cmd`, `powershell`, …).
    pub id: String,
    pub command: String,
    pub args: Vec<String>,
    pub available: bool,
}

/// Shell candidates, most preferred first.
///
/// `pwsh` sits ahead of Windows PowerShell because the two are the same engine:
/// a machine with PowerShell 7 installed wants it, and one without falls
/// through to the copy that ships with Windows. `cmd.exe` is always present.
#[cfg(windows)]
const SHELL_PRESETS: &[(&str, &[&str])] = &[
    ("powershell", &["pwsh.exe", "powershell.exe"]),
    ("cmd", &["cmd.exe"]),
    ("bash", &["bash.exe"]),
];

#[cfg(not(windows))]
const SHELL_PRESETS: &[(&str, &[&str])] = &[
    ("bash", &["bash"]),
    ("zsh", &["zsh"]),
    ("sh", &["sh"]),
];

/// Which interactive shells this machine can actually start.
///
/// Same PATH lookup and same payload shape as [`detect_interpreters`], so the
/// frontend can grey out what is missing instead of offering a button whose
/// only outcome is a spawn error.
#[tauri::command]
pub fn detect_shells() -> Vec<ShellInfo> {
    SHELL_PRESETS
        .iter()
        .map(|(id, candidates)| {
            let found = candidates.iter().find_map(|c| find_command(c));
            ShellInfo {
                id: id.to_string(),
                command: found.clone().unwrap_or_else(|| candidates[0].to_string()),
                // Interactive: no `-c`, no script. The shell reads the PTY.
                args: Vec::new(),
                available: found.is_some(),
            }
        })
        .collect()
}

/// Drain one of the child's pipes, one line at a time, into `pending`.
///
/// Generic over the reader so stdout and stderr — different concrete types —
/// share the code. The thread ends at EOF, which is how the pump below learns
/// that no further lines can arrive.
///
/// Every line also goes to the run's log, and it goes there *before* it joins
/// the batch below. That order is the whole guarantee: the batch is bounded and
/// may be dropped or trimmed by the frontend, while the log is the record.
fn collect_output<R: std::io::Read + Send + 'static>(
    source: R,
    stream: &'static str,
    pending: Arc<Mutex<Vec<RunLine>>>,
    readers_left: Arc<AtomicUsize>,
    log: Option<Arc<RunLog>>,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(source).lines() {
            let Ok(line) = line else { break };
            if let Some(log) = &log {
                log.write_line(&line);
            }
            match pending.lock() {
                Ok(mut buffer) => buffer.push(RunLine {
                    stream: stream.into(),
                    line,
                }),
                Err(_) => break,
            }
        }
        readers_left.fetch_sub(1, Ordering::SeqCst);
    });
}

/// Hand everything buffered for `id` to the frontend as a single event.
///
/// Draining under the lock is what keeps batches in order: only the pump thread
/// calls this, and the lock decides which lines go into which batch.
fn flush_output(app: &AppHandle, id: &str, pending: &Arc<Mutex<Vec<RunLine>>>) {
    let lines = {
        let Ok(mut buffer) = pending.lock() else {
            return;
        };
        if buffer.is_empty() {
            return;
        }
        std::mem::take(&mut *buffer)
    };
    let _ = app.emit(
        "run://output",
        RunLines {
            id: id.to_string(),
            lines,
        },
    );
}

// Runs off the main thread on purpose: `#[tauri::command(async)]` puts the body
// on the async runtime rather than the thread driving the window, so the IPC
// that starts a run can never hold up a repaint or a window drag.
#[tauri::command(async)]
pub fn run_program(
    app: AppHandle,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let dir = cwd.as_deref().filter(|d| !d.is_empty());
    if let Some(dir) = dir {
        if !Path::new(dir).is_dir() {
            // Refuse loudly instead of spawning in the app's own directory: a
            // silent fallback would re-create the exact PermissionError (and
            // misplaced file) this cwd handling exists to prevent.
            return Err(format!(
                "Working directory is not available: {}. \
                 Open the folder again or pick another one in Settings.",
                dir
            ));
        }
    }

    let mut cmd = build_command(&command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Run inside the requested directory so scripts resolve relative paths the
    // same way they would under VSCode / PyCharm (and so `import` of sibling
    // modules works).
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start {}: {}", command, e))?;

    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // `process_exited` is raised by whoever sees the child go; `pump_done` comes
    // back once the tail has been flushed, which is what lets the exit event
    // report the status *after* the last line instead of racing it.
    let process_exited = Arc::new(AtomicBool::new(false));
    let pump_done = Arc::new(AtomicBool::new(false));

    {
        let state = app.state::<RunState>();
        let mut map = state.0.lock().unwrap();
        if map.contains_key(&id) {
            return Err("A process with this id is already running".into());
        }
        map.insert(
            id.clone(),
            RunEntry {
                child,
                exited: process_exited.clone(),
                pump_done: pump_done.clone(),
            },
        );
    }

    if let Some(stdin) = stdin {
        let state = app.state::<StdinState>();
        let mut map = state.0.lock().unwrap();
        map.insert(id.clone(), Arc::new(Mutex::new(stdin)));
    }

    // The complete output goes to a file as well as to the panel. The panel is
    // capped, so a script printing more lines than it can hold would otherwise
    // have its early output become unreadable for good; the log has no cap.
    // Registered by id so `stop_program` can hand the path back for a run it
    // has to kill.
    let log = app.state::<runlog::RunLogs>().start(&app, &id);

    // Output is funnelled through one buffer drained by one pump thread, so a
    // run costs at most one IPC event per OUTPUT_FLUSH_MS no matter how loudly
    // it prints. See RunLines for why that matters.
    let pending: Arc<Mutex<Vec<RunLine>>> = Arc::new(Mutex::new(Vec::new()));
    let readers_left = Arc::new(AtomicUsize::new(0));
    if let Some(out) = stdout {
        readers_left.fetch_add(1, Ordering::SeqCst);
        collect_output(out, "stdout", pending.clone(), readers_left.clone(), log.clone());
    }
    if let Some(err) = stderr {
        readers_left.fetch_add(1, Ordering::SeqCst);
        collect_output(err, "stderr", pending.clone(), readers_left.clone(), log.clone());
    }

    {
        let app2 = app.clone();
        let id2 = id.clone();
        let pending2 = pending.clone();
        let readers2 = readers_left.clone();
        let exited2 = process_exited.clone();
        let done2 = pump_done.clone();
        std::thread::spawn(move || {
            let interval = Duration::from_millis(OUTPUT_FLUSH_MS);
            let mut since_flush = Duration::ZERO;
            let mut give_up_at: Option<Instant> = None;
            loop {
                // Short hops rather than one long sleep: a burst that outgrows
                // a single batch should not have to wait for the next tick.
                std::thread::sleep(Duration::from_millis(10));
                since_flush += Duration::from_millis(10);
                let buffered = pending2.lock().map(|b| b.len()).unwrap_or(0);
                if buffered > 0
                    && (since_flush >= interval || buffered >= OUTPUT_FLUSH_MAX_LINES)
                {
                    flush_output(&app2, &id2, &pending2);
                    since_flush = Duration::ZERO;
                }
                if !exited2.load(Ordering::SeqCst) {
                    continue;
                }
                // The process is gone. Keep draining until both pipes have hit
                // EOF so the last lines cannot land behind the exit event and
                // get dropped by the frontend. A grandchild can hold a pipe
                // open indefinitely, hence the deadline.
                let all_readers_done = readers2.load(Ordering::SeqCst) == 0;
                let deadline = *give_up_at
                    .get_or_insert_with(|| Instant::now() + Duration::from_millis(600));
                if all_readers_done || Instant::now() >= deadline {
                    flush_output(&app2, &id2, &pending2);
                    done2.store(true, Ordering::SeqCst);
                    break;
                }
            }
        });
    }

    let app2 = app.clone();
    std::thread::spawn(move || loop {
        let state = app2.state::<RunState>();
        let mut map = state.0.lock().unwrap();
        match map.get_mut(&id) {
            Some(entry) => match entry.child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code();
                    map.remove(&id);
                    drop(map);
                    // Drop the write end too, otherwise the handle keeps the
                    // pipe alive for the rest of the session.
                    if let Ok(mut stdin_map) = app2.state::<StdinState>().0.lock() {
                        stdin_map.remove(&id);
                    }
                    process_exited.store(true, Ordering::SeqCst);
                    // Let the pump flush the tail first: output that arrives
                    // after the exit event is ignored by the frontend.
                    let deadline = Instant::now() + Duration::from_millis(1200);
                    while !pump_done.load(Ordering::SeqCst) && Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    // Flushed by the pump's wait above, so the file is complete
                    // by the time the panel offers to open it.
                    let log = runlog::finish(&app2, &id);
                    let _ = app2.emit(
                        "run://exit",
                        RunExit {
                            id: id.clone(),
                            code,
                            log,
                        },
                    );
                    break;
                }
                Ok(None) => {
                    drop(map);
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(_) => {
                    map.remove(&id);
                    drop(map);
                    if let Ok(mut stdin_map) = app2.state::<StdinState>().0.lock() {
                        stdin_map.remove(&id);
                    }
                    // Nothing left to report, but the pump still has to be told
                    // to stop or the thread outlives the run.
                    process_exited.store(true, Ordering::SeqCst);
                    break;
                }
            },
            // The entry is gone, so someone else ended this run — in practice
            // that is only `stop_program`, which reports the exit itself. Tell
            // the pump anyway: `exited` is the only thing that stops it, and a
            // pump left spinning would hold the pending buffer and the app
            // handle for the rest of the session.
            None => {
                process_exited.store(true, Ordering::SeqCst);
                break;
            }
        }
    });

    Ok(())
}

/// Kill a running program and report its exit.
///
/// Off the main thread on purpose: this waits for the output tail (see below),
/// and a window that cannot repaint while the user clicks Stop is the same
/// freeze [`run_program`] avoids with the same attribute.
#[tauri::command(async)]
pub fn stop_program(app: AppHandle, id: String) -> Result<(), String> {
    let entry = {
        let state = app.state::<RunState>();
        let mut map = state.0.lock().unwrap();
        map.remove(&id)
    };
    if let Some(mut entry) = entry {
        let _ = entry.child.kill();
        let _ = entry.child.wait();
        // The watcher is not the thread ending this run, so nothing else would
        // tell the pump to stop. Raising `exited` first, then waiting for the
        // tail, is what makes the log below complete: the readers are still
        // draining whatever the child wrote before it was killed.
        entry.exited.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_millis(600);
        while !entry.pump_done.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    if let Ok(mut stdin_map) = app.state::<StdinState>().0.lock() {
        stdin_map.remove(&id);
    }
    let log = runlog::finish(&app, &id);
    let _ = app.emit(
        "run://exit",
        RunExit {
            id: id.clone(),
            code: None,
            log,
        },
    );
    Ok(())
}

// Feed one line to a running program's standard input. This is what makes
// `input()` / `scanf` / `readline` usable: without a connected stdin the child
// inherits an invalid handle and dies with EOFError on its first read.
#[tauri::command]
pub fn write_stdin(app: AppHandle, id: String, data: String) -> Result<(), String> {
    let state = app.state::<StdinState>();
    let handle = {
        let map = state
            .0
            .lock()
            .map_err(|_| "Standard input is no longer available".to_string())?;
        map.get(&id).cloned()
    };
    match handle {
        Some(stdin) => write_line(&stdin, &data),
        None => Err("The program is not waiting for input".into()),
    }
}

// =====================================================================
// Cross-file search
// =====================================================================

#[derive(Clone, Serialize)]
pub struct SearchMatch {
    pub line: u32,
    pub text: String,
}

#[derive(Clone, Serialize)]
pub struct SearchFileResult {
    pub path: String,
    pub name: String,
    pub matches: Vec<SearchMatch>,
}

const SEARCH_MAX_FILES: usize = 100;
const SEARCH_MAX_MATCHES_PER_FILE: usize = 200;

fn search_file(path: &Path, query: &str, case_sensitive: bool) -> Option<SearchFileResult> {
    let bytes = fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None; // binary file
    }
    let (content, _) = decode_bytes(&bytes);
    let needle = if case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };
    let mut matches = Vec::new();
    for (i, raw) in content.lines().enumerate() {
        let line = raw.trim_end_matches('\r');
        let hay = if case_sensitive {
            line.to_string()
        } else {
            line.to_lowercase()
        };
        if hay.contains(&needle) {
            matches.push(SearchMatch {
                line: (i + 1) as u32,
                text: line.to_string(),
            });
            if matches.len() >= SEARCH_MAX_MATCHES_PER_FILE {
                break;
            }
        }
    }
    if matches.is_empty() {
        return None;
    }
    Some(SearchFileResult {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        matches,
    })
}

fn search_dir(
    dir: &Path,
    query: &str,
    case_sensitive: bool,
    results: &mut Vec<SearchFileResult>,
    depth: usize,
) {
    if depth > 32 || results.len() >= SEARCH_MAX_FILES {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if results.len() >= SEARCH_MAX_FILES {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target" | "dist") {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            search_dir(&path, query, case_sensitive, results, depth + 1);
        } else if ft.is_file() {
            if let Some(r) = search_file(&path, query, case_sensitive) {
                results.push(r);
            }
        }
    }
}

#[tauri::command]
pub async fn search_in_files(
    root: String,
    query: String,
    case_sensitive: bool,
) -> Vec<SearchFileResult> {
    if query.trim().is_empty() {
        return Vec::new();
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();
        search_dir(Path::new(&root), &query, case_sensitive, &mut results, 0);
        results
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gbk_round_trip() {
        // "你好" in GBK: 你 = C4 E3, 好 = BA C3
        let bytes = [0xC4u8, 0xE3, 0xBA, 0xC3];
        let (text, enc) = decode_bytes(&bytes);
        assert_eq!(text, "你好");
        assert_eq!(enc, "gbk");
        assert_eq!(encode_text(&text, &enc), bytes);
    }

    #[test]
    fn utf8_bom_round_trip() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("你好".as_bytes());
        let (text, enc) = decode_bytes(&bytes);
        assert_eq!(text, "你好");
        assert_eq!(enc, "utf-8-bom");
        assert_eq!(encode_text(&text, &enc), bytes);
    }

    #[test]
    fn utf16le_round_trip() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "你好".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let (text, enc) = decode_bytes(&bytes);
        assert_eq!(text, "你好");
        assert_eq!(enc, "utf-16le");
        assert_eq!(encode_text(&text, &enc), bytes);
    }

    #[test]
    fn utf16be_round_trip() {
        let mut bytes = vec![0xFE, 0xFF];
        for unit in "你好".encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        let (text, enc) = decode_bytes(&bytes);
        assert_eq!(text, "你好");
        assert_eq!(enc, "utf-16be");
        assert_eq!(encode_text(&text, &enc), bytes);
    }

    #[test]
    fn plain_utf8_is_detected() {
        let (text, enc) = decode_bytes("plain text".as_bytes());
        assert_eq!(text, "plain text");
        assert_eq!(enc, "utf-8");
    }

    #[test]
    fn cross_file_search_finds_matches_in_subdirs() {
        let dir = std::env::temp_dir().join(format!("search-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "hello world\nfoo\n").unwrap();
        std::fs::write(dir.join("sub").join("b.py"), "print('hello again')\n").unwrap();
        std::fs::write(dir.join("skip.bin"), "abc\x00def").unwrap(); // binary -> skipped

        let mut results = Vec::new();
        search_dir(&dir, "hello", false, &mut results, 0);

        assert_eq!(results.len(), 2, "binary file must be skipped");
        let a = results.iter().find(|r| r.name == "a.txt").unwrap();
        assert_eq!(a.matches.len(), 1);
        assert_eq!(a.matches[0].line, 1);
        assert_eq!(a.matches[0].text, "hello world");
        let b = results.iter().find(|r| r.name == "b.py").unwrap();
        assert_eq!(b.matches[0].line, 1);
        assert!(b.matches[0].text.contains("hello"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cross_file_search_respects_case_sensitivity() {
        let dir = std::env::temp_dir().join(format!("search-case-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x.txt"), "Hello\n").unwrap();

        let mut insensitive = Vec::new();
        search_dir(&dir, "hello", false, &mut insensitive, 0);
        assert_eq!(insensitive.len(), 1);

        let mut sensitive = Vec::new();
        search_dir(&dir, "hello", true, &mut sensitive, 0);
        assert!(sensitive.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
