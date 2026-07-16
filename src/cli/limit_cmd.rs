use anyhow::Result;

use crate::cli::{LimitCmd, LimitSub};
use crate::config::{self, Config, Paths};

pub async fn run(args: LimitCmd, paths: &Paths, cfg: Config) -> Result<()> {
    match args.cmd {
        LimitSub::Set { provider, cost, tokens } => {
            let id = provider
                .ok_or_else(|| anyhow::anyhow!("limit set: provider id is required (try 'omp' or 'claude-code')"))?;
            let mut cfg = cfg;
            cfg.upsert_provider_limit(&id, cost, tokens);
            config::Config::save(&paths.config_path, &cfg)?;
            println!("{id}: limits updated");
            Ok(())
        }
    }
}
