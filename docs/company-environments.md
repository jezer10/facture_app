# Ambientes de Facture por empresa

Facture es un solo producto. Sandbox es el ambiente de integración del cliente,
conectado a SUNAT beta. No existe un modo SUNAT simulado seleccionable.

## Aislamiento

Cada solicitud de empresa (`company_registrations.id`) enlaza dos espacios:

- `sandbox_organization_id`: se crea al enviar la solicitud, incluso mientras está pendiente.
- `organization_id`: espacio productivo nuevo, creado al aprobar la representación.

Cada espacio tiene su propio ID de organización, emisor, membresías, API keys,
series, correlativos, idempotencia, documentos, archivos y webhooks. La empresa se
identifica con `organizations.company_id`. El ambiente es inmutable en PostgreSQL.
Se aprovechan las claves foráneas compuestas y autorizaciones por organización ya
existentes; un header del cliente no puede cambiar el ambiente de una API key.

Dos personas que reclaman el mismo RUC reciben sandboxes privados distintos.
Solamente puede existir un emisor productivo por RUC. Aprobar una solicitud no da
acceso a espacios ajenos ni traslada operaciones de prueba a Producción.

Las organizaciones anteriores se conservan como Sandbox. Los espacios productivos
vacíos para solicitudes ya aprobadas se aprovisionan de forma idempotente al
consultar Mis empresas. Los documentos históricos no se modifican ni se renombran.
Una migración inversa rechaza eliminar el aislamiento de espacios ocupados.

## Acceso y configuración

`GET /api/v1/workspace` devuelve el ambiente autorizado, sus capacidades y los
correos verificados. Sesiones y JWT siguen sujetos a membresías. Una clave API
identifica exclusivamente su espacio; el contrato `/api/v1` es igual para ambos.

El selector Empresa y ambiente está en la cabecera. Se deshabilita mientras se
redacta un comprobante para evitar cambiar el destinatario de una operación en
curso. Cambiar de espacio descarta los datos y secretos en memoria de las vistas.

En Configuración se pueden crear/revocar claves de integración y configurar
webhooks HTTPS. Las claves nuevas tienen permisos de lectura/escritura de
comprobantes; no administran credenciales SOL. Las credenciales SOL/certificado
solo se aceptan en el emisor productivo y se cifran en el servicio SUNAT. Guardarlas
no equivale a verificar una conexión productiva.

## Ciclo de Sandbox

El adaptador UBL 2.1 soporta factura, boleta, nota de crédito y nota de débito,
PEN/USD, varias líneas/cantidades y operaciones gravadas, exoneradas e inafectas.
Las notas deben referir un comprobante aceptado del mismo espacio/emisor. Las
operaciones gratuitas y regímenes especiales no forman parte del XML validado de
esta entrega y son rechazados; no se presume cobertura tributaria universal.

La emisión usa `sendBill`; las bajas de series F usan comunicación RA y las de
series B un resumen RC con condición 3. Los correlativos de resúmenes se reservan
en PostgreSQL. Se guarda la intención antes de enviar, se conserva el ticket y
se consulta `getStatus`. Solo una CDR aceptada cambia el estado a anulado. La CDR
de baja se conserva como `void-cdr`, separada de la CDR original.

Un timeout o respuesta no interpretable no habilita reenvíos automáticos. Para
emisiones sin ticket, beta no ofrece aquí una consulta alternativa: se recupera
una respuesta guardada o se requiere revisión. La consulta de recibidos sigue
sin soporte en beta y no se anuncia entre las capacidades del espacio.

Los PDFs y correos de Sandbox están marcados sin validez fiscal. La evidencia
real de beta no demuestra validez fiscal ni habilitación productiva.

## Correo incluido

La empresa no necesita SMTP propio. El operador configura un remitente compartido:

- `BILLING_EMAIL_MODE=smtp`
- `BILLING_SMTP_HOST`, `BILLING_SMTP_PORT` (465 TLS o STARTTLS obligatorio)
- `BILLING_SMTP_USER`, `BILLING_SMTP_PASSWORD_FILE` (archivo privado)
- `BILLING_EMAIL_FROM` (dominio autorizado por el proveedor)

Sandbox solo permite enviar al correo verificado del solicitante. La comprobación
se repite antes del envío; escribir otra dirección en el comprobante no la verifica.
La gestión de verificaciones adicionales queda pendiente. Sin proveedor configurado
se informa que el correo está deshabilitado. En desarrollo Mailpit captura los
mensajes y no se envían a Internet. Una entrega SMTP incierta queda sin reintento
automático para evitar duplicados.

## Validación realizada (2026-09-27)

SUNAT beta devolvió CDR código 0 para factura, boleta, nota de crédito y nota de
débito; también aceptó RA y RC consultados mediante sus tickets. El servicio
intercaló respuestas HTTP 401 HTML: se conservaron como respuestas no confirmadas,
no como aceptación. No se hicieron pruebas de carga.

Se verificó además el recorrido API → SQS → SUNAT beta → CDR → PDF → Mailpit y la
idempotencia de la emisión. PostgreSQL comprobó aislamiento de lectura, creación
por solicitud pendiente, reclamaciones duplicadas sin acceso ajeno y correlativos
productivos independientes. Pruebas de navegador cubren emisión, notas disponibles,
cambio de ambiente, secretos sin persistencia en navegador, configuración y móvil.

## Producción pendiente

La emisión productiva permanece bloqueada: el adaptador directo y la firma PKCS#12
no tienen todavía la implementación fiscal verificada que exige su contrato.
No basta con subir credenciales. La política de Core rechaza emisión/bajas
productivas antes de reservar números o encolar envíos, aunque la empresa esté
aprobada. Completar y verificar ese adaptador es trabajo pendiente; esta entrega
no debe anunciarse como emisión productiva terminada.

Referencias: [pautas beta](https://orientacion.sunat.gob.pe/12-pautas-servicio-beta),
[manuales SUNAT](https://cpe.sunat.gob.pe/guias-y-manuales).
