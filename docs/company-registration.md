# Registro y verificación de empresas

Este documento describe la implementación actual en Facture. Su evolución hacia un núcleo común y un backoffice independiente está en [Identidad y empresas compartidas](shared-platform-identity.md).

La pantalla `/empresas` permite a una persona autenticada (aunque no pertenezca a ninguna organización) guardar y retomar borradores, enviar una solicitud y consultar su decisión. El guardado sucede al continuar o al pulsar «Guardar y salir». Los campos tienen límites y se validan también en el servidor. El RUC se comprueba con su dígito de control y se consulta automáticamente una copia local del padrón oficial para autocompletar los datos disponibles. Se muestra la fecha de la copia; no es una consulta en vivo ni una verificación de representación. Ver [operación del padrón](sunat-padron.md).

## Autorización y estados

- `draft`: solo su solicitante puede leerlo o editarlo.
- `pending`: datos inmutables para revisión manual. No crea emisor, organización ni acceso y no reserva el RUC. Distintas personas pueden solicitar el mismo RUC.
- `approved`: un revisor independiente crea organización, membresía owner, emisor y serie en una única transacción. El usuario puede abrir la empresa desde Mis empresas.
- `rejected`: no otorga acceso. La persona puede preparar una solicitud nueva corregida.

La sesión Cognito y CSRF protegen las rutas de solicitantes. El cliente no puede elegir sujeto, estado, organización ni aprobador. Las decisiones requieren el rol **platformAdmin**, que las sesiones web no reciben. Ser owner de una organización no da permiso de revisión. El solicitante no puede aprobarse a sí mismo.

## Procedimiento de revisión inicial

La operación de revisión es administrativa por API; no hay panel de revisores en esta entrega. No se envían correos automáticos. La persona consulta el estado y la nota en Mis empresas.

1. `GET /api/v1/admin/company-registrations` con credencial administrativa obtiene la cola pendiente.
2. Contrastar RUC, razón social y domicilio con fuente oficial. Validar por un canal independiente que la persona tiene facultades para administrar la empresa y delegar acceso, no solamente para emitir un comprobante. Una declaración, una copia de ficha RUC, un correo verificado o conocer la clave de un usuario secundario no bastan por sí solos.
3. Si falta evidencia, coordinar su obtención por un canal seguro aprobado por el operador. La aplicación no admite cargas de documentos sensibles ni contraseñas. **Hasta establecer ese canal y completar la comprobación, mantener pendiente o rechazar; nunca aprobar por defecto.**
4. Registrar la decisión con `POST /api/v1/admin/company-registrations/:id/decision`. Cuerpo: `decision` (`approve`/`reject`), `note` (10–800 caracteres, visible al solicitante), `evidenceReference` (referencia interna, no documentos ni secretos), `registryChecked` y `authorityChecked`. Aprobar exige ambas comprobaciones y una referencia de al menos 10 caracteres. Esas casillas documentan la revisión humana; no sustituyen una comprobación real.
5. Toda presentación y decisión queda en `company_registration_events`. El evento conserva actor, fecha y referencia interna. La nota pública debe permitir corregir una solicitud rechazada sin divulgar datos ajenos.

Un RUC que ya tiene emisor **no se transfiere ni concede membresía**: la aprobación devuelve conflicto. El operador debe gestionar la reclamación con el administrador acreditado por un procedimiento separado. No se ha implementado transferencia automatizada ni recuperación de propiedad.

## Compatibilidad y operación

`POST /issuers` deja de permitir el alta directa y devuelve 403, evitando saltarse la revisión. Los emisores existentes permanecen sin cambios: esta entrega no certifica retroactivamente sus identidades. Los scripts antiguos de bootstrap que creaban emisores directamente deben usar datos de prueba ya provisionados o el flujo administrativo de revisión. `smoke:beta --reuse` sigue usando su emisor existente.

Tras aprobar se crea una serie nueva de factura (Fxxx), correlativo 1. No usar una serie previamente emitida en otro sistema. Certificados, credenciales y la conexión SUNAT se configuran por separado; la aprobación no acredita que esa integración esté lista. La organización de la empresa es distinta del espacio provisional de desarrollo. La selección de empresa vuelve a comprobar la membresía.

Validación local: `RUN_COMPANY_DB_TESTS=1 pnpm test --runTestsByPath libs/fiscal-core/src/companies/company-registration.integration.spec.ts` (PostgreSQL local iniciado, migraciones aplicadas, datos de prueba revertidos). UI: `node apps/billing-web/tests/companies-browser.mjs` con Vite iniciado; usa API simulada, no envía solicitudes reales.
