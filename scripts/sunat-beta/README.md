# Primera prueba con SUNAT beta

Piloto de **factura 01**, una línea de servicio, PEN, pago al contado e IGV de 18%
como caso de prueba. No es un motor tributario general ni habilita producción.
Los importes de ejemplo no representan una venta registrada.

```bash
pnpm sunat:beta --config scripts/sunat-beta/example.json
```

Sin `--send` sólo genera el XML, lo firma, verifica la firma y crea el ZIP.
El ejemplo contiene identificadores de demostración; no son los datos del usuario.
Copia el JSON a `output/sunat-beta/config.json` y configura RUC, razón social,
cliente de prueba, fecha actual y un correlativo exclusivo de beta. La carpeta
`output/` está ignorada por Git. No introduzcas claves SOL en el JSON.

```bash
pnpm sunat:beta --config output/sunat-beta/config.json --send
```

El comando realiza un único `sendBill` al endpoint oficial **beta**, con usuario
`<RUC>MODDATOS` y la contraseña pública de prueba `MODDATOS`. Genera un certificado
autofirmado de dos días para cada ejecución y comprueba localmente la firma XML.
No utiliza el certificado fiscal ni la clave SOL de la empresa. El destino es
constante, rechaza redirecciones y no se puede configurar para producción.

Cada ejecución guarda en `output/sunat-beta/run-*`:

- Entrada, XML firmado y ZIP del comprobante.
- Certificado y clave privada de prueba dentro de un directorio privado.
- Respuesta SOAP y CDR XML/ZIP cuando SUNAT los devuelve.
- `result.json`, con el resultado y la huella SHA-256 del XML.

`accepted_beta` significa que la respuesta CDR de beta tiene código `0`;
**no da validez fiscal**, no acredita habilitación productiva ni verifica la firma
de SUNAT en la CDR. Se comprueba el nombre del archivo y la referencia al documento.
Los rechazos y fallos SOAP se conservan para diagnóstico. Ante timeout u otra
respuesta incierta, el estado es `unconfirmed`; no hay reenvíos automáticos.

El comando funciona separado del flujo distribuido de la API. Swagger y
`pnpm smoke:mock` continúan usando el simulador. La integración productiva,
boletas, notas, bajas y conciliación siguen pendientes.

Pruebas locales sin red:

```bash
pnpm test:sunat-beta
```

Referencias:

- [Pautas oficiales de SUNAT beta](https://orientacion.sunat.gob.pe/12-pautas-servicio-beta).
- [Guías, esquemas y reglas de validación SUNAT](https://cpe.sunat.gob.pe/guias-y-manuales).
- [XMLDSig con xml-crypto](https://github.com/node-saml/xml-crypto).

No realizar pruebas de carga contra SUNAT beta.
