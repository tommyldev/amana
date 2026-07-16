use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    atop::cli::Cli::parse().run().await
}
