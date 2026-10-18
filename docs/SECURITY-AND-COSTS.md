# Seguridad y costes: operación

## Seguridad

- El webhook exige secreto y propietario de Telegram; panel con passkey/sesión, cookie Secure/HttpOnly/SameSite y comprobación de origen en cambios.
- Runtime con token propio, POST y objetos JSON de hasta 2 MB; no permite invocar shell. Los resultados requieren el lease del trabajo y tienen límite adicional.
- Las rutas públicas del transporte de voz antiguo se desactivan cuando se usa voz del runtime. Si se vuelve al legacy, revisar antes sus autorizaciones y servicio.
- Markdown restringido a carpetas explícitas, sin rutas padre, archivos ocultos ni extensiones distintas de Markdown. Escrituras versionadas y recuperables.
- Estado local privado (0700), credenciales 0600 y umask 077. La caché de resultados locales se limpia tras 24 horas. Las copias recuperables no se borran automáticamente por ese plazo.
- No registrar argumentos/resultados de herramientas, remitentes, asuntos ni cuerpos de errores remotos. Configurar observability=false en ambos Workers para no persistir invocaciones con URLs privadas.
- Estos cambios no borran retroactivamente logs ya retenidos por los proveedores. Ver sus plazos de conservación.
- Las conversaciones del bot, voz y consultas a modelos siguen pasando por servicios externos. Retención cero en un proveedor no elimina los datos operativos de Telegram, Gmail, D1/KV ni las notas del usuario.
- Correos y notas son contenido no confiable. El prompt exige tratarlos como datos, pero una defensa por instrucciones no garantiza ausencia de prompt injection.

## Coste

Comprobar el plan REAL en cada cuenta, no inferirlo del código ni usar una alerta como límite duro.

- Cloudflare: mantener Workers Free; las cuotas gratuitas son límites de funcionamiento, no una promesa de disponibilidad ilimitada. No activar planes de pago para resolver cuotas automáticamente.
- Groq: mantener Free. Los límites de gasto del plan de pago tienen retraso de medición y no equivalen a garantizar coste cero.
- Modal: plan Starter, límite de cargos explícito 0 y límite de uso no superior a créditos aplicables. Un límite de recursos o max_containers no sustituye el control de facturación. El almacenamiento tiene reglas propias: revisar volúmenes y no crear crecimiento ilimitado. Detener servicios legacy que ya no se utilizan.
- Google: mantener el proyecto sin facturación vinculada si no necesita servicios facturables; no solicitar ampliaciones de cuota de pago.
- GitHub: mantener presupuesto 0 con bloqueo para Actions, Packages, LFS y Codespaces. Revisar también otros productos de pago por uso.

Al agotarse las cuotas, algunas funciones pueden parar. Los dominios, Internet, electricidad del Mac y suscripciones previas quedan fuera de los costes incrementales del backend. Ningún archivo del repo puede garantizar para siempre las condiciones económicas o la seguridad de un proveedor.
