//! # Rust 自动化框架
//!
//! 跨平台自动化框架，支持：
//! - 浏览器自动化（基于 Chrome DevTools Protocol）
//! - 系统级自动化（鼠标、键盘、窗口控制）
//! - Windows 和 macOS 原生支持
//! - **AI Agent 统一接口** - 简化调用，专为 AI agent 设计
//!
//! ## AI Agent 使用方式
//!
//! ```rust,no_run
//! use rust_automation_framework::Agent;
//!
//! fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let mut agent = Agent::new()?;
//!     
//!     // 浏览器操作（自动处理 async）
//!     agent.browser_start(false)?;  // false = 有头模式
//!     agent.browser_goto("https://example.com")?;
//!     agent.browser_click("button#submit")?;
//!     agent.browser_type("input[name='q']", "search query")?;
//!     
//!     // 系统操作
//!     agent.system_init()?;
//!     agent.mouse_move(500, 300)?;
//!     agent.mouse_click(Some("left"))?;
//!     agent.keyboard_type("Hello from AI!")?;
//!     agent.keyboard_press("enter")?;
//!     
//!     Ok(())
//! }
//! ```

pub mod error;
pub mod types;
pub mod recorder;
pub mod agent;
pub mod rpc;
pub mod task;

#[cfg(feature = "server")]
pub mod http_server;

#[cfg(feature = "browser")]
pub mod browser;

/// 人类化输入运动学（纯函数：轨迹 + 敲键节奏），browser 那套 CDP 输入用它。
pub mod human_input;

/// 截图缩放、坐标换算与 Set-of-Marks 编号框。纯函数，不碰 Agent。
pub mod vision;

/// 探本机端口上的 Chromium 调试接口（自研 Electron / WebView2 应用的接管入口）。
pub mod cdp_probe;

#[cfg(feature = "system")]
pub mod system;

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub mod platform;

#[cfg(test)]
mod tests;

// 导出 Agent 作为主要接口
pub use agent::Agent;
pub use rpc::{RpcServer, RpcRequest, RpcResponse};
pub use task::{TaskExecutor, TaskResult};

#[cfg(feature = "server")]
pub use http_server::HttpServer;

pub mod prelude {
    pub use crate::error::{Error, Result};
    pub use crate::types::*;
    pub use crate::recorder::{Recording, Replayer};
    pub use crate::agent::Agent;
    
    #[cfg(feature = "browser")]
    pub use crate::browser::BrowserAutomation;
    
    #[cfg(feature = "system")]
    pub use crate::system::SystemAutomation;
}

/// 初始化日志系统
pub fn init_logging() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "rust_automation_framework=info".into()),
        )
        .init();
}
