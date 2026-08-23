# Secretos de despliegue

Crea un directorio ignorado, por defecto `deploy/secrets/local`, con archivos `0600`.
Docker Compose los expone dentro de cada contenedor como mounts de solo lectura en
`/run/secrets`, con acceso concedido únicamente a los servicios que los declaran:

- `postgres_admin_password`, `core_db_password`, `sunat_db_password`, `webhook_db_password`
- `redis_health_password`, `redis_worker_password`, `redis_sunat_password`, `redis_webhook_password`
- `jwt_secret`, `api_key_pepper`, `api_key_replay_key`
- `sunat_master_key`, `webhook_master_key`
- `sunat_internal_secret`, `webhook_internal_secret`
- `r2_api_access_key_id`, `r2_api_secret_access_key`
- `r2_worker_access_key_id`, `r2_worker_secret_access_key`
- `r2_sunat_access_key_id`, `r2_sunat_secret_access_key`

Cada archivo `*_master_key`, `*_internal_secret` y `api_key_replay_key` debe contener
32 caracteres UTF-8 o, preferiblemente, 32 bytes codificados en Base64. Las master
keys, el replay key y los secretos internos deben tener valores independientes: la API
monta ambos secretos internos y rechaza valores reutilizados, mientras que SUNAT y
webhook montan únicamente el suyo.
Las credenciales R2 deben corresponder a políticas privadas y de mínimo privilegio;
cada servicio puede montar archivos distintos bajo el mismo nombre dentro del
contenedor.

Si una instalación anterior ya tiene sobres cifrados con un único `master_key`, no lo
reemplace directamente por claves aleatorias: primero debe reenvolver cada dominio con
su nueva clave en una migración coordinada. Cambiar la clave sin reenvolver hace
irrecuperables las credenciales SUNAT y los secretos webhook existentes.

`api_key_replay_key` sólo protege respuestas de creación durante
`BILLING_API_KEY_REPLAY_TTL_SECONDS` (300 segundos por defecto). Para rotarla sin
romper reintentos en curso, espere al menos esa ventana con la emisión de API keys
detenida; el proceso periódico habrá eliminado entonces todos los sobres anteriores.

Compose conserva el propietario de los secretos respaldados por archivos. En el host de
despliegue, todos deben pertenecer al UID/GID `1000:1000`, que corresponde al usuario
`node` de la imagen fijada, y conservar modo `0600`:

```bash
sudo install -o 1000 -g 1000 -m 0600 /ruta/segura/valor \
  deploy/secrets/local/nombre_del_secreto
```

PostgreSQL arranca como `root`, copia únicamente sus cuatro secretos a `/run` con
propietario `postgres` y luego pierde privilegios. Redis también consume sus secretos
antes de perder privilegios. Así los archivos fuente no necesitan permisos globales ni
de grupo. Si se cambia la imagen base o su UID, se debe actualizar primero este contrato.

No copies secretos reales dentro de este directorio de plantillas ni dentro de Git.
