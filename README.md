# Facture App

Plataforma fiscal multi-tenant para centralizar la emisión y recepción de CPE de
varios servicios internos. La API pública es asíncrona: registra el documento y su
correlativo en PostgreSQL, responde `202`, y procesa SUNAT, artefactos y webhooks a
través de BullMQ.

> **Estado fiscal:** el flujo distribuido y el proveedor mock están operativos para
> pruebas, pero el envío real permanece bloqueado de forma intencional. La firma
> XMLDSig y el transporte SOAP/ZIP/CDR deben validarse con certificados y fixtures
> oficiales de SUNAT antes de habilitar producción; el health productivo falla
> cerrado mientras eso no ocurra.

## Arquitectura

- `billing-api`: autenticación JWT/API key y API `/api/v1`.
- `billing-worker`: outbox/inbox, resultados SUNAT y PDF/QR.
- `sunat-service`: UBL, firma, envíos, conciliación, CDR y recepción.
- `webhook-service`: suscripciones, firma HMAC, reintentos y dead letters.

El diagrama, los límites de datos y las garantías de entrega están en
[`docs/architecture.md`](docs/architecture.md).

Fiscal Core, SUNAT y Delivery tienen bases y usuarios PostgreSQL separados. No hay
claves foráneas ni entidades ORM compartidas entre esos límites. Redis se configura
con AOF y `noeviction`; R2 es privado y usa object keys inmutables.

## Requisitos

- Node.js 24 y pnpm 10.34.5 para desarrollo directo.
- Docker Engine con Compose para levantar la plataforma completa.
- Un bucket R2 privado y credenciales distintas de mínimo privilegio para API,
  worker y SUNAT.

## Inicio local seguro

1. Genera secretos locales; el script no sobrescribe archivos existentes:

   ```bash
   ./scripts/generate-development-secrets.sh
   ```

2. Agrega manualmente en `deploy/secrets/local` las seis credenciales R2 descritas
   en `deploy/secret-templates/README.md`.

3. Exporta únicamente configuración no secreta:

   ```bash
   export BILLING_PUBLIC_URL=http://localhost:3300
   # El valor por defecto seguro de Compose es la gateway fija 172.30.250.1/32.
   export BILLING_TRUSTED_PROXY_CIDRS=172.30.250.1/32
   export R2_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
   export R2_BUCKET=billing-private
   ```

   No uses `0.0.0.0/0` ni `::/0`: la API usa esta lista para obtener la IP real sin
   aceptar `X-Forwarded-For` de orígenes no confiables. Compose fija la red egress en
   `172.30.250.0/24` y confía sólo en su gateway. Si ese rango colisiona o el proxy
   corre en otra red, cambia juntos `BILLING_EGRESS_SUBNET`,
   `BILLING_EGRESS_GATEWAY` y `BILLING_TRUSTED_PROXY_CIDRS`.

4. Para pruebas estructurales con el proveedor SUNAT simulado:

   ```bash
   docker compose -f compose.yaml -f compose.dev.yaml up --build
   ```

   El modo mock no firma ni envía comprobantes reales y está prohibido cuando
   `NODE_ENV=production`.

5. Comprueba la API:

   ```bash
   curl http://localhost:3300/api/v1/health/ready
   ```

6. Ejecuta el flujo completo de prueba. Crea un tenant aislado, emisor, serie,
   cuenta de servicio y API key; emite una factura, espera la respuesta asíncrona y
   verifica JSON, XML y PDF. No imprime credenciales:

   ```bash
   pnpm smoke:mock
   ```

   El resultado lleva `mode: mock-no-fiscal-validity`: usa datos con forma real,
   PostgreSQL, Redis y R2 reales, pero no se presenta ante SUNAT.

## Bootstrap administrativo

La plataforma valida JWT emitidos por el proveedor administrativo; no implementa
login ni almacena contraseñas humanas. Para desarrollo puede emitirse un JWT de
plataforma válido durante 15 minutos:

```bash
ADMIN_TOKEN="$(node scripts/create-development-jwt.mjs)"
curl -X POST http://localhost:3300/api/v1/organizations \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Mi organización","slug":"mi-organizacion","ownerSubject":"local-platform-admin"}'
```

Con el `id` devuelto se emite el token del administrador de esa organización:

```bash
ORG_TOKEN="$(node scripts/create-development-jwt.mjs \
  deploy/secrets/local/jwt_secret local-platform-admin "$ORGANIZATION_ID")"
```

Con `ORG_TOKEN` se crean un emisor, su serie, una cuenta de servicio, el grant al
emisor y una API key. `POST /api/v1/service-accounts/:id/api-keys` exige
`Idempotency-Key`: un reintento equivalente devuelve la misma respuesta sin crear
otra credencial y reutilizar la clave con otro cuerpo responde `409`. La respuesta se
conserva cifrada con una clave separada sólo durante 5 minutos por defecto; después
el mismo reintento responde `410`. La credencial se genera aleatoriamente y sólo su
HMAC permanece a largo plazo. Se usa así:

```text
Authorization: ApiKey bill_live_<prefix>.<secret>
```

Scopes disponibles: `documents:write`, `documents:read`, `received:sync`,
`received:read`, `issuers:manage` y `webhooks:manage`.

Las credenciales SUNAT y suscripciones webhook se configuran a través de la API
pública autenticada; la API deriva la organización y reenvía los secretos sólo al
servicio propietario mediante la red interna:

```text
PUT /api/v1/issuers/:issuerId/sunat-credentials
GET /api/v1/issuers/:issuerId/sunat-credentials
PUT /api/v1/webhook-subscriptions/:subscriptionId
GET /api/v1/webhook-subscriptions
```

## Generar un comprobante

`Idempotency-Key` es obligatorio. Los importes usan strings decimales para evitar
pérdida de precisión y el correlativo se devuelve como string por ser `bigint`.

```bash
curl -X POST http://localhost:3300/api/v1/fiscal-documents \
  -H "Authorization: ApiKey $BILLING_API_KEY" \
  -H "Idempotency-Key: pedido-2026-0001" \
  -H 'Content-Type: application/json' \
  -d '{
    "issuerId":"00000000-0000-4000-8000-000000000001",
    "seriesId":"00000000-0000-4000-8000-000000000002",
    "documentType":"01",
    "issueDate":"2026-08-22",
    "currency":"PEN",
    "customer":{"identityType":"6","identityNumber":"20100070970","legalName":"Cliente SAC"},
    "lines":[{"description":"Servicio mensual","unitCode":"NIU","quantity":"1","unitValue":"100.00","taxAffectation":"taxed","taxRate":"0.18"}]
  }'
```

La respuesta `202` incluye `statusUrl`. Los estados públicos son `queued`,
`processing`, `accepted`, `accepted_with_observations`, `rejected`, `failed`,
`void_pending` y `voided`. XML, ZIP, CDR, JSON y PDF se consultan mediante:

```text
GET /api/v1/fiscal-documents/:id/artifacts/:kind
```

## Sincronizar comprobantes recibidos

La solicitud también exige `Idempotency-Key`. La clave se aísla por organización y
emisor: repetir el mismo cuerpo devuelve el mismo recurso (`id`) sin crear otro comando;
reutilizarla con otro cuerpo responde `409` sin reflejar la clave ni el payload.

```bash
curl -X POST http://localhost:3300/api/v1/received-document-syncs \
  -H "Authorization: ApiKey $BILLING_API_KEY" \
  -H "Idempotency-Key: recibidos-2026-08-01-a-10" \
  -H 'Content-Type: application/json' \
  -d '{
    "issuerId":"00000000-0000-4000-8000-000000000001",
    "startDate":"2026-08-01",
    "endDate":"2026-08-10",
    "documentTypes":["01","03","07","08"]
  }'
```

El progreso se consulta en `GET /api/v1/received-document-syncs/:syncId`. Los
documentos importados se listan en `GET /api/v1/received-documents` y cada recurso
se consulta en `GET /api/v1/received-documents/:documentId`.

## Eventos webhook

Las suscripciones aceptan estos contratos versionados:

- `fiscal-document.processing.v1`, cuando Core confirma la publicación del comando SUNAT.
- `fiscal-document.accepted.v1`, `fiscal-document.rejected.v1`,
  `fiscal-document.failed.v1` y `fiscal-document.voided.v1`, al aplicar el resultado.
- `received-document.imported.v1`, una vez por cada documento recibido insertado por
  primera vez; los duplicados no vuelven a emitirlo.

Todos se crean primero en el outbox de Core y se entregan al menos una vez. El
receptor debe deduplicar por `eventId`.

## Comandos de desarrollo

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm audit:no-secrets
pnpm audit:no-python
```

Las migraciones usan `synchronize:false` y se ejecutan con `pnpm migration:run:all`.
No se debe apuntar una prueba de carga al endpoint beta SUNAT.

## Seguridad y migración

- Los secretos fuente locales son `0600` y Compose los monta de solo lectura en
  `/run/secrets`; en despliegues Compose deben pertenecer al UID/GID `1000:1000`
  del runtime Node, según `deploy/secret-templates/README.md`. No se cargan
  automáticamente desde `.env` ni se incluyen en jobs, respuestas o logs.
- Credenciales SOL, certificados y secretos webhook se cifran con AES-256-GCM y
  envelope encryption. SUNAT y webhook usan master keys diferentes, y cada API interna
  acepta un bearer exclusivo de su propio límite de servicio.
- Antes de publicar esta rama deben rotarse las credenciales expuestas por el
  historial anterior y reescribirse los refs afectados con un respaldo bare.
- La importación heredada es dry-run por defecto, verifica hashes y nunca borra la
  fuente. El PDF local huérfano queda reportado para cuarentena, no se convierte en
  un comprobante fiscal.
