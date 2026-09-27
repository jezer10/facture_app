# Diseño de Facture Web

Interfaz operativa en español para consultar y emitir comprobantes. La pantalla inicial es el listado, sin métricas artificiales. Tema claro acordado con el usuario: fondo cálido, superficies blancas, texto oscuro y verde reservado a acciones y marca. Manrope se sirve localmente.

La navegación lateral contiene Facturas y Conexión; en móvil se convierte en una franja superior. Formularios con etiquetas visibles, botones de al menos 44 px, tabla desplazable dentro de su contenedor y estados textuales además del color. El entorno de pruebas es visible en todas las pantallas.

La unidad reutilizable es la clase semántica con Tailwind `@apply`. Tema en `src/styles/tokens.css`, patrones comunes en `components.css`, detalles propios en estilos scoped con `@reference`. Evitar estilos inline y cadenas extensas de utilidades en plantillas.

No confundir los estados de conexión, carga, ausencia de comprobantes y error. No mostrar datos ficticios cuando no hay acceso. La lógica de permisos y los cálculos definitivos pertenecen al servidor.
