//! Pico desktop shell.
//!
//! A thin native window around the Pico engine's web app:
//! 1. show a tiny local splash (glowing cat, "waking up…"),
//! 2. check `http://127.0.0.1:<port>/api/health`; if the engine is down, spawn it
//!    (`PICO_ENGINE_CMD` overrides the default command),
//! 3. once healthy, navigate the window to the engine URL so loopback token injection works.
//! ⌥Space (Alt+Space) shows/focuses the window from anywhere.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const WINDOW: &str = "main";

fn port() -> u16 {
    std::env::var("PICO_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(7878)
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn pico_home() -> PathBuf {
    std::env::var_os("PICO_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".pico"))
}

/// Minimal blocking `GET /api/health` over a raw socket (no HTTP client dependency).
fn healthy(port: u16) -> bool {
    let addr = match ("127.0.0.1", port).to_socket_addrs().ok().and_then(|mut a| a.next()) {
        Some(a) => a,
        None => return false,
    };
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(600)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = s.set_write_timeout(Some(Duration::from_millis(600)));
    let req = format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200") && text.contains("\"ok\"")
}

/// Start the engine detached, logging to $PICO_HOME/engine.log (same as the `pico` CLI launcher).
fn spawn_engine(port: u16) -> Result<(), String> {
    let ph = pico_home();
    let _ = std::fs::create_dir_all(&ph);
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(ph.join("engine.log"))
        .map_err(|e| e.to_string())?;
    let log2 = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = if let Ok(custom) = std::env::var("PICO_ENGINE_CMD") {
        // Free-form shell command.
        #[cfg(windows)]
        {
            let mut c = Command::new("cmd");
            c.args(["/C", &custom]);
            c
        }
        #[cfg(not(windows))]
        {
            let mut c = Command::new("/bin/sh");
            c.args(["-c", &custom]);
            c
        }
    } else {
        // Dev-checkout default: ~/Developer/pico/engine with the scratch venv.
        let h = home();
        let engine = std::env::var_os("PICO_ENGINE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| h.join("Developer").join("pico").join("engine"));
        #[cfg(windows)]
        let py = h.join(".hermes/cache/scratch/pico-venv/Scripts/python.exe");
        #[cfg(not(windows))]
        let py = h.join(".hermes/cache/scratch/pico-venv/bin/python");
        let py = if py.exists() { py.into_os_string() } else { "python3".into() };
        let mut c = Command::new(py);
        c.args(["-m", "pico.server"]).current_dir(engine);
        c
    };
    cmd.env("PICO_HOME", &ph)
        .env("PICO_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log2));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        cmd.creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // New process group: the engine outlives the window, like the CLI launcher's nohup.
        cmd.process_group(0);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn splash_status(win: &WebviewWindow, msg: &str) {
    let js = format!("window.picoStatus && window.picoStatus({})", serde_json::to_string(msg).unwrap_or_default());
    let _ = win.eval(&js);
}

/// Background boot: ensure engine, then load it.
fn boot(win: WebviewWindow) {
    std::thread::spawn(move || {
        let port = port();
        let url = Url::parse(&format!("http://127.0.0.1:{port}/")).expect("engine url");
        if !healthy(port) {
            splash_status(&win, "starting the engine…");
            if let Err(e) = spawn_engine(port) {
                splash_status(&win, &format!("couldn't start the engine: {e}"));
            }
            let t0 = Instant::now();
            loop {
                std::thread::sleep(Duration::from_millis(250));
                if healthy(port) {
                    break;
                }
                let s = t0.elapsed().as_secs();
                if s > 4 {
                    splash_status(&win, &format!("still waking up… {s}s"));
                }
                if s > 90 {
                    splash_status(&win, "the engine didn't come up — see ~/.pico/engine.log");
                    // keep polling slowly in case it's just slow
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
        }
        splash_status(&win, "ready");
        std::thread::sleep(Duration::from_millis(150));
        let _ = win.navigate(url);
    });
}

fn show(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Runs before every page load (splash and the engine page): tells the web app it's inside the
/// desktop shell so it can leave room for the macOS traffic lights.
const INIT_JS: &str = r#"
(function () {
  var os = navigator.userAgent.indexOf('Mac') >= 0 ? 'mac' : navigator.userAgent.indexOf('Win') >= 0 ? 'win' : 'linux';
  window.__PICO_DESKTOP__ = os;
  var tag = function () { document.documentElement.classList.add('desktop', 'desktop-' + os); };
  if (document.documentElement) tag(); else document.addEventListener('DOMContentLoaded', tag);
})();
"#;

pub fn run() {
    let toggle = Shortcut::new(Some(Modifiers::ALT), Code::Space);
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, sc, ev| {
                    if sc == &toggle && ev.state() == ShortcutState::Pressed {
                        show(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let mut b = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html".into()))
                .title("Pico")
                .inner_size(1200.0, 800.0)
                .min_inner_size(760.0, 520.0)
                .center()
                .background_color(tauri::webview::Color(22, 22, 26, 255))
                .initialization_script(INIT_JS);
            #[cfg(target_os = "macos")]
            {
                b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
            }
            let win = b.build()?;
            if let Err(e) = app.global_shortcut().register(toggle) {
                eprintln!("pico: couldn't register Alt+Space: {e}");
            }
            boot(win);
            Ok(())
        })
        .on_window_event(|w, ev| {
            // macOS: closing the window hides it (⌥Space / dock click brings it back; ⌘Q quits).
            #[cfg(target_os = "macos")]
            if let WindowEvent::CloseRequested { api, .. } = ev {
                api.prevent_close();
                let _ = w.hide();
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (w, ev);
        })
        .build(tauri::generate_context!())
        .expect("error while building Pico")
        .run(|app, ev| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = ev {
                show(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, ev);
        });
}
