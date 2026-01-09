# dunning-collections-bridge

Webhook listener that receives Billwerk `PaymentEscalated` events, sends dunning letters via LetterXpress, and hands off to Paywise for collection after the escalation process ends.

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
For LetterXpress dunning handling, configure `BILLWERK_DUNNING_TRIGGER_DAYS` (default: `22`), `BILLWERK_DUNNING_TEMPLATE_ID`, plus `LETTERXPRESS_USERNAME` and `LETTERXPRESS_API_KEY`. The LetterXpress mode defaults to `test`.

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
3. When `TriggerDays` matches the dunning trigger day (default: 22), fetch the latest Billwerk dunning PDF and send it via LetterXpress.
4. When `TriggerDays` matches the Paywise trigger days (default: 30), create or reuse a Paywise debtor using the Billwerk customer data.
5. Create a Paywise claim using invoice data and the escalation due date.
6. Release the Paywise claim and book the write-off payment in Billwerk.

## Notes

- The claim is de-duplicated by `document_reference` or `your_reference`.
- It is possible to send every dunning letter via LetterXpress by configuring additional webhook trigger days for dunning handling.
- If you want to enforce webhook authentication, set `WEBHOOK_SHARED_SECRET` and send `x-webhook-secret`.
- If Billwerk has many invoices per customer, consider adding pagination to the invoice listing.
- Billwerk dunnings are fetched from `/api/v1/dunnings` using the configured template id.

## Security

- Never commit `.env` or real credentials; rotate keys if they are exposed.
- Avoid logging personal data; the webhook payload contains customer data.
- Configure test credentials for development and switch `LETTERXPRESS_MODE` to `live` only in production.
