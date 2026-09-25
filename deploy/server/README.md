# Despliegue de la beta

La API, los tres procesos de trabajo y PostgreSQL corren en el servidor Ubuntu
ARM64. Los archivos están en el bucket privado R2 `facture-beta-private`, y los
mensajes en las cuatro colas SQS `facture-beta-*` y sus cuatro DLQ. Cloudflare
Tunnel publica únicamente la API en `https://facture.jzrzr.com`, sin cambiar el
proxy de otras aplicaciones ni abrir puertos adicionales.

Esto sigue siendo **SUNAT beta, sin validez fiscal**. El correo se captura en
Mailpit; no se entrega a clientes externos. El override `compose.beta.yaml`
selecciona explícitamente beta y no debe utilizarse para emisión real.

## Pipeline

Cada push a `master` ejecuta validaciones y pruebas; sólo si pasan, construye
imágenes ARM64 `runtime`, `runtime-worker` y `migrations` en GHCR, etiquetadas con
el SHA del commit. Luego las despliega por SSH desde el entorno GitHub `beta`.
Los PR y `develop` sólo ejecutan validaciones. No hay despliegue fiscal productivo.

Secretos GitHub del entorno `beta`: `DEPLOY_SSH_KEY` (clave dedicada) y
`DEPLOY_KNOWN_HOSTS` (identidad SSH verificada). Variable: `DEPLOY_HOST`.
La autenticación de GHCR usa el GITHUB_TOKEN temporal del job, entregado por
stdin y eliminado del servidor al terminar. No se almacenan claves AWS, R2 ni
claves SOL en GitHub.

El servidor conserva:

- `/srv/facture/server.env`: configuración, tomando `server.env.example` como base.
- `/srv/facture/secrets`: secretos fuera del repositorio. Los procesos Node usan
  UID 1000 y archivos 0600. La carpeta anfitriona es 0700. El token de túnel es
  legible para el usuario del contenedor cloudflared y sólo se monta allí.
- `/srv/facture/releases/<SHA>`: Compose y scripts de cada versión.
- `/srv/facture/current`: enlace a la última versión que pasó la salud local.
- `/srv/facture/backups`: respaldo SQL previo a cada migración, protegido 0600.
  Revisa su tamaño y copia los respaldos fuera del servidor para cubrir pérdida
  del disco. Este pipeline no implementa retención ni recuperación ante desastre.

Las identidades IAM `facture-beta-worker`, `facture-beta-sunat` y
`facture-beta-webhook` sólo acceden a las colas necesarias. Sus claves se montan
en cada servicio por separado. No se usa la sesión root del desarrollador.
Los permisos se derivaron de IAM Policy Autopilot y se limitaron por cola y
servicio; no se concedió KMS porque estas colas usan SSE-SQS.

## Primera instalación

1. Crear las colas con `pnpm sqs:provision` en la cuenta prevista y preparar las
   tres identidades IAM. Guardar los archivos `aws_*_credentials` del Compose.
2. Generar secretos con `sh scripts/generate-development-secrets.sh <directorio>`.
   Crear un certificado autofirmado **sólo para beta** y guardar
   `beta_private.key` y `beta_certificate.pem`. Renovarlo antes de caducar.
3. Crear credenciales R2 limitadas al bucket y guardar los pares
   `r2_api_access_key_id`, `r2_api_secret_access_key`, `r2_worker_access_key_id`,
   `r2_worker_secret_access_key`, `r2_sunat_access_key_id`, `r2_sunat_secret_access_key`.
4. Configurar el túnel remoto hacia `http://billing-api:3000`, su token y el CNAME
   de la API. Verificar que `172.31.250.0/24` no choque con otras redes del host.
5. Preparar el entorno GitHub `beta` y hacer push a `master`. Comprobar el job
   completo y hacer una emisión beta antes de dar la instalación por terminada.

## Operación y recuperación

El script serializa despliegues con flock, descarga imágenes, respalda la BD,
detiene los consumidores, aplica migraciones y arranca servicios. Un error corta
el despliegue y no avanza `current`. Si falla tras detener servicios, requiere
intervención: consultar logs y resolver la causa antes de volver a ejecutar.
No se revierten esquemas automáticamente. Para volver a una imagen anterior,
confirmar primero su compatibilidad con el esquema actual y ejecutar el script
del SHA elegido con acceso temporal a GHCR. No restaurar un respaldo mientras
los consumidores estén procesando mensajes.

Mailpit queda en `127.0.0.1:58025`; se puede consultar mediante un túnel SSH.
PostgreSQL y los servicios internos no tienen puertos públicos. LocalStack,
MinIO y las credenciales locales nunca se usan en este despliegue.
