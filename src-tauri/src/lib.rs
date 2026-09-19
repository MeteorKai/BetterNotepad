mod commands;
mod shell_menu;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin registered: a second launch has to be caught
        // and terminated before any other plugin or window is set up.
        //
        // This is what makes double-clicking a .txt reuse the running window
        // instead of spawning a second copy of the app.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // Raise the existing window. `AllowSetForegroundWindow` was handed to
            // us by the exiting instance, so this call is actually allowed to
            // steal focus rather than just flashing the taskbar button.
            if let Some(window) = app.get_webview_window("main") {
                if window.is_minimized().unwrap_or(false) {
                    let _ = window.unminimize();
                }
                let _ = window.show();
                let _ = window.set_focus();
            }

            let files = commands::queue_forwarded_open_files(&argv, &cwd);
            if files.is_empty() {
                // Launched with no file (e.g. a pinned shortcut) — focusing the
                // window was the whole point.
                return;
            }

            // If the webview is still booting it has no listener yet; the queue
            // drained on mount covers that case.
            let _ = app.emit("open-files", files);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(commands::RunState::default())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::file_exists,
            commands::get_file_name,
            commands::get_startup_files,
            commands::take_pending_open_files,
            commands::rename_file,
            commands::delete_file,
            commands::create_file,
            commands::create_folder,
            commands::detect_interpreters,
            commands::run_program,
            commands::stop_program,
            commands::search_in_files,
            shell_menu::context_menu_enabled,
            shell_menu::context_menu_command,
            shell_menu::set_context_menu,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
