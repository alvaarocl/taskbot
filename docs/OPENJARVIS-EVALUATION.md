# Comparación de bucles de agente · 2026-10-18

30 peticiones sintéticas en español por bucle, mismo gateway de modelos y herramientas ficticias. Ninguna operación real en calendarios, correo o notas.

| Bucle | Herramienta esperada | Errores de ejecución | Mediana |
|---|---:|---:|---:|
| taskbot-loop | 28/30 | 0 | 1.80 s |
| openjarvis | 28/30 | 0 | 1.79 s |

La coincidencia de herramienta no verifica los argumentos ni la fidelidad de la respuesta. La revisión encontró afirmaciones no justificadas y fechas inconsistentes en respuestas de ambos bucles. Este resultado no demuestra superioridad de OpenJarvis, ni valida voz o conectores reales. Se mantiene Taskbot como núcleo activo.

La prueba de contratos separada obtuvo 60/60 con respuestas programadas; solo acredita compatibilidad del adaptador. El endpoint temporal de evaluación se desactiva tras la comparación.
