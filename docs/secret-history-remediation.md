# Reescritura segura del historial

Este procedimiento no debe ejecutarse hasta confirmar que el token SUNAT y todas
las credenciales relacionadas fueron revocados o rotados. La reescritura cambia los
hashes y exige que todos los colaboradores recreen sus clones.

## Inventario verificado

- Commit con token embebido en `src/main.py`:
  `7e00b237b86da5c48878ae83b62056a7bfa90832`.
- PDFs fiscales: `documento_dinamico.pdf` y `src/generated/reporte.pdf`.
- `node_modules/` también fue versionado históricamente y debe retirarse.
- Refs locales/remotos observados: `master`, `origin/master` y la rama de trabajo
  `feat/billing-platform-foundation`; no había tags.

No se guarda ni se vuelve a imprimir el valor del token durante la remediación.

## Ejecución coordinada

1. Congelar pushes y terminar/respaldar cualquier trabajo local.
2. Crear un mirror bare de respaldo fuera del repositorio y comprobarlo:

   ```bash
   git clone --mirror git@github.com:jezer10/facture_app.git \
     /home/jzr/Documentos/personal/facture_app-history-backup-20260822.git
   git -C /home/jzr/Documentos/personal/facture_app-history-backup-20260822.git fsck --full
   ```

3. Crear un segundo mirror de saneamiento, instalar `git-filter-repo` desde su
   distribución oficial y ejecutar sobre ese mirror:

   ```bash
   git clone --mirror git@github.com:jezer10/facture_app.git \
     /home/jzr/Documentos/personal/facture_app-sanitized.git
   cd /home/jzr/Documentos/personal/facture_app-sanitized.git
   git filter-repo --force --invert-paths \
     --path src/main.py \
     --path documento_dinamico.pdf \
     --path src/generated/reporte.pdf \
     --path node_modules
   ```

4. Verificar antes de cualquier push:

   ```bash
   git fsck --full --no-reflogs --unreachable
   git rev-list --objects --all | rg \
     '(^| )(src/main\.py|documento_dinamico\.pdf|src/generated/reporte\.pdf|node_modules/)'
   ```

   El segundo comando no debe devolver resultados. Además debe ejecutarse un
   escáner de secretos sobre todos los refs.

5. Tras una confirmación final de los refs exactos, publicar el mirror saneado con
   `git push --mirror --force`. Todos los clones antiguos deben archivarse o
   eliminarse y luego clonarse nuevamente; no deben hacer merge de la historia
   anterior.

El backup bare se conserva offline durante la ventana acordada y se trata como
material sensible porque aún contiene los objetos retirados.
