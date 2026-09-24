# Plantilla original recuperada

`templates/index.html` y `styles/output.css` se recuperaron sin modificaciones del
commit `185de78`, última versión anterior a la migración de la plataforma.
No reformatear estos dos archivos si se desea conservar la copia exacta.

El generador actual usa `original-invoice-template.ts` para adaptar el snapshot
fiscal a los campos originales. Inserta el CSS local en lugar del script CDN,
escapa los datos y conserva las tablas, medidas y estructura del diseño.
El rótulo cambia según factura, boleta o nota, y la moneda e identificación del
cliente se corresponden con los datos recibidos. Los campos ausentes de dirección
o nombre comercial se dejan vacíos. Detracciones se muestran cuando se proporcionan.

La plantilla original no incluye QR ni hash visible. El PDF recuperado conserva
esa disposición y los márgenes originales del generador Playwright (sin margen
adicional al padding del HTML). Los archivos deben acompañar al código compilado;
el Dockerfile los copia a las imágenes de ejecución, y el proceso arranca desde
la raíz del proyecto (`/app` en Docker).

Los PDF previamente guardados son inmutables: este diseño se aplica a las nuevas
generaciones. No cambia ni vuelve a emitir comprobantes existentes.
