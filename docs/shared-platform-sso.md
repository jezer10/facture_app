# SSO de la suite: inventario y propuesta técnica

Fecha: 26 de septiembre de 2026. Estado: inventario, decisiones confirmadas e implementación local inicial; no describe un despliegue realizado. Alcance funcional confirmado en [identidad compartida](shared-platform-identity.md).

## Resultado del inventario

| Producto | Autenticación encontrada | Sesión actual | Cambio necesario |
| --- | --- | --- | --- |
| Facture | Cognito; formulario Vue con APIs nativas y alternativa OIDC con authorization code + PKCE | Cookie HttpOnly con identificador opaco; hash en PostgreSQL. Máximo 15 minutos, sin renovación | Usar el flujo OIDC para el acceso compartido; separar logout local/global y definir continuidad de sesión |
| sndr | Credenciales propias mediante login Basic y JWT locales | Access token en memoria del frontend; refresh en cookie; sesiones y renovación propias. Existe compatibilidad con el flujo bearer anterior | Añadir entrada OIDC en backend y enlace explícito de identidad con el usuario local; conservar autorización por empresa |
| brst | Better Auth 1.7.2, contraseña y proveedores opcionales. Authentik se utiliza para personal interno | Sesiones en PostgreSQL, cookie HttpOnly, duración configurada de siete días y actualización diaria; cookie cache desactivada | Añadir Cognito como proveedor para clientes, preservando Better Auth, usuarios y permisos de cuenta/sucursal |

Fuentes locales inspeccionadas (rutas hermanas relativas al repositorio Facture):

- [Facture: integración de identidad](../deploy/identity/README.md), [controlador](../libs/fiscal-core/src/auth/browser-auth.controller.ts), [sesiones](../libs/fiscal-core/src/auth/browser-session.service.ts), [configuración](../libs/fiscal-core/src/auth/browser-auth.config.ts).
- sndr: `../back/src/auth/interface/controllers/auth.controller.ts`, `../back/src/auth/infrastructure/services/auth-config.service.ts`, `../front/src/shared/services/authSessionService.ts` y `../front/src/features/auth/stores/authStore.ts`.
- brst: `../../brst/web/apps/backend/src/auth/auth-instance.ts`, `../../brst/web/apps/backend/src/auth/session-policy.ts`, `../../brst/web/apps/backend/package.json` y `../../brst/web/docs/authentik-backoffice.md`.

Estos valores son configuración de código, no comprobación de producción. No se consultaron usuarios, secretos, bases desplegadas ni recursos AWS. Las duraciones pueden diferir por entorno.

El código `platform-identity-sync` de brst sincroniza grupos de operadores internos desde Authentik: no es el núcleo de identidad empresarial de la suite. Debe permanecer separado del acceso de clientes.

## Arquitectura acordada e implementación inicial

La decisión posterior al inventario es **Cognito obligatorio, interfaz custom en Vue, backend NestJS y repositorio independiente**. Managed Login queda descartado como pantalla central. La arquitectura de la suite mantiene servicios independientes; no se introduce gestión de integrantes ni integración operativa.

Se creó el repositorio local hermano `../platform-identity`, con Vue, NestJS, PostgreSQL propio y `oidc-provider` como implementación mantenida de OIDC. Cognito valida las credenciales mediante sus APIs; el proveedor del servicio central establece la sesión común y emite códigos/tokens para los productos. No se creó un protocolo OAuth propio.

### Estado comprobado

- Compilación de NestJS y Vue y pruebas de protocolo sobre PostgreSQL real.
- Registro, confirmación/reenvío, recuperación y desafíos Cognito implementados; AWS simulado en pruebas, sin login real de una persona todavía.
- SSO y logout comprobados con tres clientes OIDC de prueba. Esto **no significa que sndr y brst reales ya estén integrados**.
- Adaptación opcional de Facture mediante `BILLING_IDENTITY_*`, con migración para access tokens centrales cifrados. Verifica firma, nonce e introspección y conserva permisos locales.
- No se modificó infraestructura AWS, no se desplegó y no se aplicó la migración en la base de Facture.

### Sesiones y revocación implementadas

La sesión central dura una hora y los tokens hasta 15 minutos. Se reinicia el flujo OIDC para reutilizar la sesión vigente; esta entrega no conserva refresh tokens. El logout local de Facture no cierra el proveedor. El global lleva a confirmación OIDC y revoca los grants de los productos de **ese navegador**. Cerrar todos los dispositivos es una capacidad distinta y no se afirma implementada.

Facture consulta introspección en cada resolución de sesión: una sesión revocada o de otro cliente no autoriza operaciones; si el proveedor está caído, la comprobación falla de forma cerrada. El cierre local sí puede eliminar la sesión sin disponibilidad del proveedor. El servicio soporta backchannel, pero cada producto debe implementar su receptor o introspección antes de garantizar revocación allí.

Las cookies son propias de cada origen, los tokens Cognito no llegan al navegador y la sesión central conserva identidad estable sin conceder empresas o roles. Las credenciales se recogen exclusivamente en la aplicación Vue central cuando el modo está activado.

El README del repositorio independiente contiene arranque, configuración y límites. El proyecto no se incorporó al workspace de paquetes de Facture.

## Identidades existentes

Usar `(issuer, subject)` como identidad externa estable y conservar los IDs locales referenciados por operaciones. Para Facture, preservar compatibilidad con `cognito:<poolId>:<sub>` mediante un mapeo explícito.

Para usuarios existentes de sndr y brst, proponer enlace desde una sesión local con reautenticación y un login central completado, verificando el control de ambas identidades. Las colisiones se resuelven de forma explícita; no fusionar cuentas por igualdad de correo ni copiar hashes de contraseñas a Cognito.

brst tiene habilitado account linking y proveedores de confianza. Al incorporar Cognito, revisar las rutas de enlace y no añadirlo a una política de fusión implícita por correo. Probar cuentas con el mismo correo, correo cambiado y proveedores distintos. Verificar el callback efectivo de la versión instalada: no copiar una ruta de documentación sin contrastarla con el router y las pruebas locales.

Un usuario nuevo puede obtener una identidad local sin empresa ni permisos. No crear automáticamente restaurantes, emisores, series o rol owner en el callback OIDC. El alta empresarial pertenece al onboarding autorizado.

## Contrato mínimo de empresa

SSO y reutilización empresarial son dos capacidades distintas de esta entrega. El primer recorrido de autenticación no demuestra por sí solo que la empresa se comparte.

El contrato mínimo debe devolver, para la identidad autenticada: `tenant_id`, nombre, estado de verificación, condición de owner y estado de onboarding por producto. El servidor filtra las empresas elegibles y vuelve a comprobar owner al activar. El correo o el `tenant_id` enviados por el navegador no acreditan esa condición.

La verificación aprobada es común. La activación por owner es idempotente por `(tenant_id, product)` y no requiere otra aprobación comercial. Cada producto mantiene su configuración operativa; no se crea emisor ni serie al verificar la empresa.

Elegir una sola autoridad de escritura para este registro mínimo y adaptar los productos por API. Puede extraerse del modelo actual de Facture sin migrar ahora la administración general de integrantes. Mantener mapas explícitos con organizaciones de Facture y empresas/cuentas de los otros productos; no deduplicar por RUC sin resolver representación y conflictos.

Para pendientes, proponer un espacio de prueba aislado ligado al solicitante y a la solicitud, sin apropiarse del tenant de una empresa ya existente. La verificación permite pasar a producción, pero no transforma operaciones de prueba en reales. El detalle de funciones básicas por producto sigue pendiente; no incluir sandbox conectado ni integraciones operativas.

## Entornos y callbacks

Facture documenta el callback de desarrollo `http://127.0.0.1:5173/api/v1/auth/callback` y retorno de logout a `/conexion`. Su aprovisionador actual fija ese origen. No usarlo sin adaptación para registrar los otros clientes o producción.

Para cada entorno, registrar: issuer del pool, dominio central, app client por producto, origen frontend/API, callback exacto y retorno permitido. Para sndr y brst, completar esa matriz con las rutas efectivamente implementadas; no asumir que el callback de Authentik de brst es el de Cognito. Los dominios finales siguen pendientes de comprobar.

Mantener pools/recursos de desarrollo y producción separados. Cualquier actualización de cliente Cognito debe leer y preservar su configuración existente. No modificar recursos AWS durante el inventario.

## Trabajo pendiente para completar la suite

1. Activar y comprobar el modo central en un entorno de desarrollo de Facture con una cuenta real, aplicando antes su migración. Mantener una transición explícita y reversible.
2. Incorporar brst, preservando Better Auth, Authentik interno, clientes móviles y vínculos existentes; no fusionar usuarios automáticamente por correo.
3. Incorporar sndr con sus sesiones, controles REST y WebSocket, incluyendo revocación central.
4. Implementar el servicio mínimo de empresas y la reutilización de verificación, onboarding de owner y sandbox por producto. No se completaron con la entrega del protocolo SSO.
5. Preparar clientes Cognito propios por entorno, dominio central HTTPS y operación antes de producción.

## Validación requerida antes de declarar SSO operativo

- Login en un producto y acceso a los otros sin volver a introducir credenciales dentro de la vigencia central.
- Callback rechazado por state/nonce incorrecto, código reutilizado, audiencia errónea o destino no permitido.
- Cierre local conserva las demás sesiones; cierre global las invalida dentro del plazo acordado, incluyendo WebSockets y carreras con refresh/callback.
- Una cuenta preexistente conserva sus datos al enlazarse; el mismo correo no provoca una fusión automática.
- Un no-owner no inicia onboarding; una empresa verificada se reutiliza sin revisión adicional; una pendiente no accede a producción.
- El acceso de operadores Authentik, los roles existentes de brst y los clientes móviles no se confunden con el nuevo acceso de clientes.
- Verificación contra el proveedor real en desarrollo, además de tests con mocks. No se ejecutó aún esa prueba en este inventario.

## Referencias oficiales consultadas

- [Cognito Managed Login y cookie central](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html).
- [Cognito logout](https://docs.aws.amazon.com/cognito/latest/developerguide/logout-endpoint.html).
- [Cognito GlobalSignOut y límites de invalidación](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_GlobalSignOut.html).
- [Better Auth Generic OAuth/OIDC](https://better-auth.com/docs/plugins/generic-oauth).

La documentación de Better Auth consultada corresponde a su sitio vigente; antes de programar se verifican firmas y rutas contra la versión 1.7.2 declarada en brst y su lockfile.

- [Implementación OIDC utilizada](https://github.com/panva/node-oidc-provider).
