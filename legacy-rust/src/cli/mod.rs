use anyhow::Result;
use clap::{Parser, Subcommand};

use crate::cli::usage_cmd::UsageCmd;

mod limit_cmd;
mod login_cmd;
mod usage_cmd;
mod validate;
mod window_cmd;

#[derive(Parser, Debug)]
#[command(name = "atop", version, about = "Agent Token Observer & Monitor")]
pub struct Cli {
    #[command(subcommand)]
    pub cmd: Option<Cmd>,
}

#[derive(Subcommand, Debug)]
pub enum Cmd {
    /// Print today's spend + per-provider window status (default action)
    Report,
    /// Run ingestion now (incremental; --full re-reads from byte 0)
    Sync {
        #[arg(long)]
        full: bool,
    },
    /// Set or change the active usage window for a provider
    Window(WindowCmd),
    /// Set token or cost limits for a provider
    Limit(LimitCmd),
    /// Launch the live dashboard (btop-style)
    Tui,
    /// Authenticate a provider (api key) or run its OAuth flow
    Login { provider: Option<String> },
    /// Fetch live provider usage/quota with atop's own credentials
    Usage(UsageCmd),
 }


#[derive(Parser, Debug)]
pub struct WindowCmd {
    #[command(subcommand)]
    pub cmd: WindowSub,
}

#[derive(Subcommand, Debug)]
pub enum WindowSub {
    /// Set the active window. Type-specific flags: rolling needs --duration;
    /// weekly needs --weekday; monthly needs --day; daily takes none.
    Set {
        provider: Option<String>,
        #[arg(long)]
        r#type: WindowTypeArg,
        #[arg(long)]
        duration: Option<String>,
        #[arg(long)]
        weekday: Option<String>,
        #[arg(long)]
        day: Option<u8>,
    },
}

#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowTypeArg {
    Rolling,
    Daily,
    Weekly,
    Monthly,
}

#[derive(Parser, Debug)]
pub struct LimitCmd {
    #[command(subcommand)]
    pub cmd: LimitSub,
}

#[derive(Subcommand, Debug)]
pub enum LimitSub {
    /// Set a per-window token limit and/or a monthly cost ceiling.
    Set {
        provider: Option<String>,
        #[arg(long)]
        cost: Option<f64>,
        #[arg(long)]
        tokens: Option<u64>,
    },
}

impl Cli {
    pub fn parse() -> Self {
        <Self as Parser>::parse()
    }

    pub async fn run(self) -> Result<()> {
        use crate::{config, db, report, sync};

        let paths = config::Paths::resolve()?;
        let cfg = config::Config::load(&paths.config_path)?;
        let db = db::Db::open(&paths.data_path())?;

        match self.cmd.unwrap_or(Cmd::Tui) {
            Cmd::Report => {
                sync::run_sync(&db, &cfg, false).await?;
                let out = report::render_report(&db, &cfg, chrono::Utc::now());
                print!("{out}");
                Ok(())
            }
            Cmd::Sync { full } => {
                let counts = sync::run_sync(&db, &cfg, full).await?;
                for (src, n) in counts {
                    println!("{src}: inserted {n}");
                }
                Ok(())
            }
            Cmd::Window(args) => window_cmd::run(args, &paths, cfg).await,
            Cmd::Limit(args) => limit_cmd::run(args, &paths, cfg).await,
            Cmd::Tui => crate::tui::run(&paths, cfg, db).await,
            Cmd::Login { provider } => login_cmd::run(provider, &paths, &cfg, &db).await,
            Cmd::Usage(args) => usage_cmd::run(args, &db).await,
         }
    }
}
