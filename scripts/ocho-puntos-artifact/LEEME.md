# Artifact "Agente LK: 8 puntos"

Tablero de los 8 puntos que le faltan al bot para ser un agente (pedido de Pablo Olejavetzky, 13/10/2026: *"armame un artifact
con estos 8 puntos y andá dándoles el check cuando estemos ya ok"*). Plan completo: `docs/PLAN-AGENTE-8-PUNTOS-2026-10-13.md`.

- **Link:** https://claude.ai/artifact/DY3rYB4AtYejUZmEyE4VoG
- **Página:** `pagina.html`. No lleva datos: los lee de la base del artifact (capacidad `db`). Republicarla no borra los datos.
- **Quién escribe:** sólo el dueño y los editores (`rules: [{path:"", read:"view", write:"admin"}]`). Con permiso de uso o de lectura
  no se puede escribir (verificado el 13/10).

## Datos: colección `puntos`, un documento por punto (`p1` … `p8`)

| Campo | Qué es |
|---|---|
| `numero`, `nombre` | 1 a 8, en el orden de la lista original |
| `estado` | `ok` · `parcial` · `no` |
| `hoy` | Lo que hay hoy, en una o dos oraciones |
| `falta` | Lista de lo que falta (se oculta cuando `estado = ok`) |
| `criterio` | El "Ok cuando" del plan |
| `dueno`, `fecha_objetivo` | Quién y para cuándo |
| `fecha_ok` | ISO, cuando pasó a `ok` |
| `actualizado` | ISO, última escritura |
| `historial` | `[{fecha, texto}]`, un avance por línea (se muestra del más nuevo al más viejo) |

## Cuándo y cómo se tilda

Un punto pasa a `ok` **sólo** cuando cumple su `criterio`, medido (no "casi"). Cualquier sesión que cierre algo de un punto:

1. `ArtifactData` `get` del documento (lee la `version`).
2. `ArtifactData` `update` con `if_version`: `estado`, `falta` sin lo hecho, `actualizado`, `historial` con la línea nueva agregada
   al final y, si pasó a `ok`, `fecha_ok`.
3. Actualizar la sección 4 del plan si cambió el conteo.

Textos para el equipo: sin nombres de tablas ni de archivos (los lee gente de Ventas y gerencia).
