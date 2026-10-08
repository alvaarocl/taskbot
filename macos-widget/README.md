# Widget de Taskbot para macOS

Widget nativo de WidgetKit para poner las tareas pendientes de Taskbot en el Centro de notificaciones o en el escritorio de macOS Sonoma o posterior. Consulta el Worker existente; no necesita otro servicio ni cambios en Cloudflare. Incluye tamaños pequeño, mediano y grande. Solo muestra tareas pendientes, cada una con un botón grande para marcarla como hecha; desaparecerá al recargar la lista. Las flechas permiten pasar de una página de tareas a otra.

## Generar y ejecutar

1. Abre Terminal en esta carpeta.
2. Pon la URL de tu worker (el archivo no se sube a git), genera el proyecto de Xcode y ábrelo:

   ```sh
   cp Shared/TaskbotEndpoint.swift.example Shared/TaskbotEndpoint.swift   # y edita la URL
   xcodegen generate
   open TaskbotWidget.xcodeproj
   ```

3. En Xcode, inicia sesión con tu Apple Account en **Xcode → Settings → Accounts**. Luego selecciona el proyecto y el mismo equipo de firma para los destinos `Taskbot` y `TaskbotWidgetExtension`. En **Signing & Capabilities**, activa **Automatically manage signing** y añade el grupo de aplicaciones `group.com.alvarocarpintero.taskbot` a ambos destinos. Xcode necesita acceso a la cuenta para generar los perfiles de desarrollo; una compilación sin firmar no registra el widget en macOS.
4. Ejecuta el esquema `Taskbot` en este Mac.
5. Abre Taskbot e introduce tu `DASH_TOKEN` de Cloudflare. Pulsa **Guardar clave**.
6. Añade el widget: abre el Centro de notificaciones, pulsa **Editar widgets**, busca **Taskbot** y elige el tamaño. En macOS puedes arrastrarlo al escritorio desde el Centro de notificaciones.

Al pulsar fuera de los botones, el widget abre el dashboard para consultar la lista completa. El widget consulta solo tareas `kind=tarea` con `status=pendiente` y actualiza su contenido aproximadamente cada 15 minutos, según el calendario de actualización de WidgetKit; al completar una tarea, WidgetKit vuelve a consultar la lista.

## Recordatorios (en las dos direcciones)

Cada 5 minutos, `RemindersSync.swift` mantiene la lista **«Taskbot»** de Recordatorios (en iCloud, así que sale en el iPhone y admite el widget de Recordatorios):
- cada tarea pendiente es un recordatorio, con fecha límite (y hora si viene de Aula Global), prioridad (🔥 urgente = alta) y el hueco reservado en las notas;
- **marcarlo como completado** en el iPhone, el Mac o el widget → la tarea se marca hecha en taskbot;
- **escribir un recordatorio nuevo** en la lista → se crea la tarea en taskbot;
- completar o borrar la tarea en Telegram/dashboard → el recordatorio desaparece.

Cada recordatorio guarda su tarea en la URL `taskbot://item/<id>`. Borrar un recordatorio sin completarlo no borra la tarea: vuelve a aparecer en la siguiente pasada (para quitarla, complétala o bórrala en Telegram). La primera vez macOS pide permiso para Recordatorios (entitlement `com.apple.security.personal-information.calendars`).

## Copia automática a Apple Notes

La app **Taskbot.app** mantiene la nota **“Taskbot — Tareas pendientes”** con todas las tareas pendientes capturadas en Telegram, incluidas fecha, categoría y prioridad. Actualiza esa nota cada 5 minutos mientras el Mac está encendido y conectado. La primera vez, macOS pide permiso para que Taskbot controle Notas. La app se registra para abrirse al iniciar sesión; ese ajuste se puede cambiar en la ventana de Taskbot.

Para mostrarla como widget, añade el widget de **Notas** en el escritorio o Centro de notificaciones y selecciona la nota de Taskbot. La nota es una copia de solo lectura: marcar tareas como hechas se hace desde Telegram, el dashboard o el widget de Taskbot. En la ventana de Taskbot puedes forzar una sincronización inmediata y ver el estado.

Los widgets tienen un tamaño fijo y no admiten desplazar su contenido como una lista. Muestra hasta dos tareas en tamaño pequeño, tres en mediano y ocho en grande; usa las flechas para recorrer todas las páginas de tareas, o pulsa fuera de los botones para abrir Taskbot.

## Seguridad y límites

La clave se almacena en preferencias compartidas del grupo de apps en este Mac y se envía a la API por HTTPS usando el encabezado Authorization. No se incluye en el repositorio. Si rotas la clave, vuelve a guardarla en Taskbot. WidgetKit decide cuándo refrescar, por lo que los cambios pueden tardar en aparecer.
