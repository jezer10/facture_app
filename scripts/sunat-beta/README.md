# Primera prueba con SUNAT beta

Piloto de **factura 01**, una línea de servicio, PEN, pago al contado e IGV de 18%
como caso de prueba. No es un motor tributario general ni habilita producción.
Los importes de ejemplo no representan una venta registrada.

```bash
pnpm sunat:beta --config scripts/sunat-beta/example.json
```

Sin `--send` sólo genera el XML, lo firma, verifica la firma y crea el ZIP.
El ejemplo contiene identificadores de demostración; no son los datos del usuario.
Copia el JSON a `output/sunat-beta/config.json` y configura RUC, razón social,
cliente de prueba, fecha actual y un correlativo exclusivo de beta. La carpeta
`output/` está ignorada por Git. No introduzcas claves SOL en el JSON.

```bash
pnpm sunat:beta --config output/sunat-beta/config.json --send
```

El comando realiza un único `sendBill` al endpoint oficial **beta**, con usuario
`<RUC>MODDATOS` y la contraseña pública de prueba `MODDATOS`. Genera un certificado
autofirmado de dos días para cada ejecución y comprueba localmente la firma XML.
No utiliza el certificado fiscal ni la clave SOL de la empresa. El destino es
constante, rechaza redirecciones y no se puede configurar para producción.

Cada ejecución guarda en `output/sunat-beta/run-*`:

- Entrada, XML firmado y ZIP del comprobante.
- Certificado y clave privada de prueba dentro de un directorio privado.
- Respuesta SOAP y CDR XML/ZIP cuando SUNAT los devuelve.
- `result.json`, con el resultado y la huella SHA-256 del XML.

`accepted_beta` significa que la respuesta CDR de beta tiene código `0`;
**no da validez fiscal**, no acredita habilitación productiva ni verifica la firma
de SUNAT en la CDR. Se comprueba el nombre del archivo y la referencia al documento.
Los rechazos y fallos SOAP se conservan para diagnóstico. Ante timeout u otra
respuesta incierta, el estado es `unconfirmed`; no hay reenvíos automáticos.

## API distribuida y correo local

Para usar el servicio oficial beta desde la API, detén primero cualquier instancia
local y ejecuta:

```bash
SUNAT_BETA_ISSUER_RUC=20615234762 pnpm dev:beta
```

Esto inicia PostgreSQL, SQS local, MinIO y Mailpit, ejecuta migraciones y prepara un
certificado exclusivo de prueba. Swagger está en http://localhost:3300/api/docs
y la bandeja local en http://localhost:58025. `pnpm dev:local` conserva el simulador.
`GET /api/v1/health/mode` permite distinguir ambos modos.

Con un JSON beta configurado, el siguiente comando crea **una nueva factura** y
realiza un envío al servicio oficial (no lo uses como prueba de carga):

```bash
pnpm smoke:beta --config output/sunat-beta/config.json
```

El RUC del emisor es único. Para repetir la prueba con el emisor y la serie
existentes, conserva el archivo privado generado y ejecuta:

```bash
pnpm smoke:beta --config output/sunat-beta/config.json --reuse output/sunat-beta/api-access.json
```

Esto crea otra factura con el siguiente correlativo; no reenvía la anterior.

El flujo de la API guarda los artefactos en MinIO, genera el PDF con la plantilla
original y, cuando el documento está aceptado y tiene `customer.email`, captura
un correo en Mailpit con PDF, XML firmado y CDR ZIP. No envía correo a Internet.
El PDF y el mensaje identifican explícitamente la prueba sin validez fiscal.
`GET /api/v1/fiscal-documents/:documentId/email-delivery` devuelve el estado de
entrega con la misma autorización del documento. `sent` significa que el SMTP
local aceptó el mensaje, no que un cliente lo leyó.

El envío usa un registro persistente por documento. Ante una entrega SMTP incierta
queda `unconfirmed`, sin reintento automático para evitar duplicados. Antes de
reintentar manualmente hay que comprobar el buzón. Una respuesta incierta de SUNAT
tampoco se reenvía automáticamente: la conciliación recupera una respuesta ya
guardada; no consulta el servicio productivo.

El adaptador beta sólo permite factura 01 en PEN, una línea de cantidad 1, IGV
18%, sin descuentos y total máximo S/ 500, para el RUC configurado. Producción,
boletas, notas, bajas y un proveedor real de correo siguen pendientes. El modo
beta y Mailpit están bloqueados con `NODE_ENV=production`.

Pruebas locales sin red:

```bash
pnpm test:sunat-beta
```

Referencias:

- [Pautas oficiales de SUNAT beta](https://orientacion.sunat.gob.pe/12-pautas-servicio-beta).
- [Guías, esquemas y reglas de validación SUNAT](https://cpe.sunat.gob.pe/guias-y-manuales).
- [XMLDSig con xml-crypto](https://github.com/node-saml/xml-crypto).

No realizar pruebas de carga contra SUNAT beta.
