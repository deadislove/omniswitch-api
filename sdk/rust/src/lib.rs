//! OmniSwitch Rust SDK — the Rust sibling of `sdk/node`. See that
//! package's README for the full reasoning; this crate mirrors its
//! contract.

pub mod client;
pub mod errors;
pub mod http_sender;
pub mod signing;
pub mod types;
pub mod webhooks;

pub use client::{OmniSwitchClient, OmniSwitchClientOptions};
pub use errors::OmniSwitchApiError;
pub use http_sender::{HttpResult, HttpSender};
pub use signing::{sign_request, SignResult};
pub use types::{
    BinInfo, CancelResponse, CaptureParams, CaptureResponse, ChargeParams, ChargeResponse, ChargeSplit,
    EstimatedFee, PaymentDetail, RefundParams, RefundResponse,
};
pub use webhooks::{verify_webhook_signature, verify_webhook_signature_with_tolerance};

#[cfg(test)]
mod client_tests;
