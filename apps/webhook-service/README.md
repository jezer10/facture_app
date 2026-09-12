# Webhook service

Consumes `billing.webhooks.v1` jobs named `webhook-delivery`. The job data is the
shared `WebhookEventEnvelope` from `@app/contracts`. Producers should call
`createWebhookDeliveryJobOptions(envelope.eventId)` so retries use exponential
backoff and BullMQ deduplicates the stable event ID.

Each active subscription belonging to `organizationId` receives the exact
canonical JSON envelope. Requests contain:

- `x-billing-signature: v1=<hex HMAC-SHA256>` over
  `timestamp + "." + rawBody`
- `x-billing-timestamp`: Unix seconds
- `x-billing-event-id`: the stable contract event ID
- `x-billing-event-type` and `x-billing-webhook-version`

Receivers can use `verifyWebhookSignature` with its default five-minute replay
window. A receiver still needs to store processed event IDs for idempotency.

## Local development

The default adapter is the durable TypeORM repository backed by
`WEBHOOK_DATABASE_URL`. Set `WEBHOOK_DATABASE_PASSWORD_FILE` for its password,
and run `pnpm migration:run:webhooks` before starting the service. HMAC signing
secrets are versioned and encrypted with `EnvelopeEncryption`; durable mode
therefore also requires a 32-byte `BILLING_MASTER_KEY_FILE`.

The volatile adapter is limited to tests or explicit local development and
fails closed unless both conditions are true:

```text
NODE_ENV=development
ALLOW_VOLATILE_ADAPTERS=true
```

Production always selects TypeORM and rejects volatile adapters. The schema
enforces a unique delivery key on `(organizationId, eventId, subscriptionId)`
and persists the canonical body hash, leases, attempts, terminal outcomes and
dead letters. Secret versions contain only encrypted envelopes, never
plaintext.

`PUT /internal/organizations/:organizationId/webhook-subscriptions/:id` and
the matching `GET` configure subscriptions. The signing secret is write-only;
responses and delivery records never contain it. These endpoints require an
`Authorization: Bearer <token>` header where `<token>` is the base64url encoding
of the bytes in `WEBHOOK_INTERNAL_SERVICE_SECRET_FILE`. If the file is not configured,
the API fails closed with 503. Health is available at `/internal/health/live`
and `/internal/health/ready` and exposes no configuration.

Supported subscription event types are:

- `fiscal-document.processing.v1`
- `fiscal-document.accepted.v1`
- `fiscal-document.rejected.v1`
- `fiscal-document.failed.v1`
- `fiscal-document.voided.v1`
- `received-document.imported.v1`

The validator rejects mismatched contracts, such as a received-document event with
a fiscal-document payload or an event whose `publicStatus` does not match its type.

HTTPS delivery is mandatory. Plain HTTP can be enabled only outside production
with `WEBHOOK_ALLOW_INSECURE_HTTP=true` for local receivers. Production rejects
localhost, private, link-local, metadata, documentation and other non-public IP
ranges. Immediately before each request the transport resolves every A/AAAA
answer, rejects the endpoint if any answer is non-public, and connects to a
verified IP while preserving the original TLS SNI and Host header. This pins the
checked resolution for the connection and prevents DNS-rebinding between the
check and the outbound request. Redirects are never followed.
