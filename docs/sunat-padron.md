# Consulta de RUC con padrón oficial

El formulario consulta `GET /api/v1/taxpayer-registry/:ruc` al completar un RUC válido. Requiere sesión, limita consultas y devuelve razón social, estado, condición, ubigeo, domicilio disponible y fecha del padrón. No verifica representación ni concede acceso a una empresa. Una ausencia en la copia no prueba que el RUC no exista.

La consulta usa SQLite de Node 24, indexado por RUC, separado de los datos operativos. No requiere una API comercial ni una clave. El archivo nacional no se carga completo en memoria ni se envía al navegador. Los campos de domicilio se componen de las columnas de SUNAT; «DEPARTAMENTO» en esa dirección se trata como unidad del inmueble, no como región. Un domicilio ausente queda pendiente de entrada manual.

## Descargar y actualizar

Ejecutar `pnpm ruc:import` en la raíz del proyecto. Requiere Node 24, `unzip`, conexión HTTPS y espacio disponible para el ZIP y la base nueva, además de la anterior si existe. Descarga el ZIP del dominio oficial y toma la fecha publicada en la página oficial. No es una consulta en tiempo real.

Por defecto publica `generated/sunat/padron.sqlite` (ignorado por Git). Se puede usar `SUNAT_PADRON_DB_FILE` o `--output /ruta/padron.sqlite`. Para importar un ZIP oficial ya descargado: `pnpm ruc:import --file /ruta/padron.zip --source-date YYYY-MM-DD`; la fecha debe corresponder al archivo, no al día de importación.

La importación usa una base temporal, verifica formato (omite hasta 100 filas irregulares y registra sus números de línea, abortando si se supera ese límite), mínimo de registros, integridad SQLite y resultado/CRC del descompresor; solo después reemplaza la copia activa mediante rename. Una importación fallida conserva la copia anterior. Un archivo `.lock` evita importaciones simultáneas: después de un cierre abrupto, comprobar que no hay otro proceso antes de retirarlo. La API detecta la publicación nueva sin reiniciar. Los lectores existentes pueden completar sus consultas sobre la copia anterior.

**Actualización manual en esta entrega.** Ejecutar el comando regularmente para mantener los datos al día. La interfaz muestra la fecha de la fuente y avisa cuando tiene más de siete días. No se instaló una tarea programada. En producción, importar en un volumen persistente y montar su directorio de solo lectura en la API; desplegar el código por sí solo no instala el padrón. Para varias instancias, publicar la misma versión en cada una.

Si no hay padrón o no puede consultarse, la interfaz ofrece reintentar o completar manualmente. Los borradores y la revisión siguen disponibles. Respuestas antiguas se descartan al cambiar de RUC; se preservan cambios manuales realizados durante la consulta.

Pruebas: `pnpm test:ruc-import`, pruebas Jest de `taxpayer-registry.service.spec.ts` y `node apps/billing-web/tests/ruc-browser.mjs` con Vite iniciado.
