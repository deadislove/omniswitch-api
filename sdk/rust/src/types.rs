//! Request/response shapes for the wrapped endpoints — mirrors sdk/node's types.ts.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinInfo {
    pub bin: String,
    pub country: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card_brand: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issuing_bank: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChargeSplit {
    pub merchant_id: String,
    pub amount: f64,
}

/// `amount` is in major currency units, e.g. 99.99.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChargeParams {
    pub amount: f64,
    pub currency: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_method_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statement_descriptor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bin_info: Option<BinInfo>,
    /// One of STRIPE / ADYEN / PAYPAL / CHASE.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// "automatic" or "manual".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentment_currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub splits: Option<Vec<ChargeSplit>>,
}

impl ChargeParams {
    pub fn new(amount: f64, currency: impl Into<String>) -> Self {
        Self { amount, currency: currency.into(), ..Default::default() }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EstimatedFee {
    pub amount: f64,
    pub currency: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChargeResponse {
    #[serde(default)]
    pub payment_id: String,
    /// SUCCEEDED / REQUIRES_ACTION / REQUIRES_CAPTURE / FAILED / AMBIGUOUS / PENDING_APPROVAL.
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub psp_transaction_id: Option<String>,
    /// STRIPE / ADYEN / PAYPAL / CHASE.
    #[serde(default)]
    pub psp_provider: Option<String>,
    #[serde(default)]
    pub action_url: Option<String>,
    #[serde(default)]
    pub requires_action: bool,
    #[serde(default)]
    pub risk_score: Option<f64>,
    #[serde(default)]
    pub used_fallback: bool,
    #[serde(default)]
    pub estimated_fee: Option<EstimatedFee>,
    #[serde(default)]
    pub presentment_amount: Option<f64>,
    #[serde(default)]
    pub presentment_currency: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    /// Only present when an AGENT charge exceeded its delegation's requireApprovalAboveAmount.
    #[serde(default)]
    pub approval_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentDetail {
    #[serde(default)]
    pub payment_id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub psp_transaction_id: Option<String>,
    #[serde(default)]
    pub psp_provider: Option<String>,
    #[serde(default)]
    pub action_url: Option<String>,
    #[serde(default)]
    pub requires_action: bool,
    #[serde(default)]
    pub risk_score: Option<f64>,
    #[serde(default)]
    pub used_fallback: bool,
    #[serde(default)]
    pub estimated_fee: Option<EstimatedFee>,
    #[serde(default)]
    pub presentment_amount: Option<f64>,
    #[serde(default)]
    pub presentment_currency: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub approval_id: Option<String>,
    #[serde(default)]
    pub amount: f64,
    #[serde(default)]
    pub currency: String,
    #[serde(default)]
    pub merchant_id: String,
    #[serde(default)]
    pub customer_id: Option<String>,
    #[serde(default)]
    pub order_id: Option<String>,
    #[serde(default)]
    pub metadata: Option<HashMap<String, String>>,
    #[serde(default)]
    pub refunds: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub captures: Option<Vec<serde_json::Value>>,
}

/// `amount` omitted (`None`) means a full refund of the remaining refundable balance.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl RefundParams {
    pub fn new(amount: Option<f64>, reason: Option<String>) -> Self {
        Self { amount, reason }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundResponse {
    #[serde(default)]
    pub payment_id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub total_refunded: f64,
    #[serde(default)]
    pub remaining_refundable: f64,
    #[serde(default)]
    pub currency: String,
    #[serde(default)]
    pub refunds: Option<Vec<serde_json::Value>>,
}

/// `amount` omitted (`None`) means a full capture of the remaining authorized amount.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResponse {
    #[serde(default)]
    pub payment_id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub psp_transaction_id: String,
    #[serde(default)]
    pub amount: f64,
    #[serde(default)]
    pub total_captured: f64,
    #[serde(default)]
    pub remaining_capturable: f64,
    #[serde(default)]
    pub currency: String,
    #[serde(default)]
    pub captures: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelResponse {
    #[serde(default)]
    pub payment_id: String,
    #[serde(default)]
    pub status: String,
}
