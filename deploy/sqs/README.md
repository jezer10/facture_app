# Colas Amazon SQS

La aplicación usa SQS para comandos SUNAT, resultados, PDF y webhooks. PostgreSQL
conserva los datos y los registros inbox/outbox; R2 (MinIO local) conserva los
archivos. No se necesita Redis ni BullMQ.

## Desarrollo local

`pnpm dev:local` y `pnpm dev:beta` levantan LocalStack en `127.0.0.1:59324` y crean
cuatro colas y cuatro DLQ locales. La imagen comunitaria está fijada en 4.12.0
para que el arranque no requiera una cuenta de LocalStack. No usan credenciales ni recursos AWS. El emulador
no es prueba de compatibilidad con todos los comportamientos de AWS. Sus mensajes
son temporales: procesa las colas antes de reiniciar; no uses sus datos como un
entorno productivo. `SQS_ENDPOINT` está prohibido con `NODE_ENV=production`.

## Cuenta AWS

El aprovisionamiento actual usa `scripts/provision-sqs.mjs`, que valida la cuenta
con STS antes de cualquier cambio. Por defecto muestra un plan; con `--apply`
crea las colas ausentes y verifica las existentes. Si encuentra diferencias en
una cola existente, se detiene sin modificarla. No crea usuarios ni claves.

```bash
pnpm sqs:provision --profile aws-diagnostico --account TU_ID_DE_12_DIGITOS --region us-east-1
pnpm sqs:provision --profile aws-diagnostico --account TU_ID_DE_12_DIGITOS --region us-east-1 --apply
```

El prefijo predeterminado es `facture-beta`; puede cambiarse con `--prefix`.
El script limita el aprovisionamiento a `us-east-1`. En CI/CD puede omitirse
`--profile` para usar la identidad OIDC del job; la cuenta esperada sigue siendo
obligatoria. Las colas usan SSE-SQS, requieren TLS y cada DLQ admite redrive sólo
desde su cola correspondiente. El script nunca purga ni elimina colas.

`queues.cloudformation.json` es una alternativa declarativa, **no el propietario
de las colas creadas por el script**. No despliegues ambas opciones con el mismo
prefijo: CloudFormation necesitaría importar los recursos existentes. La
validación con cfn-lint/cfn-guard de esa alternativa sigue pendiente. Sus tres
políticas de ejecución son una referencia para las identidades separadas del
worker, SUNAT y webhooks; el script no crea ni asigna esas políticas IAM.

Configura en el despliegue:

```dotenv
AWS_REGION=us-east-1
SQS_ACCOUNT_ID=TU_ID_DE_CUENTA_DE_12_DIGITOS
SQS_QUEUE_PREFIX=facture-beta
```

No configures `SQS_ENDPOINT` en AWS. El SDK usa su cadena estándar de credenciales.
En desarrollo con AWS puedes seleccionar `AWS_PROFILE`. En CI/CD usa OIDC para el
rol de despliegue; ese rol no es la identidad de los procesos del servidor.

El Compose del servidor monta un archivo de credenciales AWS independiente por
servicio: `aws_worker_credentials`, `aws_sunat_credentials`,
`aws_webhook_credentials` en `SECRET_DIR`. El formato es el estándar de AWS con
sección `[default]`, `aws_access_key_id`, `aws_secret_access_key` y, para sesiones,
`aws_session_token`. Protege los archivos con modo 0600 y propietario 1000:1000;
no los subas al repositorio. Las credenciales temporales requieren renovación:
un inicio de sesión local de 12 horas no constituye autenticación permanente del
servidor. Para credenciales renovables mediante un proveedor externo, adapta el
mount al proveedor/rol elegido antes de desplegar.

Los permisos y el acceso real se verifican en la cuenta elegida antes del corte.
Un despliegue del backend no convierte SUNAT beta en emisión fiscal productiva.

## Entrega, reintentos y errores

- SQS Standard entrega al menos una vez y no garantiza orden. `eventId` mantiene
  la idempotencia en los inbox/ledger de PostgreSQL; no confíes en el ID de SQS.
- Sólo se elimina el mensaje tras completar el procesamiento durable. Si falla
  la confirmación, la entrega repetida recupera el resultado persistido.
- Hay un long poll de 20 segundos por cola/instancia. Cada lote respeta la
  concurrencia del consumidor. Evita consumidores o consultas de salud excesivos:
  las consultas vacías y de atributos también consumen solicitudes facturables.
  La salud de las colas se reutiliza hasta cinco minutos; un fallo de polling
  invalida esa caché. Los consumidores activos la actualizan con cada recepción.
- La visibilidad inicial es 120 segundos y se renueva cada 40 segundos. Los
  reintentos usan visibilidad con backoff exponencial de hasta 15 minutos.
- La conciliación se publica con un retraso SQS de hasta 15 minutos. Un comando
  con lease activo se aplaza cinco minutos; una entrega no roba un lease activo.
- Los errores permanentes, mensajes inválidos o intentos agotados van a su DLQ
  antes de eliminar el original. Los fallos de ese traspaso no descartan trabajo.
  AWS aporta además redrive tras 20 recepciones como respaldo ante caídas.
- Las colas principales retienen cuatro días; las DLQ, catorce. Monitoriza las DLQ
  y la edad del mensaje más antiguo. Un mensaje en DLQ requiere diagnóstico y
  reenvío deliberado; nunca purgues ni reenvíes automáticamente ventas inciertas.
- El correo sigue su registro persistente en PostgreSQL y el capturador Mailpit
  en beta. No era una cola BullMQ; esta migración no activa correo externo.

## Corte desde Redis

1. Detén nuevas emisiones, conserva un respaldo de PostgreSQL y espera a que las
   colas BullMQ estén vacías (incluye trabajos retrasados y fallidos).
2. Revisa cualquier resultado SUNAT ambiguo o trabajo fallido antes del cambio.
3. Provisiona SQS y credenciales, despliega los servicios coordinadamente y
   verifica salud, una emisión beta, artefactos y correo.
4. Reactiva emisiones. Conserva el volumen Redis anterior hasta verificar que
   no queda trabajo pendiente; los mensajes ya enviados a Redis no se migran solos.

No ejecutes consumidores BullMQ antiguos junto a los nuevos consumidores SQS.
No borres los inbox/outbox ni reinicies correlativos para hacer el cambio.
