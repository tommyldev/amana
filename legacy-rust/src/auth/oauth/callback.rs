//! Loopback OAuth callback: open the browser to the authorize URL, then wait
//! for the provider to redirect to `127.0.0.1:<port><path>`. Falls back to
//! pasting the redirect URL when the port can't be bound.
use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

fn open_browser(url: &str) {
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "start"
    } else {
        "xdg-open"
    };
    let _ = std::process::Command::new(cmd)
        .arg(url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

/// Drive the browser-redirect leg of an OAuth flow; returns `(code, state)`.
pub async fn run(port: u16, path: &str, expected_state: &str, auth_url: &str) -> Result<(String, String)> {
    open_browser(auth_url);
    println!("Opening your browser to authorize atop. If it doesn't open, visit:\n  {auth_url}\n");
    let path = path.to_string();
    let state = expected_state.to_string();
    tokio::task::spawn_blocking(move || listen_or_paste(port, &path, &state))
        .await
        .context("oauth callback task")?
}

fn listen_or_paste(port: u16, path: &str, expected_state: &str) -> Result<(String, String)> {
    match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => accept_callback(listener, path, expected_state),
        Err(_) => paste_fallback(expected_state),
    }
}

fn accept_callback(listener: TcpListener, path: &str, expected_state: &str) -> Result<(String, String)> {
    for stream in listener.incoming() {
        let mut stream = stream?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(300)));
        let mut buf = [0u8; 8192];
        let n = stream.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let target = req
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .unwrap_or("");
        let (req_path, query) = target.split_once('?').unwrap_or((target, ""));
        if req_path != path {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            continue;
        }
        let params = super::parse_query(query);
        let result = interpret(&params, expected_state);
        let (status, body) = match &result {
            Ok(_) => ("200 OK", "atop: authentication complete - you can close this tab."),
            Err(_) => ("400 Bad Request", "atop: authentication failed - check the terminal."),
        };
        let resp = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(resp.as_bytes());
        return result;
    }
    Err(anyhow!("oauth listener closed before a callback arrived"))
}

fn interpret(params: &HashMap<String, String>, expected_state: &str) -> Result<(String, String)> {
    if let Some(e) = params.get("error") {
        let desc = params.get("error_description").cloned().unwrap_or_else(|| e.clone());
        return Err(anyhow!("authorization failed: {desc}"));
    }
    let code = params
        .get("code")
        .cloned()
        .ok_or_else(|| anyhow!("missing authorization code"))?;
    let state = params.get("state").cloned().unwrap_or_default();
    if !expected_state.is_empty() && state != expected_state {
        return Err(anyhow!("state mismatch (possible CSRF)"));
    }
    Ok((code, state))
}

fn paste_fallback(expected_state: &str) -> Result<(String, String)> {
    use std::io::BufRead;
    eprintln!("Could not bind the local callback port. Paste the full redirect URL (or code) here:");
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    let (code, state) = super::parse_callback_input(&line);
    let code = code.ok_or_else(|| anyhow!("no authorization code found in pasted input"))?;
    let state = state.unwrap_or_default();
    if !expected_state.is_empty() && !state.is_empty() && state != expected_state {
        return Err(anyhow!("state mismatch (possible CSRF)"));
    }
    Ok((code, state))
}
