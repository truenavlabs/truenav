//! Frozen v3 canonical bytes, validation and signed-source trust boundary. No I/O or secret logging.
pub mod source;
pub mod wire;
pub use wire::{canonical, envelope_hash, hash, parse, timestamp, validate, METHOD, SCHEMA};
pub type Result<T> = std::result::Result<T, &'static str>;
