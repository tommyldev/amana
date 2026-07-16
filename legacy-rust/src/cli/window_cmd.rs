use anyhow::Result;

use crate::cli::{WindowCmd, WindowSub, WindowTypeArg};
use crate::config::{self, Config, Paths};

pub async fn run(args: WindowCmd, paths: &Paths, cfg: Config) -> Result<()> {
    match args.cmd {
        WindowSub::Set { provider, r#type, duration, weekday, day } => {
            let id = require(&provider, "window set")?;
            let mut cfg = cfg;
            let w = match r#type {
                WindowTypeArg::Rolling => config::WindowCfg {
                    r#type: config::WindowTypeCfg::Rolling,
                    duration: Some(duration
                        .ok_or_else(|| anyhow::anyhow!("--duration required for rolling"))?),
                },
                WindowTypeArg::Daily => config::WindowCfg {
                    r#type: config::WindowTypeCfg::Daily,
                    duration: None,
                },
                WindowTypeArg::Weekly => config::WindowCfg {
                    r#type: config::WindowTypeCfg::Weekly,
                    duration: Some(weekday
                        .ok_or_else(|| anyhow::anyhow!("--weekday required for weekly"))?),
                },
                WindowTypeArg::Monthly => config::WindowCfg {
                    r#type: config::WindowTypeCfg::Monthly,
                    duration: Some(day
                        .map(|d| d.to_string())
                        .ok_or_else(|| anyhow::anyhow!("--day required for monthly"))?),
                },
            };
            cfg.upsert_provider_window(&id, w);
            config::Config::save(&paths.config_path, &cfg)?;
            println!("{id}: window updated");
            Ok(())
        }
    }
}

fn require(provider: &Option<String>, cmd: &str) -> Result<String> {
    provider.clone()
        .ok_or_else(|| anyhow::anyhow!("{cmd}: provider id is required (try 'omp' or 'claude-code')"))
}
