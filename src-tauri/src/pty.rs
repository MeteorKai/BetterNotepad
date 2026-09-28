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
//!
//! 4. **The console comes up on the OEM code page.** Anything a child writes as
//!    UTF-8 through the console's ANSI path — PHP's extension warnings, for
//!    instance — is decoded as GBK by conhost and arrives as mojibake. We put
//!    the pseudo-console on UTF-8 before starting the program; see
//!    [`prime_utf8_console`] for why that has to happen on the console itself
//!    rather than by wrapping the command in a shell. The repaint that change
//!    provokes is removed by [`BlankSweep`] on the way to the frontend.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
#[cfg(windows)]
use portable_pty::SlavePty;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::blanksweep::BlankSweep;
use crate::runlog::{self, RunLog, RunLogInfo};

/// Serialises the open+spawn sequence. See hazard 1 in the module docs.
/// Deliberately a global rather than per-session: the failure mode is
/// cross-session, so the lock has to be too.
static SPAWN_LOCK: Mutex<()> = Mutex::new(());

/// How long the output pump collects bytes before handing them to the frontend.
///
/// Every channel message costs a hop through the *main thread*: Tauri delivers
/// it by evaluating a JS snippet on the wry event loop, which is the same loop
/// that has to answer the window's messages. One message per `read` therefore
/// lets a program printing in a tight loop starve that loop — the window stops
/// responding and cannot be dragged. 16 ms (one frame) is imperceptible to the
/// user while capping a run at ~60 messages per second.
const PTY_FLUSH_MS: u64 = 16;

/// Ceiling on one coalesced chunk, so a burst cannot build one huge message.
const PTY_MAX_CHUNK: usize = 64 * 1024;

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
    /// Set by the output pump once it has handed over the last bytes. Read by
    /// `pty_close` so the log it reports is complete rather than caught
    /// mid-tail.
    pump_done: Arc<AtomicBool>,
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
    /// Only ever set on the `"exit"` chunk: where this session's complete output
    /// was written. Skipped elsewhere rather than sent as a null on every frame.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log: Option<RunLogInfo>,
}

/// Events the reader thread can push.
fn data_chunk(data: Vec<u8>) -> PtyChunk {
    PtyChunk {
        kind: "data".into(),
        data,
        code: None,
        log: None,
    }
}

fn exit_chunk(code: Option<i32>, log: Option<RunLogInfo>) -> PtyChunk {
    PtyChunk {
        kind: "exit".into(),
        data: Vec::new(),
        code,
        log,
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

/// Put the pseudo-console on the UTF-8 code page before the real program starts.
///
/// ConPTY gives the console the system OEM code page — 936 on a Chinese Windows
/// — while conhost itself talks UTF-8. Interpreters that report errors through
/// the console's ANSI path write UTF-8 into that 936 console, so conhost decodes
/// their bytes as GBK and the message comes out as garbage: PHP's
/// `找不到指定的模块。` arrives as `鎵句笉鍒版寚瀹氱殑妯″潡銆?`. Measured, not guessed —
/// see the probe notes in `.workbuddy/memory/`.
///
/// The code page is console state rather than per-process state, so setting it
/// once here covers every child that later runs on this pseudo-console. Setting
/// it with a throwaway `cmd /c chcp` — rather than wrapping the user's command
/// line in a shell — keeps the process we actually launch, its arguments and its
/// exit code exactly as they were; `cmd` has exited long before the program
/// starts. It also puts the console's *input* code page on UTF-8, which is what
/// makes pasted non-ASCII input reach the child as UTF-8.
///
/// Best effort: if `cmd` is missing or wedges we keep the default code page and
/// carry on, so a missing shell can never block "run".
#[cfg(windows)]
fn prime_utf8_console(slave: &Box<dyn SlavePty + Send>) {
    let mut builder = CommandBuilder::new("cmd.exe");
    // `>nul` keeps "Active code page: 65001" out of the terminal.
    builder.args(["/c", "chcp 65001>nul"]);

    let Ok(mut child) = slave.spawn_command(builder) else {
        return;
    };

    // Bounded wait: `chcp` returns in milliseconds, but a wedged cmd must not
    // hold up the run.
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => break,
        }
    }

    // Let conhost settle. cmd has to be gone before the real child starts so the
    // terminal is not left with cmd's screen-clearing redraw as the newest
    // output.
    std::thread::sleep(Duration::from_millis(60));
}

// The repaint a code-page change provokes used to be filtered right here. It
// now lives in its own module so the probe that measured the repaint can run
// the shipped algorithm rather than a copy of it — see `blanksweep.rs`.

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
// Runs off the main thread on purpose. Opening a session waits on a throwaway
// `cmd` (see `prime_utf8_console`), which on a cold or busy machine is long
// enough to be felt as a freeze if it happens on the thread that drives the
// window. `SPAWN_LOCK` still serialises the critical section either way.
#[tauri::command(async)]
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

    // Hazard 4: the console starts on the OEM code page, which mangles anything
    // a child writes as UTF-8 through the console's ANSI path. Set it to UTF-8
    // first, on this same pseudo-console, so the child below inherits it.
    #[cfg(windows)]
    prime_utf8_console(&pair.slave);

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

    // Set by the pump below, waited on by whoever reports the exit. Declared
    // here because the session — and therefore `pty_close` — has to be able to
    // see it.
    let pump_done = Arc::new(AtomicBool::new(false));

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
                pump_done: pump_done.clone(),
            },
        );
    }

    // Spawn lock released here: the pseudo-console exists and is attached, the
    // concurrent-spawn hazard only covers creation.
    drop(_spawn_guard);

    // The complete session output goes to a file as well as to xterm. xterm's
    // scrollback is a cap — a program that prints more than it holds loses its
    // early output for good — and the log has none. Registered by id so both
    // the exit-watch thread and `pty_close` can hand the path to the frontend.
    let log = app.state::<runlog::RunLogs>().start(&app, &id);

    // Reader thread. Blocking reads stay off the Tauri event loop, and the
    // loop only ends when the master is closed or the child exits (EOF).
    //
    // The bytes go to the pump below rather than straight to the channel: see
    // PTY_FLUSH_MS for why one message per read is not an option.
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        // Frontend went away; stop pumping.
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        // Dropping `tx` is what tells the pump there is nothing left, and lets
        // it flush whatever it is still holding.
    });

    // Output pump. `recv` blocks until there is something to send, so an idle
    // session costs nothing and an isolated write — a prompt, an echoed
    // keystroke — goes out with no added latency. Once bytes are flowing the
    // pump keeps collecting for up to PTY_FLUSH_MS and sends them as one chunk.
    //
    // The log is written here, before each chunk is batched, for the same
    // reason the piped path writes it before queueing: the panel is a window,
    // the file is the record.
    let pump_channel = on_data.clone();
    let pump_log: Option<Arc<RunLog>> = log.clone();
    let pump_done2 = pump_done.clone();
    std::thread::spawn(move || {
        let window = Duration::from_millis(PTY_FLUSH_MS);
        let mut acc: Vec<u8> = Vec::with_capacity(8192);
        // Repaints are removed here, before the bytes are batched, so the same
        // clean stream is what reaches both the terminal and the log.
        let mut sweep = BlankSweep::default();
        loop {
            match rx.recv() {
                Ok(first) => {
                    let clean = sweep.feed(&first);
                    if let Some(log) = &pump_log {
                        log.write_bytes(&clean);
                    }
                    acc.extend_from_slice(&clean);
                }
                // The reader dropped its sender: everything the child wrote has
                // been handed over, and what is left in `acc` goes out below.
                Err(_) => break,
            }
            let deadline = Instant::now() + window;
            while acc.len() < PTY_MAX_CHUNK {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                match rx.recv_timeout(deadline - now) {
                    Ok(more) => {
                        let clean = sweep.feed(&more);
                        if let Some(log) = &pump_log {
                            log.write_bytes(&clean);
                        }
                        acc.extend_from_slice(&clean);
                    }
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            if pump_channel.send(data_chunk(std::mem::take(&mut acc))).is_err() {
                // Frontend went away. Nothing left to send, but the bytes are
                // already in the log, which is what matters.
                break;
            }
        }
        // Nothing more can arrive, so bytes the sweep held back can no longer
        // turn out to be the start of a repaint.
        acc.extend_from_slice(&sweep.finish());
        if !acc.is_empty() {
            let _ = pump_channel.send(data_chunk(std::mem::take(&mut acc)));
        }
        if let Some(log) = &pump_log {
            log.flush();
        }
        pump_done2.store(true, Ordering::SeqCst);
    });

    // Reports the exit, but only once the pump has handed over the tail. The
    // frontend stops accepting output the moment it sees the exit, so a chunk
    // sent afterwards would be dropped — and the log it is told about would
    // then be the one complete record of those lines.
    let send_exit = {
        let on_data = on_data.clone();
        let app3 = app.clone();
        let id4 = id.clone();
        let pump_done = pump_done.clone();
        move |code: Option<i32>| {
            let deadline = Instant::now() + Duration::from_millis(600);
            while !pump_done.load(Ordering::SeqCst) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            let log = runlog::finish(&app3, &id4);
            let _ = on_data.send(exit_chunk(code, log));
        }
    };

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
                    send_exit(code);
                    break;
                }
                Ok(None) => {
                    drop(map);
                }
                Err(_) => {
                    map.remove(&id3);
                    drop(map);
                    send_exit(None);
                    break;
                }
            },
            // Gone from the map, so `pty_close` ended it. That command reports
            // the log itself; reporting here too would resurrect an id the
            // frontend has already moved on from.
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

/// Close a session, and report where its complete output was written.
///
/// Dropping the job handle terminates the whole process tree. The return value
/// is what lets the frontend keep offering the log after a session the user
/// stopped by hand — the exit chunk never arrives in that case, because the
/// session is removed from the map before the exit-watch thread can see it.
// Off the main thread on purpose: it waits for the output pump's tail (see
// below), and that wait must not be served by the thread that repaints the
// window.
#[tauri::command(async)]
pub fn pty_close(app: AppHandle, id: String) -> Result<Option<RunLogInfo>, String> {
    let session = {
        let state = app.state::<PtyState>();
        let mut map = state.inner().0.lock().unwrap();
        // The lock is released before waiting: holding it would freeze
        // `pty_write` and the exit-watch thread for the length of the wait.
        map.remove(&id)
    };
    if let Some(mut session) = session {
        let pump_done = session.pump_done.clone();
        // Best effort: the job drop below is what actually reaps descendants on
        // Windows, but killing the direct child first makes the exit status
        // deterministic on platforms without job objects.
        let _ = session.child.kill();
        let _ = session.child.wait();
        // Dropping the session closes the pseudo-console, which is what drives
        // the reader to EOF and the pump to hand over its tail. Waiting before
        // this would be waiting for something that cannot happen yet.
        drop(session);
        let deadline = Instant::now() + Duration::from_millis(600);
        while !pump_done.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    Ok(runlog::finish(&app, &id))
}

/// Kill every session. Called on app shutdown so no terminal outlives the
/// window; without it a script started in a terminal would keep running after
/// the user closes BetterNotepad.
pub fn close_all(app: &AppHandle) {
    // Sessions have to be dropped — closing each pseudo-console — before the
    // wait, for the same reason `pty_close` does it: only then does a pump reach
    // its tail, and only then is the flush below worth doing.
    let pending: Vec<(String, Arc<AtomicBool>)> = {
        let state = app.state::<PtyState>();
        let mut map = state.inner().0.lock().unwrap();
        let mut pending = Vec::new();
        for (id, mut session) in map.drain() {
            pending.push((id, session.pump_done.clone()));
            let _ = session.child.kill();
            drop(session);
        }
        pending
    };
    let deadline = Instant::now() + Duration::from_millis(600);
    for (id, done) in pending {
        while !done.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        // The pumps die with the process, so anything still buffered would be
        // lost: this is the last chance to get a run that was live at shutdown
        // into its file.
        runlog::finish(app, &id);
    }
}
