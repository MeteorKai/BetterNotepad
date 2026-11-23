use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
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
    pub fingerprint: String,
    pub stamp: Option<String>,
}

const FILE_CHANGED_EXTERNALLY: &str = "FILE_CHANGED_EXTERNALLY";
const FILE_BUSY: &str = "FILE_BUSY";
const MAX_EDITOR_FILE_BYTES: u64 = 64 * 1024 * 1024;
static SAVE_COMMIT_LOCK: Mutex<()> = Mutex::new(());
const FNV64_OFFSET: u64 = 0xcbf29ce484222325;
const FNV64_PRIME: u64 = 0x100000001b3;

fn fingerprint_update(mut hash: u64, bytes: &[u8]) -> u64 {
    for &byte in bytes {
        hash = (hash ^ u64::from(byte)).wrapping_mul(FNV64_PRIME);
    }
    hash
}

fn fingerprint_bytes(bytes: &[u8]) -> String {
    format!(
        "{:016x}-{}",
        fingerprint_update(FNV64_OFFSET, bytes),
        bytes.len()
    )
}

async fn file_io<T: Send + 'static>(task: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task).await.map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn file_fingerprint(path: String) -> Result<Option<String>, String> {
    file_io(move || fingerprint_path(Path::new(&path))).await
}

fn file_stamp(metadata: &fs::Metadata) -> Option<String> {
    let modified = metadata.modified().ok()?;
    let created = metadata.created().ok();
    Some(format!("{}:{modified:?}:{created:?}", metadata.len()))
}

#[derive(Serialize)]
pub struct FileRevision {
    fingerprint: Option<String>,
    stamp: Option<String>,
    unchanged: bool,
}

fn check_revision(path: &Path, known_stamp: Option<&str>) -> Result<FileRevision, String> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileRevision { fingerprint: None, stamp: None, unchanged: false });
        }
        Err(err) => return Err(err.to_string()),
    };
    let before = file.metadata().ok().as_ref().and_then(file_stamp);
    if known_stamp.is_some() && before.as_deref() == known_stamp {
        return Ok(FileRevision { fingerprint: None, stamp: before, unchanged: true });
    }
    let fingerprint = fingerprint_reader(&mut file)?;
    let after = file.metadata().ok().as_ref().and_then(file_stamp);
    if before != after {
        return Err(FILE_CHANGED_EXTERNALLY.into());
    }
    Ok(FileRevision { fingerprint: Some(fingerprint), stamp: after, unchanged: false })
}

#[tauri::command]
pub async fn check_file_revision(path: String, known_stamp: Option<String>) -> Result<FileRevision, String> {
    file_io(move || check_revision(Path::new(&path), known_stamp.as_deref())).await
}

fn fingerprint_path(path: &Path) -> Result<Option<String>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Failed to fingerprint file: {}", err)),
    };
    let before = file.metadata().ok().as_ref().and_then(file_stamp);
    let fingerprint = fingerprint_reader(&file)?;
    let after = file.metadata().ok().as_ref().and_then(file_stamp);
    if before != after {
        return Err(FILE_CHANGED_EXTERNALLY.into());
    }
    Ok(Some(fingerprint))
}

fn fingerprint_reader(mut reader: impl Read) -> Result<String, String> {
    let mut buf = [0u8; 64 * 1024];
    let (mut hash, mut len) = (FNV64_OFFSET, 0u64);
    loop {
        let count = reader
            .read(&mut buf)
            .map_err(|e| format!("Failed to fingerprint file: {}", e))?;
        if count == 0 {
            break;
        }
        hash = fingerprint_update(hash, &buf[..count]);
        len += count as u64;
    }
    Ok(format!("{:016x}-{}", hash, len))
}

// Decode a file's raw bytes to UTF-8 and report the detected encoding. BOM is
// honored first, then strict UTF-8 validation, then a GBK fallback — GBK covers
// GB2312 and is the overwhelmingly common non-UTF-8 encoding on Chinese Windows.
fn decode_bytes(bytes: &[u8]) -> Result<(String, String), String> {
    let (codec, name, data) = if let Some(data) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        (encoding_rs::UTF_8, "utf-8-bom", data)
    } else if let Some(data) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        (encoding_rs::UTF_16LE, "utf-16le", data)
    } else if let Some(data) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        (encoding_rs::UTF_16BE, "utf-16be", data)
    } else if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok((text.to_owned(), "utf-8".into()));
    } else {
        (encoding_rs::GBK, "gbk", bytes)
    };
    codec.decode_without_bom_handling_and_without_replacement(data)
        .map(|text| (text.into_owned(), name.into()))
        .ok_or_else(|| format!("INVALID_TEXT_ENCODING: {name}"))
}

// Encode UTF-8 text back into the chosen on-disk encoding (prepending a BOM
// where the encoding calls for one).
fn encode_text(text: &str, encoding: &str) -> Result<Vec<u8>, String> {
    let bytes = match encoding {
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
        "gbk" => {
            let (bytes, _, had_errors) = encoding_rs::GBK.encode(text);
            if had_errors {
                return Err("UNREPRESENTABLE_TEXT: GBK".into());
            }
            bytes.into_owned()
        }
        "utf-8" => text.as_bytes().to_vec(),
        _ => return Err(format!("Unsupported encoding: {encoding}")),
    };
    Ok(bytes)
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<FileContent, String> {
    file_io(move || read_file_impl(path)).await
}

fn read_file_impl(path: String) -> Result<FileContent, String> {
    let mut file = fs::File::open(&path).map_err(|e| format!("Failed to read file: {e}"))?;
    let metadata = file.metadata().map_err(|e| format!("Failed to read file metadata: {e}"))?;
    if !metadata.is_file() {
        return Err("The path is not a regular file".into());
    }
    if metadata.len() > MAX_EDITOR_FILE_BYTES {
        return Err("FILE_TOO_LARGE".into());
    }
    let before = file_stamp(&metadata);
    let mut bytes = Vec::new();
    (&mut file).take(MAX_EDITOR_FILE_BYTES + 1).read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read file: {e}"))?;
    if bytes.len() as u64 > MAX_EDITOR_FILE_BYTES {
        return Err("FILE_TOO_LARGE".into());
    }
    let after = file.metadata().ok().as_ref().and_then(file_stamp);
    if before != after {
        return Err(FILE_CHANGED_EXTERNALLY.into());
    }
    let (content, encoding) = decode_bytes(&bytes)?;
    if content.contains('\0') {
        return Err("BINARY_FILE".into());
    }
    Ok(FileContent {
        content,
        encoding,
        fingerprint: fingerprint_bytes(&bytes),
        stamp: after,
    })
}

#[tauri::command]
pub async fn write_file(
    path: String,
    content: String,
    encoding: Option<String>,
    expected_fingerprint: Option<String>,
    expect_missing: Option<bool>,
) -> Result<String, String> {
    file_io(move || write_file_impl(path, content, encoding, expected_fingerprint, expect_missing)).await
}

fn write_file_impl(
    path: String,
    content: String,
    encoding: Option<String>,
    expected_fingerprint: Option<String>,
    expect_missing: Option<bool>,
) -> Result<String, String> {
    if content.contains('\0') {
        return Err("BINARY_FILE".into());
    }
    let bytes = encode_text(&content, encoding.as_deref().unwrap_or("utf-8"))?;
    let fingerprint = fingerprint_bytes(&bytes);
    let requested = Path::new(&path);
    let (target, permissions) = match fs::symlink_metadata(requested) {
        Ok(_) if expect_missing == Some(true) => return Err(FILE_CHANGED_EXTERNALLY.into()),
        Ok(_) => {
            // Preserve a symlink by replacing its resolved target.
            let target = requested.canonicalize().map_err(|e| e.to_string())?;
            let metadata = fs::metadata(&target).map_err(|e| e.to_string())?;
            if !metadata.is_file() || metadata.permissions().readonly() {
                return Err("The destination is not a writable file".into());
            }
            (target, Some(metadata.permissions()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (requested.to_path_buf(), None),
        Err(e) => return Err(e.to_string()),
    };
    let parent = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    // Normal file attributes matter on Windows: the staged file becomes the
    // user's document after rename, and must not retain FILE_ATTRIBUTE_TEMPORARY.
    let mut staged = tempfile::Builder::new().prefix(".betternotepad-")
        .make_in(parent, |path| {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(path)
        })
        .map_err(|e| format!("Failed to stage save: {e}"))?;
    staged.write_all(&bytes).map_err(|e| format!("Failed to stage save: {e}"))?;
    let destination_existed = permissions.is_some();
    if let Some(permissions) = permissions {
        staged.as_file().set_permissions(permissions).map_err(|e| e.to_string())?;
    }
    staged.as_file().sync_all().map_err(|e| format!("Failed to flush save: {e}"))?;
    // Serialise commits within this app, including saves through path aliases.
    // On Windows the guard also excludes external in-place writers while the
    // old contents are verified and replaced. Other processes can still
    // rename the path because replacement requires delete sharing.
    let _commit = SAVE_COMMIT_LOCK.lock().map_err(|err| err.to_string())?;
    let _verified = if destination_existed || expected_fingerprint.is_some() {
        Some(verify_save_target(requested, &target, expected_fingerprint.as_deref())?)
    } else {
        None
    };
    if !destination_existed {
        staged.persist_noclobber(&target).map_err(|e| {
            if e.error.kind() == std::io::ErrorKind::AlreadyExists {
                FILE_CHANGED_EXTERNALLY.into()
            } else {
                format!("Failed to save file: {}", e.error)
            }
        })?;
    } else {
        // Rust's Windows rename supports replacing open files that share
        // deletion on modern Windows. MoveFileEx alone rejects that case.
        fs::rename(staged.path(), &target).map_err(|err| {
            #[cfg(windows)]
            if matches!(err.raw_os_error(), Some(5 | 32 | 33)) {
                return FILE_BUSY.to_owned();
            }
            format!("Failed to replace file: {err}")
        })?;
        staged.disable_cleanup(true);
    }
    Ok(fingerprint)
}

fn verify_save_target(requested: &Path, target: &Path, expected: Option<&str>) -> Result<same_file::Handle, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const SHARE_READ_AND_DELETE: u32 = 0x1 | 0x4;
        options.share_mode(SHARE_READ_AND_DELETE);
    }
    let file = options.open(requested).map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            return FILE_CHANGED_EXTERNALLY.to_owned();
        }
        #[cfg(windows)]
        if matches!(err.raw_os_error(), Some(32 | 33)) {
            return FILE_BUSY.to_owned();
        }
        err.to_string()
    })?;
    if let Some(expected) = expected {
        let before = file.metadata().ok().as_ref().and_then(file_stamp);
        let fingerprint = fingerprint_reader(&file)?;
        let after = file.metadata().ok().as_ref().and_then(file_stamp);
        if before != after || fingerprint != expected {
            return Err(FILE_CHANGED_EXTERNALLY.into());
        }
    }
    if requested.canonicalize().ok().as_deref() != Some(target) {
        return Err(FILE_CHANGED_EXTERNALLY.into());
    }
    // The path may now refer to a different file with the same spelling.
    // Reopen it and confirm its identity immediately before replacement.
    let verified = same_file::Handle::from_file(file).map_err(|err| err.to_string())?;
    let current = options.open(target).map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            FILE_CHANGED_EXTERNALLY.to_owned()
        } else {
            err.to_string()
        }
    })?;
    if same_file::Handle::from_file(current).map_err(|err| err.to_string())? != verified {
        return Err(FILE_CHANGED_EXTERNALLY.into());
    }
    Ok(verified)
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
        let arg = raw.as_str();
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
    let name = file_name_component(&new_name)?;
    let old = PathBuf::from(&path);
    let new_path = old
        .parent()
        .map(|p| p.join(name))
        .ok_or_else(|| "Invalid path".to_string())?;
    std::fs::rename(&old, &new_path).map_err(|e| format!("Failed to rename: {}", e))?;
    Ok(new_path.to_string_lossy().to_string())
}

/// Move a file or folder to the OS trash (the Recycle Bin on Windows) instead
/// of removing it for good: a delete confirmed with one click in the file tree
/// must stay reversible. `trash::delete` handles files and directories with a
/// single call.
///
/// Off the main thread for the same reason as [`run_program`]: on Windows the
/// move is an `IFileOperation` that can run long (and show a progress dialog)
/// for a large folder across volumes, and the window must keep repainting
/// meanwhile.
///
/// When the trash is unavailable — a network share without a recycle bin, say —
/// this fails loudly rather than falling back to a permanent delete. The file
/// stays on disk and the frontend keeps its tabs open; a silent fallback here
/// would be exactly the data loss the trash exists to prevent.
#[tauri::command(async)]
pub fn delete_file(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    trash::delete(&target)
        .map_err(|e| format!("Failed to move to the Recycle Bin: {}", e))
}

fn file_name_component(value: &str) -> Result<&str, String> {
    let name = value.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) ||
        (cfg!(windows) && (name.ends_with('.') || name.contains([':', '*', '?', '"', '<', '>', '|']))) {
        return Err("Enter a single valid file or folder name".into());
    }
    Ok(name)
}

#[tauri::command(async)]
pub fn create_file(parent: String, name: String) -> Result<String, String> {
    let path = Path::new(&parent).join(file_name_component(&name)?);
    fs::OpenOptions::new().write(true).create_new(true).open(&path)
        .map_err(|e| format!("Failed to create file: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command(async)]
pub fn create_folder(parent: String, name: String) -> Result<String, String> {
    let path = Path::new(&parent).join(file_name_component(&name)?);
    fs::create_dir(&path).map_err(|e| format!("Failed to create folder: {e}"))?;
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
    #[cfg(windows)]
    _job: Option<crate::pty::JobHandle>,
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

/// Bound the transient display queue independently of the retained log.
const OUTPUT_FLUSH_MAX_LINES: usize = 400;
const OUTPUT_MAX_LINE_BYTES: u64 = 8 * 1024;

#[derive(Clone, Serialize)]
pub struct RunExit {
    pub id: String,
    pub code: Option<i32>,
    /// Retained output of this run, on disk when a log could be created.
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

fn piped_output_encoding(label: Option<&str>) -> &'static encoding_rs::Encoding {
    match label {
        Some("gb18030") => encoding_rs::GB18030,
        Some("shift_jis") => encoding_rs::SHIFT_JIS,
        Some("windows-1252") => encoding_rs::WINDOWS_1252,
        _ => encoding_rs::UTF_8,
    }
}

fn read_output_line(
    source: &mut impl BufRead,
    decoder: &mut Option<encoding_rs::Decoder>,
    bytes: &mut Vec<u8>,
) -> std::io::Result<Option<String>> {
    let Some(active_decoder) = decoder.as_mut() else {
        return Ok(None);
    };
    loop {
        bytes.clear();
        // All selectable encodings are ASCII-compatible: LF cannot occur
        // within a valid multibyte character. Decode before stripping CRLF.
        let count = source.take(OUTPUT_MAX_LINE_BYTES).read_until(b'\n', bytes)?;
        let last = count == 0;
        let mut decoded = String::with_capacity(
            active_decoder.max_utf8_buffer_length(count).expect("bounded pipe chunk"),
        );
        let (result, consumed, _) = active_decoder.decode_to_string(bytes, &mut decoded, last);
        debug_assert_eq!(result, encoding_rs::CoderResult::InputEmpty);
        debug_assert_eq!(consumed, count);
        if last {
            // EOF may emit a replacement character for an incomplete sequence.
            // Return it once without calling the finished decoder again.
            *decoder = None;
            return Ok((!decoded.is_empty()).then_some(decoded));
        }
        if let Some(line) = decoded.strip_suffix('\n') {
            let length = line.strip_suffix('\r').unwrap_or(line).len();
            decoded.truncate(length);
            return Ok(Some(decoded));
        }
        if !decoded.is_empty() {
            return Ok(Some(decoded));
        }
    }
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
    pending: Arc<Mutex<VecDeque<RunLine>>>,
    readers_left: Arc<AtomicUsize>,
    log: Option<Arc<RunLog>>,
    encoding: &'static encoding_rs::Encoding,
) {
    std::thread::spawn(move || {
        let mut source = BufReader::new(source);
        let mut bytes = Vec::new();
        let mut decoder = Some(encoding.new_decoder_with_bom_removal());
        while let Ok(Some(line)) = read_output_line(&mut source, &mut decoder, &mut bytes) {
            if let Some(log) = &log {
                log.write_line(&line);
            }
            match pending.lock() {
                Ok(mut buffer) => {
                    if buffer.len() == OUTPUT_FLUSH_MAX_LINES {
                        buffer.pop_front();
                    }
                    buffer.push_back(RunLine { stream: stream.into(), line });
                }
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
fn flush_output(app: &AppHandle, id: &str, pending: &Arc<Mutex<VecDeque<RunLine>>>) {
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
            lines: lines.into(),
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
    record_output: Option<bool>,
    output_encoding: Option<String>,
) -> Result<(), String> {
    let encoding = piped_output_encoding(output_encoding.as_deref());
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

    #[cfg(windows)]
    let job = crate::pty::JobHandle::for_process(child.id());
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
            let _ = child.kill();
            let _ = child.wait();
            return Err("A process with this id is already running".into());
        }
        map.insert(
            id.clone(),
            RunEntry {
                child,
                #[cfg(windows)]
                _job: job,
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

    // Keep a separate, size-limited log so the display queue can drop old output.
    let log = app.state::<runlog::RunLogs>().start(&app, &id, record_output == Some(true));

    // Output is funnelled through one buffer drained by one pump thread, so a
    // run costs at most one IPC event per OUTPUT_FLUSH_MS no matter how loudly
    // it prints. See RunLines for why that matters.
    let pending: Arc<Mutex<VecDeque<RunLine>>> = Arc::new(Mutex::new(VecDeque::new()));
    let readers_left = Arc::new(AtomicUsize::new(0));
    if let Some(out) = stdout {
        readers_left.fetch_add(1, Ordering::SeqCst);
        collect_output(out, "stdout", pending.clone(), readers_left.clone(), log.clone(), encoding);
    }
    if let Some(err) = stderr {
        readers_left.fetch_add(1, Ordering::SeqCst);
        collect_output(err, "stderr", pending.clone(), readers_left.clone(), log.clone(), encoding);
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
        #[cfg(windows)]
        drop(entry._job.take());
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

pub fn stop_all_programs(app: &AppHandle) {
    let state = app.state::<RunState>();
    let entries = std::mem::take(&mut *state.0.lock().unwrap());
    app.state::<StdinState>().0.lock().unwrap().clear();
    let mut pending = Vec::with_capacity(entries.len());
    for (id, mut entry) in entries {
        #[cfg(windows)]
        drop(entry._job.take());
        let _ = entry.child.kill();
        let _ = entry.child.wait();
        entry.exited.store(true, Ordering::SeqCst);
        pending.push((id, entry.pump_done));
    }
    let deadline = Instant::now() + Duration::from_millis(600);
    for (id, done) in pending {
        while !done.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        runlog::finish(app, &id);
    }
}

// Feed one line to a running program's standard input. This is what makes
// `input()` / `scanf` / `readline` usable: without a connected stdin the child
// inherits an invalid handle and dies with EOFError on its first read.
#[tauri::command]
pub async fn write_stdin(app: AppHandle, id: String, data: String) -> Result<(), String> {
    let state = app.state::<StdinState>();
    let handle = {
        let map = state
            .0
            .lock()
            .map_err(|_| "Standard input is no longer available".to_string())?;
        map.get(&id).cloned()
    };
    match handle {
        Some(stdin) => file_io(move || write_line(&stdin, &data)).await,
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
    pub truncated: bool,
}

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub files: Vec<SearchFileResult>,
    pub files_truncated: bool,
    pub files_incomplete: usize,
}

const SEARCH_MAX_FILES: usize = 100;
const SEARCH_MAX_MATCHES_PER_FILE: usize = 200;

const SEARCH_MAX_QUERY_BYTES: usize = 4096;
const SEARCH_PREVIEW_RADIUS: usize = 80;
// Case folding can match characters of different UTF-8 widths.
const SEARCH_OVERLAP: usize = 4 * (SEARCH_MAX_QUERY_BYTES + 2 * SEARCH_PREVIEW_RADIUS);
const SEARCH_WINDOW: usize = 2 * SEARCH_OVERLAP;

fn search_pattern(query: &str, case_sensitive: bool) -> Result<regex::Regex, String> {
    if query.len() > SEARCH_MAX_QUERY_BYTES {
        return Err("SEARCH_QUERY_TOO_LONG".into());
    }
    regex::RegexBuilder::new(&regex::escape(query))
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|err| err.to_string())
}

fn search_preview(line: &str, hit: regex::Match<'_>, clipped: bool, complete: bool) -> String {
    let start = line[..hit.start()].char_indices().rev().nth(SEARCH_PREVIEW_RADIUS - 1)
        .map_or(0, |(i, _)| i);
    let end = line[hit.end()..].char_indices().nth(SEARCH_PREVIEW_RADIUS)
        .map_or(line.len(), |(i, _)| hit.end() + i);
    format!("{}{}{}", if clipped || start > 0 { "…" } else { "" }, &line[start..end],
        if !complete || end < line.len() { "…" } else { "" })
}

#[derive(Default)]
struct FileMatches {
    matches: Vec<SearchMatch>,
    truncated: bool,
}

enum ScanError {
    Cancelled,
    InvalidEncoding,
    Binary,
    Read,
}

fn scan_text(
    input: &mut impl Read,
    codec: &'static encoding_rs::Encoding,
    pattern: &regex::Regex,
    cancelled: &impl Fn() -> bool,
) -> Result<FileMatches, ScanError> {
    use encoding_rs::DecoderResult;
    let mut decoder = codec.new_decoder_without_bom_handling();
    let mut source = [0; 8192];
    let mut output = [0; 8192];
    let mut line = String::new();
    let mut line_number = 1u32;
    let mut clipped = false;
    let mut matched = false;
    let mut found = FileMatches::default();

    loop {
        if cancelled() {
            return Err(ScanError::Cancelled);
        }
        let count = input.read(&mut source).map_err(|_| ScanError::Read)?;
        let last = count == 0;
        let mut remaining = &source[..count];
        loop {
            let (result, consumed, written) = decoder.decode_to_utf8_without_replacement(remaining, &mut output, last);
            let chunk = std::str::from_utf8(&output[..written]).map_err(|_| ScanError::InvalidEncoding)?;
            if chunk.contains('\0') {
                return Err(ScanError::Binary);
            }
            if matches!(result, DecoderResult::Malformed(..)) {
                return Err(ScanError::InvalidEncoding);
            }
            for part in chunk.split_inclusive('\n') {
                let (text, complete) = part.strip_suffix('\n').map_or((part, false), |text| (text, true));
                if !matched && !found.truncated {
                    line.push_str(text);
                    if complete || line.len() >= SEARCH_WINDOW {
                        matched = record_line_match(&mut found, pattern, &line, line_number, clipped, complete);
                        if !complete && !matched {
                            // Keep full matches that cross the boundary, with
                            // enough context on both sides for their preview.
                            let mut start = line.len() - SEARCH_OVERLAP;
                            while !line.is_char_boundary(start) {
                                start -= 1;
                            }
                            line.drain(..start);
                            clipped = true;
                        }
                    }
                }
                if complete {
                    line.clear();
                    line_number = line_number.saturating_add(1);
                    clipped = false;
                    matched = false;
                }
            }
            remaining = &remaining[consumed..];
            if result == DecoderResult::InputEmpty {
                break;
            }
        }
        if last {
            if !matched && !found.truncated && !line.is_empty() {
                record_line_match(&mut found, pattern, &line, line_number, clipped, true);
            }
            return Ok(found);
        }
    }
}

fn record_line_match(
    result: &mut FileMatches,
    pattern: &regex::Regex,
    line: &str,
    number: u32,
    clipped: bool,
    complete: bool,
) -> bool {
    let text = if complete { line.trim_end_matches('\r') } else { line };
    let Some(hit) = pattern.find(text) else { return false };
    // Wait if there is still too little text after the match, or if it
    // could end in a CRLF delimiter split across decoder chunks.
    if !complete && text.len() - hit.end() < 4 * SEARCH_PREVIEW_RADIUS {
        return false;
    }
    if result.matches.len() >= SEARCH_MAX_MATCHES_PER_FILE {
        result.truncated = true;
    } else {
        result.matches.push(SearchMatch { line: number, text: search_preview(text, hit, clipped, complete) });
    }
    true
}

fn scan_file(path: &Path, pattern: &regex::Regex, cancelled: &impl Fn() -> bool) -> (Option<SearchFileResult>, bool) {
    use std::io::{Seek, SeekFrom};
    let scan = || -> Result<FileMatches, ScanError> {
        if cancelled() {
            return Err(ScanError::Cancelled);
        }
        let mut input = BufReader::new(fs::File::open(path).map_err(|_| ScanError::Read)?);
        let (codec, bom_len) = match input.fill_buf().map_err(|_| ScanError::Read)? {
            bytes if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) => (encoding_rs::UTF_8, 3),
            bytes if bytes.starts_with(&[0xFF, 0xFE]) => (encoding_rs::UTF_16LE, 2),
            bytes if bytes.starts_with(&[0xFE, 0xFF]) => (encoding_rs::UTF_16BE, 2),
            _ => (encoding_rs::UTF_8, 0),
        };
        input.consume(bom_len);
        match scan_text(&mut input, codec, pattern, cancelled) {
            Err(ScanError::InvalidEncoding) if bom_len == 0 => {
                input.seek(SeekFrom::Start(0)).map_err(|_| ScanError::Read)?;
                scan_text(&mut input, encoding_rs::GBK, pattern, cancelled)
            }
            result => result,
        }
    };
    let scan = match scan() {
        Ok(scan) => scan,
        Err(ScanError::Read | ScanError::InvalidEncoding) => return (None, true),
        Err(ScanError::Cancelled | ScanError::Binary) => return (None, false),
    };
    let result = (!scan.matches.is_empty()).then(|| SearchFileResult {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        matches: scan.matches,
        truncated: scan.truncated,
    });
    (result, false)
}

#[cfg(test)]
fn search_file(path: &Path, query: &str, case_sensitive: bool) -> Option<SearchFileResult> {
    scan_file(path, &search_pattern(query, case_sensitive).unwrap(), &|| false).0
}

fn search_dir(
    dir: &Path,
    pattern: &regex::Regex,
    results: &mut SearchResults,
    depth: usize,
    cancelled: &impl Fn() -> bool,
) {
    if results.files_truncated || cancelled() {
        return;
    }
    if depth > 32 {
        results.files_incomplete += 1;
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => {
            results.files_incomplete += 1;
            return;
        }
    };
    for entry in entries {
        if results.files_truncated || cancelled() {
            return;
        }
        let Ok(entry) = entry else {
            results.files_incomplete += 1;
            continue;
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(ft) = entry.file_type() else {
            results.files_incomplete += 1;
            continue;
        };
        if ft.is_dir() {
            if matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist") {
                continue;
            }
            search_dir(&path, pattern, results, depth + 1, cancelled);
        } else if ft.is_file() {
            let (result, incomplete) = scan_file(&path, pattern, cancelled);
            results.files_incomplete += usize::from(incomplete);
            if let Some(r) = result {
                if results.files.len() == SEARCH_MAX_FILES {
                    results.files_truncated = true;
                    return;
                }
                results.files.push(r);
            }
        }
    }
}

// This search panel belongs to the single main window.
static SEARCH_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[tauri::command]
pub fn cancel_file_search(generation: u64) {
    SEARCH_GENERATION.fetch_max(generation, Ordering::Relaxed);
}

#[tauri::command]
pub async fn search_in_files(root: String, query: String, case_sensitive: bool, generation: u64) -> Result<SearchResults, String> {
    if SEARCH_GENERATION.fetch_max(generation, Ordering::Relaxed) > generation || query.trim().is_empty() {
        return Ok(SearchResults::default());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let pattern = search_pattern(&query, case_sensitive)?;
        let mut results = SearchResults::default();
        search_dir(Path::new(&root), &pattern, &mut results, 0, &|| {
            SEARCH_GENERATION.load(Ordering::Relaxed) != generation
        });
        Ok(results)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn piped_output_decodes_legacy_text_and_keeps_multibyte_characters_across_chunks() {
        for (label, text) in [("utf-8", "中文"), ("gb18030", "中文"), ("shift_jis", "日本語"), ("windows-1252", "café")] {
            let encoding = piped_output_encoding(Some(label));
            let (payload, _, errors) = encoding.encode(text);
            assert!(!errors);
            let mut bytes = vec![b'x'; OUTPUT_MAX_LINE_BYTES as usize - 1];
            bytes.extend_from_slice(&payload);
            bytes.extend_from_slice(b"\r\n\nend");
            let mut input = std::io::Cursor::new(bytes);
            let mut decoder = Some(encoding.new_decoder_with_bom_removal());
            let mut scratch = Vec::new();
            let first = read_output_line(&mut input, &mut decoder, &mut scratch).unwrap().unwrap();
            let second = read_output_line(&mut input, &mut decoder, &mut scratch).unwrap().unwrap();
            assert_eq!(format!("{first}{second}"), format!("{}{text}", "x".repeat(OUTPUT_MAX_LINE_BYTES as usize - 1)));
            assert_eq!(read_output_line(&mut input, &mut decoder, &mut scratch).unwrap().as_deref(), Some(""));
            assert_eq!(read_output_line(&mut input, &mut decoder, &mut scratch).unwrap().as_deref(), Some("end"));
            assert!(read_output_line(&mut input, &mut decoder, &mut scratch).unwrap().is_none());
        }
    }

    #[test]
    fn piped_output_flushes_a_partial_character_once_at_eof() {
        for (encoding, input) in [
            (encoding_rs::UTF_8, &[0xE4, 0xB8][..]),
            (encoding_rs::GB18030, &[0xD6][..]),
        ] {
            let mut source = std::io::Cursor::new(input);
            let mut decoder = Some(encoding.new_decoder_with_bom_removal());
            let mut scratch = Vec::new();
            assert_eq!(read_output_line(&mut source, &mut decoder, &mut scratch).unwrap().as_deref(), Some("�"));
            assert!(read_output_line(&mut source, &mut decoder, &mut scratch).unwrap().is_none());
        }
    }

    struct SearchFixture(PathBuf);

    impl SearchFixture {
        fn new(name: &str) -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "betternotepad-search-{}-{}-{}",
                name,
                std::process::id(),
                stamp
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for SearchFixture {
        fn drop(&mut self) {
            let temp = std::env::temp_dir();
            assert_eq!(self.0.parent(), Some(temp.as_path()));
            assert!(self
                .0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("betternotepad-search-"));
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn cross_file_search_decodes_utf16_before_binary_detection() {
        let dir = SearchFixture::new("encodings");
        for encoding in ["utf-8", "utf-8-bom", "gbk", "utf-16le", "utf-16be"] {
            let path = dir.0.join(format!("{}.txt", encoding));
            fs::write(&path, encode_text("first\r\n你好 hello\r\n", encoding).unwrap()).unwrap();
            let result = search_file(&path, "你好", true).expect(encoding);
            assert_eq!(result.matches[0].line, 2);
            assert_eq!(result.matches[0].text, "你好 hello");
        }
        let binary = dir.0.join("binary.dat");
        fs::write(&binary, b"hello\0world").unwrap();
        assert!(search_file(&binary, "hello", false).is_none());
        fs::write(&binary, encode_text("hello\0world", "utf-16le").unwrap()).unwrap();
        assert!(search_file(&binary, "hello", false).is_none());
    }

    #[test]
    fn streamed_search_matches_long_lines_with_correct_line_numbers() {
        let dir = SearchFixture::new("long-lines");
        let path = dir.0.join("large.txt");
        let content = format!("{}目标{}\r\n{}目标{}\r\nlast 目标", "x".repeat(256 * 1024 - 3), "尾".repeat(1000), "前".repeat(1000), "后".repeat(1000));
        for encoding in ["utf-8", "utf-8-bom", "utf-16le", "utf-16be", "gbk"] {
            fs::write(&path, encode_text(&content, encoding).unwrap()).unwrap();
            let (result, incomplete) = scan_file(&path, &search_pattern("目标", true).unwrap(), &|| false);
            assert!(!incomplete, "{encoding}");
            let matches = result.unwrap().matches;
            assert_eq!(matches.iter().map(|hit| hit.line).collect::<Vec<_>>(), [1, 2, 3]);
            assert!(matches[0].text.contains("目标"));
            assert!(matches[0].text.starts_with('…') && matches[0].text.ends_with('…'));
        }
    }

    #[test]
    fn streamed_search_cancels_during_a_file() {
        let mut source = std::io::Cursor::new(vec![b'x'; 32_768]);
        let checks = std::cell::Cell::new(0);
        let result = scan_text(&mut source, encoding_rs::UTF_8, &search_pattern("x", true).unwrap(), &|| {
            checks.set(checks.get() + 1);
            checks.get() > 1
        });
        assert!(matches!(result, Err(ScanError::Cancelled)));
        assert_eq!(source.position(), 8192);
    }

    #[test]
    fn cross_file_search_includes_dotfiles_and_dotfolders() {
        let dir = SearchFixture::new("dotfiles");
        fs::create_dir(dir.0.join(".config")).unwrap();
        fs::create_dir(dir.0.join(".git")).unwrap();
        fs::write(dir.0.join(".env"), "hello").unwrap();
        fs::write(dir.0.join(".gitignore"), "hello").unwrap();
        fs::write(dir.0.join(".config").join("settings.txt"), "hello").unwrap();
        fs::write(dir.0.join(".git").join("ignored.txt"), "hello").unwrap();
        let mut results = SearchResults::default();
        search_dir(&dir.0, &search_pattern("hello", true).unwrap(), &mut results, 0, &|| false);
        assert_eq!(results.files.len(), 3);
    }

    #[test]
    fn cross_file_search_reports_only_actual_line_truncation() {
        let dir = SearchFixture::new("line-limit");
        let path = dir.0.join("lines.txt");
        fs::write(&path, "hello\n".repeat(SEARCH_MAX_MATCHES_PER_FILE)).unwrap();
        let exact = search_file(&path, "hello", true).unwrap();
        assert_eq!(exact.matches.len(), SEARCH_MAX_MATCHES_PER_FILE);
        assert!(!exact.truncated);

        fs::write(&path, "hello\n".repeat(SEARCH_MAX_MATCHES_PER_FILE + 1)).unwrap();
        let extra = search_file(&path, "hello", true).unwrap();
        assert_eq!(extra.matches.len(), SEARCH_MAX_MATCHES_PER_FILE);
        assert!(extra.truncated);
    }

    #[test]
    fn cross_file_search_reports_only_actual_file_truncation() {
        let dir = SearchFixture::new("file-limit");
        fs::create_dir(dir.0.join("nested")).unwrap();
        for i in 0..SEARCH_MAX_FILES {
            fs::write(dir.0.join(format!("{}.txt", i)), "hello\n").unwrap();
        }
        fs::write(dir.0.join("no-match.txt"), "other\n").unwrap();
        let mut exact = SearchResults::default();
        search_dir(&dir.0, &search_pattern("hello", true).unwrap(), &mut exact, 0, &|| false);
        assert_eq!(exact.files.len(), SEARCH_MAX_FILES);
        assert!(!exact.files_truncated);

        fs::write(dir.0.join("nested").join("extra.txt"), "hello\n").unwrap();
        let mut extra = SearchResults::default();
        search_dir(&dir.0, &search_pattern("hello", true).unwrap(), &mut extra, 0, &|| false);
        assert_eq!(extra.files.len(), SEARCH_MAX_FILES);
        assert!(extra.files_truncated);
        let json = serde_json::to_value(extra).unwrap();
        assert_eq!(json["filesTruncated"], true);
        assert!(json["files"].is_array());
        assert_eq!(json["files"][0]["truncated"], false);
    }

    #[test]
    fn fingerprint_is_stable_and_detects_same_length_changes() {
        assert_eq!(fingerprint_bytes(b"hello"), fingerprint_bytes(b"hello"));
        assert_ne!(fingerprint_bytes(b"hello"), fingerprint_bytes(b"jello"));
        assert_ne!(fingerprint_bytes(b"hello"), fingerprint_bytes(b"hello!"));
    }

    #[test]
    fn revision_uses_metadata_fast_path_without_weakening_the_save_check() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("example.txt");
        fs::write(&path, b"first").unwrap();
        let initial = check_revision(&path, None).unwrap();
        let stamp = initial.stamp.as_deref().expect("test file metadata");
        assert!(check_revision(&path, Some(stamp)).unwrap().unchanged);
        fs::write(&path, b"second").unwrap();
        let changed = check_revision(&path, Some(stamp)).unwrap();
        assert!(!changed.unchanged);
        assert_ne!(changed.fingerprint, initial.fingerprint);
        // A full check is still available for watch events and conditional saves.
        assert_eq!(check_revision(&path, None).unwrap().fingerprint, changed.fingerprint);
        fs::remove_file(&path).unwrap();
        assert!(check_revision(&path, Some(stamp)).unwrap().fingerprint.is_none());
    }

    #[test]
    fn conditional_write_does_not_overwrite_external_change() {
        let path = std::env::temp_dir().join(format!(
            "betternotepad-conditional-write-{}.txt",
            std::process::id()
        ));
        let path_string = path.to_string_lossy().into_owned();
        fs::write(&path, b"aaaa").unwrap();
        let original = read_file_impl(path_string.clone()).unwrap().fingerprint;
        assert_eq!(
            fingerprint_path(&path).unwrap(),
            Some(original.clone())
        );

        fs::write(&path, b"bbbb").unwrap();
        let result = write_file_impl(
            path_string.clone(),
            "cccc".into(),
            Some("utf-8".into()),
            Some(original),
            None,
        );
        assert_eq!(result.unwrap_err(), FILE_CHANGED_EXTERNALLY);
        assert_eq!(fs::read(&path).unwrap(), b"bbbb");

        let current = fingerprint_path(&path).unwrap().unwrap();
        let written = write_file_impl(path_string.clone(), "cccc".into(), None, Some(current), None).unwrap();
        assert_eq!(fingerprint_path(&path).unwrap(), Some(written.clone()));
        assert_eq!(fs::read(&path).unwrap(), b"cccc");
        fs::remove_file(&path).unwrap();
        assert_eq!(fingerprint_path(&path).unwrap(), None);
        assert_eq!(
            write_file_impl(path_string, "dddd".into(), None, Some(written), None).unwrap_err(),
            FILE_CHANGED_EXTERNALLY
        );
    }

    #[cfg(windows)]
    #[test]
    fn conditional_save_rejects_an_open_writer_without_changing_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("busy.txt");
        fs::write(&path, b"original").unwrap();
        let name = path.to_string_lossy().into_owned();
        let original = fingerprint_bytes(b"original");
        let writer = fs::OpenOptions::new().write(true).open(&path).unwrap();
        assert_eq!(write_file_impl(name.clone(), "new".into(), None, Some(original.clone()), None).unwrap_err(), FILE_BUSY);
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        drop(writer);
        write_file_impl(name, "new".into(), None, Some(original), None).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
    }

    #[test]
    fn editor_rejects_oversized_files_before_allocating_their_contents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.txt");
        fs::File::create(&path).unwrap().set_len(MAX_EDITOR_FILE_BYTES + 1).unwrap();
        assert_eq!(read_file_impl(path.to_string_lossy().into_owned()).err().as_deref(), Some("FILE_TOO_LARGE"));
    }

    #[test]
    fn save_rejects_lossy_encoding_and_existing_new_destination() {
        let dir = SearchFixture::new("save-conflicts");
        let path = dir.0.join("example.txt");
        let name = path.to_string_lossy().into_owned();
        fs::write(&path, b"original").unwrap();
        assert!(write_file_impl(name.clone(), "🙂".into(), Some("gbk".into()), None, None)
            .unwrap_err().contains("UNREPRESENTABLE_TEXT"));
        assert_eq!(write_file_impl(name, "new".into(), None, None, Some(true)).unwrap_err(), FILE_CHANGED_EXTERNALLY);
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert!(create_file(dir.0.to_string_lossy().into_owned(), "example.txt".into()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert!(decode_bytes(&[0xEF, 0xBB, 0xBF, 0xFF]).is_err());
    }

    #[test]
    fn gbk_round_trip() {
        // "你好" in GBK: 你 = C4 E3, 好 = BA C3
        let bytes = [0xC4u8, 0xE3, 0xBA, 0xC3];
        let (text, enc) = decode_bytes(&bytes).unwrap();
        assert_eq!(text, "你好");
        assert_eq!(enc, "gbk");
        assert_eq!(encode_text(&text, &enc).unwrap(), bytes);
    }

    #[test]
    fn utf8_bom_round_trip() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("你好".as_bytes());
        let (text, enc) = decode_bytes(&bytes).unwrap();
        assert_eq!(text, "你好");
        assert_eq!(enc, "utf-8-bom");
        assert_eq!(encode_text(&text, &enc).unwrap(), bytes);
    }

    #[test]
    fn utf16le_round_trip() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "你好".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let (text, enc) = decode_bytes(&bytes).unwrap();
        assert_eq!(text, "你好");
        assert_eq!(enc, "utf-16le");
        assert_eq!(encode_text(&text, &enc).unwrap(), bytes);
    }

    #[test]
    fn utf16be_round_trip() {
        let mut bytes = vec![0xFE, 0xFF];
        for unit in "你好".encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        let (text, enc) = decode_bytes(&bytes).unwrap();
        assert_eq!(text, "你好");
        assert_eq!(enc, "utf-16be");
        assert_eq!(encode_text(&text, &enc).unwrap(), bytes);
    }

    #[test]
    fn plain_utf8_is_detected() {
        let (text, enc) = decode_bytes("plain text".as_bytes()).unwrap();
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

        let mut results = SearchResults::default();
        search_dir(&dir, &search_pattern("hello", false).unwrap(), &mut results, 0, &|| false);

        assert_eq!(results.files.len(), 2, "binary file must be skipped");
        let a = results.files.iter().find(|r| r.name == "a.txt").unwrap();
        assert_eq!(a.matches.len(), 1);
        assert_eq!(a.matches[0].line, 1);
        assert_eq!(a.matches[0].text, "hello world");
        let b = results.files.iter().find(|r| r.name == "b.py").unwrap();
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

        let mut insensitive = SearchResults::default();
        search_dir(&dir, &search_pattern("hello", false).unwrap(), &mut insensitive, 0, &|| false);
        assert_eq!(insensitive.files.len(), 1);

        let mut sensitive = SearchResults::default();
        let pattern = search_pattern("hello", true).unwrap();
        search_dir(&dir, &pattern, &mut sensitive, 0, &|| false);
        assert!(sensitive.files.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The two happy-path tests perform a real move to the machine's trash, so
    // they need a desktop session (IFileOperation on Windows). That is the
    // environment this project's tests run in.
    #[test]
    fn delete_file_moves_a_file_to_the_trash() {
        let dir = SearchFixture::new("trash-file");
        let path = dir.0.join("a.txt");
        fs::write(&path, "bye").unwrap();
        delete_file(path.to_string_lossy().into_owned()).unwrap();
        assert!(!path.exists(), "file must be gone from its folder");
    }

    #[test]
    fn delete_file_moves_a_folder_tree_to_the_trash() {
        let dir = SearchFixture::new("trash-dir");
        let folder = dir.0.join("folder");
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("a.txt"), "bye").unwrap();
        delete_file(folder.to_string_lossy().into_owned()).unwrap();
        assert!(!folder.exists(), "folder and its contents must be gone");
    }

    #[test]
    fn delete_file_reports_missing_paths() {
        let missing = std::env::temp_dir().join(format!(
            "betternotepad-trash-missing-{}.txt",
            std::process::id()
        ));
        assert!(!missing.exists());
        assert!(delete_file(missing.to_string_lossy().into_owned()).is_err());
    }
}
