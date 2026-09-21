//! Pseudo-terminal sessions for the "real terminal" output mode.
//!
//! Why a PTY instead of the piped stdio that `run_program` uses: when a
//! program's stdout is a pipe, most runtimes switch from line buffering to
//! block buffering (Python is the notorious case — see the crate-level notes in
//! `commands.rs`). The user sees nothing until the buffer fills or the process
//! exits, which reads as "the output is broken". A PTY makes the child believe
//! it is talking to a terminal, so it line-buffers and additionally emits ANSI
//! escape sequences that we can render with xterm.js (colours, progress bars
//! that redraw in place, full-screen TUIs).
//!
//! Three Windows-specific hazards are handled here, all of them confirmed
//! against the `portable-pty` source rather than assumed:
//!
//! 1. **ConPTY spawns must be serialised.** `ConPtySystem::spawn_command` only
//!    takes a lock on the individual pseudo-console, not a global one.
//!    Concurrent spawns can leave one of the resulting PTYs with a stalled
//!    output pipe, which looks like the terminal silently never printing
//!    anything. We take [`SPAWN_LOCK`] around the whole open+spawn sequence.
//!
//! 2. **`kill()` only terminates the direct child.** `WinChild::do_kill` is a
//!    bare `TerminateProcess` on the process handle, so anything the script
//!    started itself (a `subprocess.Popen`, a dev server) is orphaned and
//!    survives the app. We put each session in a job object with
//!    `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so dropping the handle takes down
//!    the whole tree.
//!
//! 3. **The cwd must use backslashes.** `psuedocon.rs` passes
//!    `cmd.current_directory()` straight to `CreateProcessW`, which mishandles
//!    forward slashes and fails the spawn outright. We normalise before handing
//!    the path over.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// Serialises the open+spawn sequence. See hazard 1 in the module docs.
/// Deliberately a global rather than per-session: the failure mode is
/// cross-session, so the lock has to be too.
static SPAWN_LOCK: Mutex<()> = Mutex::new(());

/// One live PTY session.
pub(crate) struct PtySession {
    /// Kept alive for resizing; dropping it closes the pseudo-console.
    master: Box<dyn MasterPty + Send>,
    /// The write half. `take_writer()` is one-shot, so we hold it for the
    /// lifetime of the session instead of fetching it per keystroke.
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Windows job object owning the process tree. Dropping it kills every
    /// descendant — see hazard 2. `None` on other platforms, and also `None`
    /// if job assignment failed, in which case we fall back to killing the
    /// direct child only.
    ///
    /// Never read on purpose: the cleanup happens in `JobHandle::drop`, so the
    /// field exists purely to keep the handle alive for as long as the session.
    #[cfg(windows)]
    #[allow(dead_code)]
    job: Option<JobHandle>,
}

/// Sessions keyed by the id the frontend generated.
///
/// Separate from `RunState` for the same reason `StdinState` is: the writer has
/// to stay reachable from Tauri commands while the child sits in a map that a
/// polling thread also touches. Sharing one lock would serialise keypresses
/// behind the exit poll.
#[derive(Default)]
pub struct PtyState(pub Mutex<HashMap<String, PtySession>>);

/// What the reader thread pushes over the channel. Bytes, not `String`: ANSI
/// sequences and partial UTF-8 sequences must reach xterm.js untouched, and a
/// `String` would force a lossy decode on every 4 KB chunk.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PtyChunk {
    /// `"data"` or `"exit"`.
    pub kind: String,
    /// Raw bytes for `"data"`, empty for `"exit"`.
    pub data: Vec<u8>,
    /// Exit status for `"exit"`.
    pub code: Option<i32>,
}

/// Events the reader thread can push.
fn data_chunk(data: Vec<u8>) -> PtyChunk {
    PtyChunk {
        kind: "data".into(),
        data,
        code: None,
    }
}

fn exit_chunk(code: Option<i32>) -> PtyChunk {
    PtyChunk {
        kind: "exit".into(),
        data: Vec::new(),
        code,
    }
}

/// ConPTY needs a backslash cwd. See hazard 3.
#[cfg(windows)]
fn normalize_cwd(dir: &str) -> String {
    dir.replace('/', "\\")
}

#[cfg(not(windows))]
fn normalize_cwd(dir: &str) -> String {
    dir.to_string()
}

// ---------------------------------------------------------------------------
// Windows job object
// ---------------------------------------------------------------------------

/// Owns a job object handle. Dropping it terminates every process in the job,
/// because the job was created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
#[cfg(windows)]
struct JobHandle(windows_sys::Win32::Foundation::HANDLE);

// A Win32 HANDLE is just an index into the process's kernel handle table; the
// kernel object it refers to is shared and thread-safe. Sending the handle to
// another thread is what `DuplicateHandle` normally formalises, and `CloseHandle`
// is documented as callable from any thread. `JobHandle` is the sole owner of
// this handle (nothing clones it), so moving it across threads cannot produce
// aliased mutation of the Rust-level value.
#[cfg(windows)]
unsafe impl Send for JobHandle {}
#[cfg(windows)]
unsafe impl Sync for JobHandle {}

#[cfg(windows)]
impl JobHandle {
    /// Create an anonymous job that kills its members when the handle closes.
    fn new() -> Option<Self> {
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );

            // Even if SetInformationJobObject failed, the handle is still
            // usable for assignment, so we return it rather than making callers
            // handle two shapes of "no job".
            Some(JobHandle(handle))
        }
    }

    /// Attach a running process (and, implicitly, its future descendants).
    fn assign(&self, pid: u32) -> bool {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        unsafe {
            let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if proc.is_null() {
                return false;
            }
            let ok = AssignProcessToJobObject(self.0, proc);
            CloseHandle(proc);
            ok != 0
        }
    }
}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            // Closing the last handle to a KILL_ON_JOB_CLOSE job is what tears
            // the process tree down.
            CloseHandle(self.0);
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Spawn `command` inside a fresh pseudo-terminal and stream its output.
///
/// Output arrives on `on_data` as it is produced — that is the whole point of
/// this command. The channel also carries the final exit status.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_open(
    app: AppHandle,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<PtyChunk>,
) -> Result<(), String> {
    // Reject a duplicate id rather than silently replacing a live session and
    // leaking its process tree.
    {
        let state = app.state::<PtyState>();
        let map = state.inner().0.lock().unwrap();
        if map.contains_key(&id) {
            return Err("A terminal with this id is already running".into());
        }
    }

    let dir = cwd.as_deref().filter(|d| !d.is_empty());
    if let Some(dir) = dir {
        if !std::path::Path::new(dir).is_dir() {
            return Err(format!(
                "Working directory is not available: {}. \
                 Open the folder again or pick another one in Settings.",
                dir
            ));
        }
    }

    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };

    let pty_system = native_pty_system();

    // Hazard 1: the whole open+spawn sequence is serialised.
    let _spawn_guard = SPAWN_LOCK.lock().unwrap();

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open a pseudo-terminal: {}", e))?;

    let mut builder = CommandBuilder::new(&command);
    builder.args(&args);
    // Pretend to be a capable terminal so programs enable colour and, more
    // importantly, so they pick line buffering over block buffering.
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    if let Some(dir) = dir {
        builder.cwd(normalize_cwd(dir));
    }

    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("Failed to start {}: {}", command, e))?;

    // The slave end must be dropped in the parent, otherwise the child never
    // sees EOF when it exits and the reader thread blocks forever.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to read from the pseudo-terminal: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to write to the pseudo-terminal: {}", e))?;

    let pid = child.process_id();

    // Hazard 2: own the process tree so "stop" and app exit clean up fully.
    #[cfg(windows)]
    let job = {
        let handle = JobHandle::new();
        if let (Some(job), Some(pid)) = (handle.as_ref(), pid) {
            // A failure here is not fatal — we just lose grandchild cleanup,
            // which `stop_program`-style killing of the direct child still
            // covers for the common case.
            let _ = job.assign(pid);
        }
        handle
    };

    {
        let state = app.state::<PtyState>();
        let mut map = state.inner().0.lock().unwrap();
        map.insert(
            id.clone(),
            PtySession {
                master: pair.master,
                writer,
                child,
                #[cfg(windows)]
                job,
            },
        );
    }

    // Spawn lock released here: the pseudo-console exists and is attached, the
    // concurrent-spawn hazard only covers creation.
    drop(_spawn_guard);

    // Reader thread. Blocking reads stay off the Tauri event loop, and the
    // loop only ends when the master is closed or the child exits (EOF).
    let reader_channel = on_data.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if reader_channel.send(data_chunk(buf[..n].to_vec())).is_err() {
                        // Frontend went away; stop pumping.
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Exit-watch thread. Polling keeps this simple and matches how the piped
    // path already tracks completion; the interval is short enough that the
    // status line feels immediate.
    let app2 = app.clone();
    let id3 = id.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let state = app2.state::<PtyState>();
        let mut map = state.inner().0.lock().unwrap();
        match map.get_mut(&id3) {
            Some(session) => match session.child.try_wait() {
                Ok(Some(status)) => {
                    let code = Some(status.exit_code() as i32);
                    // Removing the session drops the master (EOF for the reader
                    // thread) and the job handle (kills any stragglers).
                    map.remove(&id3);
                    drop(map);
                    let _ = on_data.send(exit_chunk(code));
                    break;
                }
                Ok(None) => {
                    drop(map);
                }
                Err(_) => {
                    map.remove(&id3);
                    drop(map);
                    let _ = on_data.send(exit_chunk(None));
                    break;
                }
            },
            None => break,
        }
    });

    Ok(())
}

/// Send input to the program. Raw bytes from xterm.js — arrow keys, Ctrl+C and
/// the like all arrive as escape sequences and are forwarded verbatim.
#[tauri::command]
pub fn pty_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    let state = app.state::<PtyState>();
    let mut map = state.inner().0.lock().unwrap();
    let session = map
        .get_mut(&id)
        .ok_or_else(|| "No such terminal session".to_string())?;

    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to the terminal: {}", e))?;
    // Without this the child's `input()` sits waiting while our bytes stay in
    // the buffer.
    session
        .writer
        .flush()
        .map_err(|e| format!("Failed to flush the terminal: {}", e))?;
    Ok(())
}

/// Tell the PTY about a new viewport size. Skipping this makes long lines wrap
/// in the wrong place, because the child keeps formatting for the old width.
#[tauri::command]
pub fn pty_resize(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let state = app.state::<PtyState>();
    let map = state.inner().0.lock().unwrap();
    let session = map
        .get(&id)
        .ok_or_else(|| "No such terminal session".to_string())?;

    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize the terminal: {}", e))
}

/// Close a session. Dropping the job handle terminates the whole process tree.
#[tauri::command]
pub fn pty_close(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<PtyState>();
    let mut map = state.inner().0.lock().unwrap();
    if let Some(mut session) = map.remove(&id) {
        // Best effort: the job drop below is what actually reaps descendants on
        // Windows, but killing the direct child first makes the exit status
        // deterministic on platforms without job objects.
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}

/// Kill every session. Called on app shutdown so no terminal outlives the
/// window; without it a script started in a terminal would keep running after
/// the user closes BetterNotepad.
pub fn close_all(app: &AppHandle) {
    let state = app.state::<PtyState>();
    let mut map = state.inner().0.lock().unwrap();
    for (_, mut session) in map.drain() {
        let _ = session.child.kill();
    }
}
