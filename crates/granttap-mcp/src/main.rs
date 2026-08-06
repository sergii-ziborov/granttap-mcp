//! GrantTap MCP — single binary for Cursor mcp.json and LaunchAgent.

use std::io::{self, Write};
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        None | Some("mcp") => match granttap_mcp::tools::serve() {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                let _ = writeln!(io::stderr(), "[granttap-mcp] {e}");
                ExitCode::FAILURE
            }
        },
        Some("--version" | "-V") => {
            println!("granttap-mcp {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some("--help" | "-h") => {
            print_help();
            ExitCode::SUCCESS
        }
        Some("setup") => {
            println!("{}", granttap_mcp::setup::run_setup());
            ExitCode::SUCCESS
        }
        Some("status") => {
            println!("{}", granttap_mcp::status::render_status());
            ExitCode::SUCCESS
        }
        Some("connect") => {
            let relay = args.next();
            match granttap_mcp::pairing::create_one_time_pairing(relay.as_deref()) {
                Ok(p) => {
                    println!("{}", granttap_mcp::pairing::connect_text(&p));
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    let _ = writeln!(io::stderr(), "[granttap-mcp] {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("monitor") => {
            let _ = writeln!(
                io::stderr(),
                "[granttap-mcp] monitor subcommand is not ported yet — keep using the Node monitor, or point LaunchAgent at bin/granttap-mcp.mjs monitor"
            );
            ExitCode::FAILURE
        }
        Some("hook") => {
            let _ = writeln!(
                io::stderr(),
                "[granttap-mcp] hook subcommand is not ported yet — Claude/Codex hooks still need the Node entrypoint"
            );
            ExitCode::FAILURE
        }
        Some(other) => {
            let _ = writeln!(io::stderr(), "[granttap-mcp] unknown argument: {other}");
            print_help();
            ExitCode::FAILURE
        }
    }
}

fn print_help() {
    let _ = writeln!(
        io::stdout(),
        "Usage:\n  granttap-mcp                 Start the MCP stdio server\n  granttap-mcp connect [url]   Pair this machine\n  granttap-mcp setup           Install hooks + LaunchAgent plist\n  granttap-mcp status          Diagnose pairing / monitor\n"
    );
}
