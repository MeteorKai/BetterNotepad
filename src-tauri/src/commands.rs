use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

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

#[derive(Default)]
pub struct RunState(pub Mutex<HashMap<String, Child>>);

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

#[derive(Clone, Serialize)]
pub struct RunLine {
    pub id: String,
    pub stream: String,
    pub line: String,
}

#[derive(Clone, Serialize)]
pub struct RunExit {
    pub id: String,
    pub code: Option<i32>,
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

#[tauri::command]
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

    {
        let state = app.state::<RunState>();
        let mut map = state.0.lock().unwrap();
        if map.contains_key(&id) {
            return Err("A process with this id is already running".into());
        }
        map.insert(id.clone(), child);
    }

    if let Some(stdin) = stdin {
        let state = app.state::<StdinState>();
        let mut map = state.0.lock().unwrap();
        map.insert(id.clone(), Arc::new(Mutex::new(stdin)));
    }

    if let Some(out) = stdout {
        let app2 = app.clone();
        let id2 = id.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines() {
                if let Ok(line) = line {
                    let _ = app2.emit(
                        "run://output",
                        RunLine {
                            id: id2.clone(),
                            stream: "stdout".into(),
                            line,
                        },
                    );
                }
            }
        });
    }

    if let Some(err) = stderr {
        let app2 = app.clone();
        let id2 = id.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines() {
                if let Ok(line) = line {
                    let _ = app2.emit(
                        "run://output",
                        RunLine {
                            id: id2.clone(),
                            stream: "stderr".into(),
                            line,
                        },
                    );
                }
            }
        });
    }

    let app2 = app.clone();
    std::thread::spawn(move || loop {
        let state = app2.state::<RunState>();
        let mut map = state.0.lock().unwrap();
        match map.get_mut(&id) {
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code();
                    map.remove(&id);
                    drop(map);
                    // Drop the write end too, otherwise the handle keeps the
                    // pipe alive for the rest of the session.
                    if let Ok(mut stdin_map) = app2.state::<StdinState>().0.lock() {
                        stdin_map.remove(&id);
                    }
                    let _ = app2.emit(
                        "run://exit",
                        RunExit {
                            id: id.clone(),
                            code,
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
                    break;
                }
            },
            None => break,
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_program(app: AppHandle, id: String) -> Result<(), String> {
    {
        let state = app.state::<RunState>();
        let mut map = state.0.lock().unwrap();
        if let Some(child) = map.get_mut(&id) {
            let _ = child.kill();
            let _ = child.wait();
            map.remove(&id);
        }
    }
    if let Ok(mut stdin_map) = app.state::<StdinState>().0.lock() {
        stdin_map.remove(&id);
    }
    let _ = app.emit(
        "run://exit",
        RunExit {
            id: id.clone(),
            code: None,
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
