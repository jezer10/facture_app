# Identidad central de desarrollo

Para los límites del núcleo común, el backoffice y el SSO pendientes, consulta [la arquitectura objetivo](../../docs/shared-platform-identity.md). Este documento describe la integración disponible en Facture.

Cognito es el directorio compartido de personas. Facture es su primer cliente OIDC; sndr mantiene por ahora su login y base de usuarios. Esta integración no migra ni enlaza cuentas de sndr automáticamente.

## Recursos AWS

- User Pool `platform-identity-dev`, región `us-east-1`, plan Essentials.
- App client confidencial `facture-web-dev`, authorization code + PKCE.
- Managed Login v2 con estilo predeterminado por cliente.
- Callback `http://127.0.0.1:5173/api/v1/auth/callback`.
- Logout `http://127.0.0.1:5173/conexion`.

El aprovisionador usa AWS CLI y comprueba la cuenta antes de escribir. Por defecto solo muestra el plan; `--apply` crea los recursos que faltan. No envía invitaciones por correo ni crea usuarios. Conserva los recursos existentes y habilita el acceso nativo mediante una actualización que preserva las demás propiedades del cliente. Los costes siguen el plan Cognito y su uso; no se ha configurado autenticación M2M de Cognito.

```sh
node scripts/provision-identity.mjs --profile <perfil> --account <cuenta>
node scripts/provision-identity.mjs --profile <perfil> --account <cuenta> --apply
```

Guarda la configuración y el secreto del cliente en `deploy/secrets/local/`, ignorado por Git. `pnpm dev:local` carga únicamente las cinco variables de identidad permitidas de `identity-config.json`. Nunca utiliza ni expone claves AWS para autenticar al usuario.

## Arranque y primera cuenta

```sh
pnpm dev:local
pnpm dev:web
```

Abre **http://127.0.0.1:5173/conexion** (usa ese host exacto, no `localhost`). Usa el formulario Vue para iniciar sesión o crear tu cuenta y verificar el correo. Cognito gestiona la identidad; el formulario permanece en Facture. Una cuenta sin membresías muestra «Aún no tienes una organización asignada» y no puede consultar ni emitir facturas.

Para el administrador de desarrollo, un operador puede preparar acceso **exclusivamente en la base local**:

```sh
node scripts/grant-development-access.mjs --email <correo-administrador>
node scripts/grant-development-access.mjs --email <correo-administrador> --apply
```

Crea o reutiliza `Plataforma · Desarrollo` y prepara una asignación de propietario con vigencia de siete días. No envía correos. La asignación se consume una sola vez, tras validar firma, issuer, cliente, vencimiento, nonce, coincidencia de subjects entre ID/access token y correo verificado por Cognito. La membresía se vincula a `cognito:<poolId>:<sub>`; eliminarla después no la recrea en otro login. Repetir el comando no renueva ni reasigna una invitación ya consumida. No concede administración global ni acceso a empresas existentes. El emisor y la serie se configuran aparte.

## Sesión y permisos

El módulo BFF está en `libs/fiscal-core/src/auth/browser-*`. Rutas:

- `GET /api/v1/auth/login`: genera state, nonce y PKCE; redirige a Cognito.
- `GET /api/v1/auth/callback`: consume el intento una sola vez y verifica ambos tokens mediante `aws-jwt-verify` y las claves públicas del pool.
- `GET /api/v1/auth/session`: estado de sesión, correo, token CSRF y organizaciones autorizadas, con `Cache-Control: no-store`.
- `POST /api/v1/auth/organization`: cambia la organización solo después de comprobar su membresía.
- `POST /api/v1/auth/logout`: elimina la sesión local y devuelve la URL fija de logout del proveedor.

Los tokens OIDC nunca se envían a Vue ni se persisten. La cookie contiene 32 bytes aleatorios; la base almacena su SHA-256. Usa HttpOnly y SameSite=Lax, y Secure con HTTPS. Las escrituras con cookie requieren Origin exacto y `X-CSRF-Token`. Se comprueba la membresía y el rol en cada solicitud; las cuentas del navegador nunca son administradores de plataforma.

Esta primera versión mantiene sesiones de **máximo 15 minutos**, limitadas además por el vencimiento de los tokens verificados. No implementa renovación: al vencer, se debe volver a iniciar sesión; Cognito puede reutilizar su sesión central. No hay cierre remoto inmediato de otras sesiones/aplicaciones; sus sesiones locales expiran de forma independiente. La eliminación de membresías en Facture sí se refleja en la siguiente petición. Los intentos y sesiones vencidos se purgan al iniciar otro login.

Los bearer JWT administrativos existentes y las API keys de integración permanecen compatibles para la transición. Las API keys siguen teniendo scopes y grants por emisor; el panel dejó de pedirlas.

## Configuración del servidor

```text
BILLING_COGNITO_POOL_ID=<pool>
BILLING_COGNITO_CLIENT_ID=<client>
BILLING_COGNITO_DOMAIN=https://<dominio-cognito>
BILLING_COGNITO_CLIENT_SECRET_FILE=/ruta/privada/cognito_client_secret
BILLING_WEB_ORIGIN=http://127.0.0.1:5173
```

Fuera de desarrollo local, el origen exige HTTPS. Todo el panel y `/api` deben compartir origen mediante proxy. El secreto vive exclusivamente en el backend (archivo 0600 o secreto Compose de solo lectura). Esta configuración está preparada para desarrollo: no publica el panel ni cambia el despliegue beta existente. No usar callbacks locales para un cliente productivo; crear otro entorno y registrar sus URLs exactas.

## Incorporación de sndr

Registrar otro app client en el mismo pool de desarrollo permite compartir la sesión de Managed Login. Antes de cambiar sndr: mapear sus usuarios a `(issuer, sub)`, definir la fuente de membresías y la identidad común de organizaciones, y migrar credenciales por un flujo revisado. No compartir secretos JWT, cookies de aplicación ni bases de datos. Las organizaciones de Facture siguen siendo locales a su dominio hasta acordar ese contrato común. La conexión CRM → API fiscal puede seguir usando cuentas de servicio.

## Validación

`pnpm test` incluye protección de callbacks, origen/CSRF, aislamiento por organización, asignaciones aprobadas y logout. `node apps/billing-web/tests/browser.mjs` comprueba la interfaz con respuestas controladas. La redirección a Managed Login se verifica contra AWS; completar el login de una cuenta real requiere que su titular se registre y verifique su correo.

## Acceso propio en Vue

La pantalla `/conexion` incorpora formularios propios para inicio de sesión, registro,
confirmación de correo, reenvío de código y recuperación de contraseña. Usa el mismo
user pool y conserva las cuentas existentes. El navegador llama a `/api/v1/auth/native/*`;
el BFF utiliza el SDK de Cognito con un cliente confidencial y `USER_PASSWORD_AUTH`.
`identity:provision --apply` habilita ese flujo mediante lectura y actualización de todas
las propiedades escribibles del cliente, conservando OAuth, URLs y duración de tokens.
No se necesitan credenciales IAM en el servidor para estas operaciones públicas de Cognito.

Las contraseñas solo transitan en la solicitud: no se guardan en base de datos, logs ni
almacenamiento web. Producción exige HTTPS. El backend verifica ambos JWT con JWKS y
crea la misma sesión HttpOnly de 15 minutos que usa el resto de Facture. No entrega
los tokens del proveedor al navegador ni conserva refresh tokens. La recuperación de
contraseña completada invalida las sesiones locales de ese correo en el mismo pool.

Las rutas de escritura exigen el Origin configurado y tienen límites por IP/ruta.
Cognito conserva sus controles propios de autenticación. Los códigos adicionales SMS,
TOTP, email y cambio de contraseña temporal se resuelven con intentos vinculados a
una cookie HttpOnly, almacenados en servidor, de un solo uso y con vencimiento de
3 minutos. Un código MFA erróneo requiere iniciar un intento nuevo. Inscripción de MFA,
federación y desafíos no soportados se derivan al acceso gestionado existente; nunca
se omite un desafío. Las claves, códigos y sesiones no deben registrarse en proxies/APM.

El formulario propio **no establece la cookie de managed login de Cognito ni implementa
SSO entre Facture y sndr**. Esta entrega autentica Facture con la identidad compartida.
Para acceso único entre aplicaciones falta desplegar el servicio central de identidad y
un protocolo de intercambio de sesión/código por aplicación (OIDC mediante un proveedor
adecuado, o conservar managed login para el SSO). No compartir cookies de Facture entre
dominios ni enviar su token en URLs. sndr y los permisos de backoffice no se modifican.

Pruebas de UI: `node apps/billing-web/tests/native-auth-browser.mjs` con Vite iniciado;
usa respuestas simuladas y no envía correos. Pruebas del servidor en `native-auth.*.spec.ts`.

## Acceso central local activado

El arranque local admite las cuatro variables `BILLING_IDENTITY_*` en
`deploy/secrets/local/identity-config.json` y exige el conjunto completo.
Facture en `http://127.0.0.1:5173/conexion` inicia el acceso en la aplicación
independiente `http://127.0.0.1:5180`; ambos servicios deben estar ejecutándose.
La configuración local actual activa ese modo. La migración de tokens cifrados
ya está aplicada en la base local; no se modificó producción.
