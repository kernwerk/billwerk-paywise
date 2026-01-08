# bwsync

Webhook listener that receives Billwerk `PaymentEscalated` events and creates a Paywise Case Management claim.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment variables:

```bash
cp .env.example .env
```

Set `BILLWERK_CLIENT_ID`, `BILLWERK_CLIENT_SECRET`, and `PAYWISE_TOKEN`. The Billwerk OAuth URL is derived from `BILLWERK_BASE_URL` (e.g., `https://app.billwerk.com/oauth/token/`).
Optionally set `BILLWERK_TRIGGER_DAYS` to a comma-separated list of `TriggerDays` values that should create a Paywise case (default: `30`).

3. Start the server:

```bash
npm run dev
```

The service listens on `http://localhost:3000` by default.

## Webhook Endpoint

- `POST /webhooks/billwerk/payment-escalated`
- Accepts the Billwerk webhook payload for `PaymentEscalated`.

Example payload:

```json
{
  "ContractId": "6298a006e636b694d807080f",
  "CustomerId": "6298a006e636b694d8070809",
  "TriggerDays": 5,
  "DueDate": "2022-06-09T00:00:00.0000000Z",
  "PaymentEscalationProcessId": "623812c0426dc88abe51b23a",
  "Event": "PaymentEscalated",
  "EntityId": "62148e3c0c14e1609e9ca5c1"
}
```

## Data Flow

1. Fetch contract, customer, and ledger entries from Billwerk.
2. Resolve the matching invoice (ledger entry invoice id or latest invoice for the contract).
3. Create or reuse a Paywise debtor using the Billwerk customer data.
4. Create a Paywise claim using invoice data and the escalation due date.

## Notes

- The claim is de-duplicated by `document_reference` or `your_reference`.
- If you want to enforce webhook authentication, set `WEBHOOK_SHARED_SECRET` and send `x-webhook-secret`.
- If Billwerk has many invoices per customer, consider adding pagination to the invoice listing.
