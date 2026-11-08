//! TrueNav cashflow-v2.0.0 in Rust: a line-for-line port of the JS reference (cashflow/, spec/v2/score.mjs). The
//! library is pure (no I/O) so it runs natively for the parity tests and inside the OutLayer TEE build alike. The
//! raw-data parity fixtures (cashflow/fixtures/parity) must come out byte for byte identical (tests/parity.rs).
pub mod base;
pub mod matcher;
pub mod metrics;
pub mod run;
pub mod tee;
