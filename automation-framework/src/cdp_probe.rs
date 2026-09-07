//! 探一个本机端口上是不是 Chromium 的调试接口（`GET /json/version`）。
//!
//! 自研的 Electron / WebView2 应用带 `--remote-debugging-port` 启动时，`app.resolve` 用它把
//! 调试端口认出来交回去，browser 工具就能按 CDP 接管——读 DOM、按节点点，比可访问性树省得多。
//! 纯 std 网络，两个平台共用；每个端口最多几百毫秒，只在 app.resolve 里对目标进程的监听端口跑。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// 一个活着的 CDP 端点。
#[derive(Debug, Clone, serde::Serialize)]
pub struct CdpEndpoint {
    pub port: u16,
    pub ws: String,
    pub browser: String,
}

/// 端口上有 Chromium 调试接口就回它，否则 None。
pub fn probe(port: u16) -> Option<CdpEndpoint> {
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
    stream
        .write_all(b"GET /json/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 2048];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 64 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    parse_version_response(&buf, port)
}

/// 从 HTTP 响应里抠出 webSocketDebuggerUrl。端口以本地实际连的那个为准（Chromium 有时回 0.0.0.0）。
pub fn parse_version_response(raw: &[u8], port: u16) -> Option<CdpEndpoint> {
    let text = String::from_utf8_lossy(raw);
    let body = text.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or(&text);
    let v: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    let ws_raw = v.get("webSocketDebuggerUrl")?.as_str()?;
    // ws://127.0.0.1:PORT/devtools/browser/<id>：把 host:port 换成我们连上的那个。
    let path_start = ws_raw.find("/devtools/")?;
    let ws = format!("ws://127.0.0.1:{port}{}", &ws_raw[path_start..]);
    Some(CdpEndpoint {
        port,
        ws,
        browser: v.get("Browser").and_then(|b| b.as_str()).unwrap_or("").to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_chromium_version_reply_and_pins_the_port_we_connected_to() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"Browser\":\"Chrome/128.0\",\"webSocketDebuggerUrl\":\"ws://0.0.0.0:9222/devtools/browser/abc-123\"}";
        let ep = parse_version_response(raw, 9333).expect("parsed");
        assert_eq!(ep.port, 9333);
        assert_eq!(ep.ws, "ws://127.0.0.1:9333/devtools/browser/abc-123");
        assert_eq!(ep.browser, "Chrome/128.0");
    }

    #[test]
    fn a_plain_http_server_is_not_mistaken_for_cdp() {
        let raw = b"HTTP/1.1 404 Not Found\r\n\r\n<html>nope</html>";
        assert!(parse_version_response(raw, 8080).is_none());
        let raw = b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}";
        assert!(parse_version_response(raw, 8080).is_none());
    }

    #[test]
    fn a_closed_port_yields_none_quickly() {
        let t = std::time::Instant::now();
        assert!(probe(1).is_none());
        assert!(t.elapsed() < Duration::from_secs(2));
    }
}
