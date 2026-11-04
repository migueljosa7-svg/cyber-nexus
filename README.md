# CYBER-NEXUS: OPEN WORLD PROTOCOL

RPG de acción cyberpunk de mundo abierto para navegador (PC y móvil). Three.js + Vite + TypeScript.
Ciudad procedural infinita, tráfico, peatones, misiones infinitas, hackeo por consola y combate con espada de energía.

## Comandos

```bash
npm install        # instala dependencias
npm run dev        # http://localhost:5173 (accesible desde el móvil en tu red local)
npm run build      # typecheck + build de producción en /dist
npm run preview    # sirve el build de producción
```

## Cómo se juega

1. Pulsa **NEW GAME**. Empiezas en una plaza con un contrato ya aceptado (registro de misión a la izquierda, marcador y minimapa).
2. **F / Enter** abre la consola de hackeo (en móvil, botón **HACK** + chips táctiles). Escribe `/help`.
3. `/scan` lista lo hackeable a 46 m: ciudadanos (`NPC-xx`), vehículos (`CAR-xx`, `FLY-xx`), quioscos (`TRM-xx`), puertas (`DOOR`), cámaras (`CAM`) y núcleos de misión.
4. `/hack [id]`, `/override [id]`, `/interrogate [id]` (a ≤ 14 m) abren un minijuego de descifrado por tiempo (secuencia, bytes o nodos). Cuestan RAM, que se regenera.
5. `/missions` muestra el tablón; `/accept n` acepta un contrato. Tipos: **hackear terminal central**, **eliminar al líder rival**, **robar un maletín y escapar sin ser detectado**, **interrogar a un informante**. Se generan infinitos y escalan con tu nivel.
6. Recompensas en créditos y XP; con los puntos de habilidad usa `/upgrade <hp|energy|ram|speed|damage>`.

| PC | Móvil |
| --- | --- |
| WASD mover · Ratón cámara | Joystick flotante izquierdo · arrastrar lado derecho = cámara |
| Click / J: combo de espada de energía (3 golpes) | ATK |
| Click derecho / K: disparo cinético | SHOT |
| Espacio: salto (doble) · Shift: dash con estela | JUMP · DASH |
| Q: pulso EMP · E: escudo de datos · R: ráfaga cuántica | EMP · SHLD · QNTM |
| F / Enter: consola de hackeo · P: pausa · F3: estadísticas | HACK |

El progreso (nivel, créditos, mejoras) se guarda solo en `localStorage` (CONTINUE).

## Arquitectura

```
index.html
src/main.ts               composición: pantalla de carga con progreso, sistemas en orden fijo, flujo de juego
src/core/engine.ts        bucle rAF, delta time, estados (loading/menu/playing/hacking/paused/gameover),
                          bus de eventos, calidad adaptativa (<55 FPS: resolución -> bloom -> sombras)
src/graphics/renderer.ts  WebGLRenderer, bloom HDR, aberración cromática, grano, sombras, entorno PMREM procedural
src/graphics/camera.ts    cámara 3ª persona con lerp, look-ahead, evasión de paredes, shake por trauma
src/world/city.ts         metrópolis: calles analíticas en shader, rascacielos con ventanas parpadeantes (InstancedMesh),
                          farolas parpadeantes, carteles holográficos, pasarelas, plazas, quioscos, lluvia en GPU
src/world/traffic.ts      coches y vehículos voladores: posición en el vertex shader (GPU), luces de freno dinámicas,
                          colisión AABB contra el jugador, hackeables (se detienen)
src/world/npcs.ts         peatones por aceras (8 InstancedMesh): caminar / huir / hablar / controlados, hackeables
src/player/player.ts      rig humano articulado (visor LED), inercia, doble salto, dash, combos, disparo, RPG
src/systems/missions.ts   generador procedural de misiones, sitios, cámaras con conos de detección, recompensas
src/systems/hacking.ts    consola: /hack /scan /override /interrogate /missions /upgrade ... + minijuegos
src/ui/hud.ts             HUD, minimapa circular, registro de misiones, marcadores 3D, consola CRT, controles táctiles
src/ui/minigame.ts        minijuegos de descifrado
src/combat.ts, src/enemies.ts, src/particles.ts, src/audio.ts, src/input.ts, src/transitions.ts
```

## Rendimiento

- ~110 draw calls y ~70-80k triángulos por frame con la ciudad entera: todo lo repetido es `InstancedMesh`.
- Tráfico y lluvia se animan en GPU; los chunks solo reescriben buffers de instancias (sin picos al cruzar chunks).
- Calidad adaptativa en `core/engine.ts` (muestrea cada segundo; baja con <55 FPS, sube tras una racha larga estable).
- F3 o `/?debug` muestra FPS reales, draw calls, triángulos, resolución, calidad y cambios automáticos.

## Despliegue en Vercel

```bash
git add .
git commit -m "CYBER-NEXUS: OPEN WORLD PROTOCOL"
git push origin main
```

Importa el repositorio en <https://vercel.com/new>: Vercel detecta Vite (Build `npm run build`, Output `dist`).
