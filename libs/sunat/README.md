# SUNAT boundary

Este módulo consume `billing.sunat.commands.v1` y publica resultados en
`billing.sunat.results.v1`. Los jobs contienen identificadores, referencias R2 y
SHA-256; nunca credenciales SOL, certificados ni contraseñas.

## Ambientes

- `beta` (predeterminado): conexión oficial de pruebas, firma XMLDSig con certificado
  de prueba, UBL 2.1 para 01/03/07/08, bajas RA/RC, tickets, PDF y CDR. Admite un
  despliegue con `NODE_ENV=production`; eso no confiere validez fiscal al Sandbox.
- `production`: adaptador directo todavía bloqueado hasta completar su verificación.

No hay configuración de simulador. Los dobles de pruebas viven en `testing/doubles`
y no son exportados por el módulo público ni registrados por el servicio.
Ver [aislamiento y validación](../../docs/company-environments.md).

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
