# Widget de Taskbot para macOS

Widget nativo de WidgetKit para poner las tareas pendientes de Taskbot en el Centro de notificaciones o en el escritorio de macOS Sonoma o posterior. Consulta el Worker existente; no necesita otro servicio ni cambios en Cloudflare. Incluye tamaños pequeño, mediano y grande. Solo muestra tareas pendientes, cada una con un botón grande para marcarla como hecha; desaparecerá al recargar la lista. Las flechas permiten pasar de una página de tareas a otra.

## Generar y ejecutar

Necesitas Xcode y [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`). El proyecto de
Xcode no está en el repo: se genera.

1. Abre Terminal en esta carpeta.
2. Tus datos (ninguno de estos archivos se sube a git):

   ```sh
   cp Shared/TaskbotEndpoint.swift.example Shared/TaskbotEndpoint.swift   # y pon la URL de tu worker
   printf 'TASKBOT_BUNDLE_PREFIX = com.tunombre\nDEVELOPMENT_TEAM = TU_TEAM_ID\n' > Local.xcconfig
   xcodegen generate
   open TaskbotWidget.xcodeproj
   ```

   El Team ID sale en developer.apple.com → Membership (o en Xcode → Settings → Accounts).
3. En Xcode, inicia sesión con tu Apple Account (**Xcode → Settings → Accounts**). En **Signing & Capabilities** de
   los destinos `Taskbot` y `TaskbotWidgetExtension`, comprueba que el grupo de aplicaciones es
   `group.<tu prefijo>.taskbot` (sale solo de `TASKBOT_BUNDLE_PREFIX`). Una compilación sin firmar no registra el
   widget en macOS.
4. Ejecuta el esquema `Taskbot` en este Mac.
5. Abre Taskbot e introduce tu `DASH_TOKEN` de Cloudflare. Pulsa **Guardar clave**.
6. Añade el widget: abre el Centro de notificaciones, pulsa **Editar widgets**, busca **Taskbot** y elige el tamaño. En macOS puedes arrastrarlo al escritorio desde el Centro de notificaciones.

Al pulsar fuera de los botones, el widget abre el panel para consultar la lista completa. El widget consulta solo tareas `kind=tarea` con `status=pendiente` y actualiza su contenido aproximadamente cada 15 minutos, según el calendario de actualización de WidgetKit; al completar una tarea, WidgetKit vuelve a consultar la lista.

## Recordatorios (en las dos direcciones)

Cada 5 minutos, `RemindersSync.swift` mantiene la lista **«Taskbot»** de Recordatorios (en iCloud, así que sale en el iPhone y admite el widget de Recordatorios):
- cada tarea pendiente es un recordatorio, con fecha límite (y hora si viene de Moodle), prioridad (🔥 urgente = alta) y el hueco reservado en las notas;
- **marcarlo como completado** en el iPhone, el Mac o el widget → la tarea se marca hecha en taskbot;
- **escribir un recordatorio nuevo** en la lista → se crea la tarea en taskbot;
- completar o borrar la tarea en Telegram o en el panel → el recordatorio desaparece.

Cada recordatorio guarda su tarea en la URL `taskbot://item/<id>`. Borrar un recordatorio sin completarlo no borra la tarea: vuelve a aparecer en la siguiente pasada (para quitarla, complétala o bórrala en Telegram). La primera vez macOS pide permiso para Recordatorios (entitlement `com.apple.security.personal-information.calendars`).

## Copia automática a Apple Notes

La app **Taskbot.app** mantiene la nota **“Taskbot — Tareas pendientes”** con todas las tareas pendientes capturadas en Telegram, incluidas fecha, categoría y prioridad. Actualiza esa nota cada 5 minutos mientras el Mac está encendido y conectado. La primera vez, macOS pide permiso para que Taskbot controle Notas. La app se registra para abrirse al iniciar sesión; ese ajuste se puede cambiar en la ventana de Taskbot.

Para mostrarla como widget, añade el widget de **Notas** en el escritorio o Centro de notificaciones y selecciona la nota de Taskbot. La nota es una copia de solo lectura: marcar tareas como hechas se hace desde Telegram, el panel o el widget de Taskbot. En la ventana de Taskbot puedes forzar una sincronización inmediata y ver el estado.

Los widgets tienen un tamaño fijo y no admiten desplazar su contenido como una lista. Muestra hasta dos tareas en tamaño pequeño, tres en mediano y ocho en grande; usa las flechas para recorrer todas las páginas de tareas, o pulsa fuera de los botones para abrir Taskbot.

## Seguridad y límites

La clave se almacena en preferencias compartidas del grupo de apps en este Mac y se envía a la API por HTTPS usando el encabezado Authorization. No se incluye en el repositorio. Si rotas la clave, vuelve a guardarla en Taskbot. WidgetKit decide cuándo refrescar, por lo que los cambios pueden tardar en aparecer.
