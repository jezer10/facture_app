# Facture Web

Panel de facturación en Vue 3, TypeScript, Vue Router y Tailwind CSS 4. Listado, emisión de facturas tipo 01, detalle, descargas y solicitud de anulación. Consume la API real; no incluye datos de demostración en la aplicación.

## Desarrollo

Desde la raíz del repositorio:

```sh
pnpm install --frozen-lockfile
pnpm dev:local # API e infraestructura local, en una terminal
pnpm dev:web   # interfaz, en otra terminal
```

Abre http://127.0.0.1:5173. Vite redirige `/api` a `http://127.0.0.1:3300`, sin habilitar CORS global. Para otro backend local, crea `apps/billing-web/.env` a partir de `.env.example`. No pongas credenciales en variables `VITE_*`.

En **Mi cuenta**, pulsa **Iniciar sesión**. El navegador abre el acceso central Cognito y vuelve al panel tras verificar tu cuenta. Las organizaciones disponibles dependen de tus membresías; una cuenta nueva no recibe acceso automático a datos. Los tokens quedan en el servidor y el navegador usa una cookie HttpOnly. Configuración y primera asignación: [identidad de desarrollo](../../deploy/identity/README.md).

La API debe tener las migraciones de sesiones e invitaciones aplicadas. Usa siempre `http://127.0.0.1:5173` para coincidir con el callback de Cognito. La sesión inicial dura hasta 15 minutos; al vencer, vuelve a iniciar sesión.

## Estructura

```text
src/
  app/                 # layout, rutas y página no encontrada
  components/ui/       # controles reutilizables, sin lógica de facturas
  features/
    invoices/
      api.ts           # llamadas tipadas de facturación
      calculation.ts   # estimación decimal del formulario
      format.ts        # moneda, fechas y etiquetas de estados
      components/      # editor de ítems, estado del comprobante
      views/           # listado, emisión y detalle
    session/           # sesión de navegador, organizaciones y entorno de la API
  lib/http.ts          # transporte, protección CSRF y errores comunes
  styles/
    tokens.css         # colores y tipografía del tema
    base.css           # elementos HTML, foco y accesibilidad
    components.css     # clases comunes mediante @apply
```

Los contratos se importan **solo como tipos** desde `libs/contracts/src/fiscal-documents.ts`; el frontend no importa servicios NestJS ni entidades de base de datos.

## Convenciones para modificarlo

- Cambia colores y tipografía en `styles/tokens.css`.
- Usa clases semánticas en las plantillas. Para estilos locales, usa `<style scoped>` con `@reference` al archivo `styles/main.css` y `@apply`. No importes Tailwind de nuevo dentro de componentes.
- Los componentes de `components/ui` reciben props y emiten eventos; no hacen solicitudes.
- Coloca cada nueva función de negocio en `features/<nombre>` con sus vistas y servicio API. No agregues un store global hasta necesitar estado compartido adicional.
- Conserva los importes como strings y utiliza Decimal para calcular. El servidor es la autoridad de los totales.
- La búsqueda por cliente/RUC/número se aplica **a la página visible**; estado y emisor filtran en el servidor. La API actual no ofrece búsqueda global.
- La emisión conserva clave de idempotencia y cuerpo idénticos ante errores inciertos. El formulario queda bloqueado para reintentar de forma segura; no recargues ni abandones un envío sin confirmar. No se persisten borradores.
- SUNAT beta permite un ítem gravado al 18%, cantidad 1, PEN y valor neto de hasta S/500. El backend valida el RUC autorizado. Anulaciones disponibles solo en simulación; beta no las implementa. La pantalla no habilita producción.

## Verificación

```sh
pnpm typecheck:web
pnpm build:web
pnpm test:web
pnpm --filter @facture/web format:check
# Con pnpm dev:web ejecutándose y Chromium de Playwright instalado:
node apps/billing-web/tests/browser.mjs
```

Las pruebas de navegador interceptan la API con fixtures exclusivos de pruebas: paginación, filtros, errores, creación con reintento idempotente, actualización de estado, descargas, anulación, restricciones beta y aislamiento de credenciales. No emiten comprobantes. Guardan capturas en `output/billing-web/` (ignorado por Git).

## Distribución

`pnpm build:web` genera `apps/billing-web/dist`. El servidor que lo publique debe servir las rutas de Vue con fallback a `index.html` y enviar `/api/*` al backend antes de ese fallback, bajo el mismo origen y HTTPS. `pnpm --filter @facture/web preview` permite revisar el build local en el puerto 4173. La imagen y el despliegue automático actuales siguen publicando los servicios backend; este cambio no publica el panel ni modifica el bloqueo fiscal de producción.
