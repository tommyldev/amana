use super::*;

#[test]
fn roundtrip_defaults() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("config.toml");
    let cfg = Config::load(&path).unwrap();
    assert!(path.exists());
    let cfg2 = Config::load(&path).unwrap();
    assert_eq!(cfg.providers.len(), cfg2.providers.len());
    let p = cfg.provider("omp").unwrap();
    assert_eq!(p.usage_window.r#type, WindowTypeCfg::Rolling);
    assert_eq!(p.usage_window.duration.as_deref(), Some("5h"));
    assert!(cfg.providers.iter().any(|p| p.id == "claude-code"));
    assert!(cfg.providers.iter().any(|p| p.id == "openai-api"));
}

#[test]
fn upsert_preserves_unknown() {
    let mut cfg = Config::default();
    cfg.upsert_provider(ProviderCfg {
        id: "custom".into(),
        enabled: true,
        auth_method: AuthMethod::None,
        usage_window: WindowCfg { r#type: WindowTypeCfg::Daily, duration: None },
        extra_windows: Vec::new(),
        limits: LimitsCfg::default(),
    });
    assert!(cfg.provider("custom").is_some());
    cfg.upsert_provider_window("custom", WindowCfg {
        r#type: WindowTypeCfg::Weekly,
        duration: Some("mon".into()),
    });
    assert_eq!(cfg.provider("custom").unwrap().usage_window.r#type, WindowTypeCfg::Weekly);
}
