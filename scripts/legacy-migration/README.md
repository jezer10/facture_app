# Legacy received-document migration

This command migrates received SUNAT invoices from the optional `sndr/back` database and verified artifacts from the original local checkout. It writes only to `received_documents`, `received_document_artifacts`, and the new private R2 bucket.

Dry-run is the default. The command has no source-delete operation and never migrates cached SUNAT access tokens.

## Tenant mapping

Create a local JSON file outside version control. Every value must identify an existing issuer in the destination organization, and the issuer RUC must match `recipientRuc`.

```json
{
  "legacyCompanies": {
    "<legacy-company-uuid>": {
      "organizationId": "<destination-organization-uuid>",
      "recipientIssuerId": "<destination-issuer-uuid>",
      "recipientRuc": "<11-digit-ruc>"
    }
  },
  "recipientRucs": {
    "<11-digit-ruc>": {
      "organizationId": "<destination-organization-uuid>",
      "recipientIssuerId": "<destination-issuer-uuid>",
      "recipientRuc": "<11-digit-ruc>"
    }
  }
}
```

`legacyCompanies` maps database rows. `recipientRucs` maps complete local generations. Missing or inconsistent mappings block the entire run before artifacts or destination records are changed.

## Environment

Destination:

- `CORE_DATABASE_URL`
- `CORE_DATABASE_PASSWORD_FILE` (preferred; required when the URL has no password)
- `R2_ENDPOINT`
- `R2_BUCKET`
- `R2_ACCESS_KEY_ID_FILE`
- `R2_SECRET_ACCESS_KEY_FILE`

Optional database/R2 source:

- `LEGACY_DATABASE_URL`
- `LEGACY_DATABASE_PASSWORD_FILE` (preferred when the URL has no password)
- `LEGACY_DATABASE_SCHEMA` (defaults to `public`)
- `LEGACY_R2_ENDPOINT`, or `CLOUDFLARE_ACCOUNT_ID`
- `LEGACY_INVOICE_R2_BUCKET`, or `INVOICE_R2_BUCKET`
- `LEGACY_R2_ACCESS_KEY_ID_FILE` (preferred), otherwise `LEGACY_R2_ACCESS_KEY_ID` or the legacy `CLOUDFLARE_R2_ACCESS_KEY_ID`
- `LEGACY_R2_SECRET_ACCESS_KEY_FILE` (preferred), otherwise `LEGACY_R2_SECRET_ACCESS_KEY` or the legacy `CLOUDFLARE_R2_SECRET_ACCESS_KEY`

Secret files must be regular `0600` files, or read-only files under `/run/secrets`. Errors are reported only by a stable code; paths and values are never emitted.

The local source defaults to `/home/jzr/Documentos/personal/facture_app`. It inspects only `generated/**` and `output/pdf/**`; unrelated fixtures, caches, virtual environments, and source files are ignored.

## Run

First run the inventory and preflight without mutations:

```bash
pnpm migration:legacy \
  --mapping /secure/path/legacy-tenant-mapping.json
```

Review the JSON report. A successful dry-run has `status: "completed"`, nonzero `wouldImport`/`wouldCopy` when data is eligible, and no unexpected quarantine entries. Apply the exact same inputs explicitly:

```bash
pnpm migration:legacy \
  --mapping /secure/path/legacy-tenant-mapping.json \
  --apply
```

Use `--skip-legacy-db`, `--skip-local`, or `--local-root <path>` to select sources. The report contains only counts, schema field names, and one-way quarantine fingerprints; it contains no RUCs, UUIDs, paths, plaintext credentials, envelopes, or access tokens.

## Retirement of the SNDR fiscal runtime

SNDR keeps its historical `invoices` table and fiscal columns of `companies` for
this source adapter. New WhatsApp companies can have null fiscal columns; they do
not need issuer mappings unless they own an eligible historical invoice. Missing
credentials can appear as `corrupt` in the aggregate inventory, but that inventory
does not block invoice import. Credentials are not migrated; configure them via
the issuer credentials API. Never change the source schema or bucket during import.

After import, use `GET /api/v1/received-documents/:documentId/artifacts/pdf` or
`/artifacts/canonical-json` with `received:read` and an issuer grant to download
verified historical files. The destination UUID differs from the legacy UUID;
resolve documents using the destination listing and supplier/type/series/number.

Run the migration regression suite with `pnpm test:legacy-migration`. See the
[cutover guide](../../../back/INVOICES_GUIDE.md) before switching consumers.
