SHELL := /usr/bin/env bash
BIN   := target/release/atop
DEV   := target/debug/atop

.PHONY: help build dev install run report sync auth-status auth-login clean test fmt check

help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "Targets:\n"} \
		/^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

build: ## Release build.
	cargo build --release

dev: ## Debug build.
	cargo build

install: build ## Install release binary into ~/.cargo/bin.
	cargo install --path . --locked --force

run: ## Run `cargo run -- report` (debug).
	cargo run -- report

report: build ## Sync + print report (release).
	$(BIN) report

sync: build ## Run an incremental sync (release).
	$(BIN) sync

auth-status: build ## Show provider credential + status table (release).
	$(BIN) auth status

auth-login: build ## Interactively log in a provider (release). Usage: make auth-login P=anthropic-api
	$(BIN) auth login $(P)

test: ## Run the test suite.
	cargo test

fmt: ## Format sources.
	cargo fmt --all

check: ## Type-check + clippy (deny warnings).
	cargo clippy --all-targets -- -D warnings
	cargo test --no-run

clean: ## Remove build artifacts.
	cargo clean