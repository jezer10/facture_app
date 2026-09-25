# SUNAT boundary

Este módulo consume `billing.sunat.commands.v1` y publica resultados en
`billing.sunat.results.v1`. Los jobs contienen identificadores, referencias R2 y
SHA-256; nunca credenciales SOL, certificados ni contraseñas.

## Modos

- `mock`: proveedor y firma simulados, con payloads/artefactos en R2 y ledger/journal
  en `billing_sunat`. `SUNAT_MOCK_ALLOW_ANY_ISSUER=true` habilita emisores dinámicos
  sólo fuera de producción. Los adapters en memoria quedan reservados a pruebas que
  invoquen `SunatModule.forMock()` explícitamente.
- `production`: usa persistencia, R2 y sobres cifrados con
  `BILLING_MASTER_KEY_FILE`. Los endpoints oficiales son configurables mediante
  `SUNAT_BILL_SERVICE_URL` y `SUNAT_CONSULT_SERVICE_URL`; el timeout usa
  `SUNAT_TIMEOUT_MS`.

## Bloqueo productivo intencional

La firma XMLDSig desde PKCS#12 y las operaciones SOAP/ZIP/CDR (`sendBill`,
`sendSummary`, `getStatus` y consulta de recibidos) permanecen **fail-closed**.
El repositorio no incluye aún una implementación verificable contra fixtures
oficiales SUNAT. Por ello, el provider y el signer productivos reportan `ready=false`
y el health devuelve `productionCapable=false`; ninguna respuesta simulada se marca
como fiscalmente válida.

Referencias oficiales usadas para fijar los endpoints y nombres de operación:

- <https://cpe.sunat.gob.pe/sites/default/files/inline-files/Manual_Programador_Sunat_v2.1.pdf>
- <https://cpe.sunat.gob.pe/node/88>

## Provisioning interno

`PUT /internal/issuers/:issuerId/sunat-credentials` rota credenciales versionadas.
El bearer interno es la representación `base64url` de los bytes almacenados en
`SUNAT_INTERNAL_SERVICE_SECRET_FILE`. La respuesta contiene sólo metadata; los secretos se
cifran mediante `EnvelopeEncryption` antes de llegar a PostgreSQL.
