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

## Publicación por carpeta (CrazyGames)

- `npm run build` genera `dist/` con rutas **relativas** (`base: './'`): se puede subir la carpeta tal cual, desde cualquier subruta o iframe.
- `index.html` incluye el SDK oficial de CrazyGames v3 con `async` + `onerror`, y `sdk.ts` lo espera con tiempo límite (8 s). Con adblock, sin red o si `init()` no responde, el juego arranca y se juega al 100 %: los anuncios quedan desactivados y **nunca** se concede recompensa sin anuncio. Si el SDK carga pero indica `environment: 'disabled'` (fuera de la plataforma) se usa el simulador local.
- Resiliencia: `src/errors.ts` instala `error` / `unhandledrejection`; un fallo **durante el arranque** (o falta de WebGL2) muestra un panel de recuperación (RELOAD / RELOAD · LOW GRAPHICS) en vez de pantalla en blanco; tras el arranque los errores solo se registran. Cada sistema del bucle y el render están aislados con try/catch, y `localStorage` bloqueado se tolera.

## Cómo se juega

1. Pulsa **NEW GAME**. Empiezas en una plaza con un contrato ya aceptado (registro de misión a la izquierda, marcador y minimapa).
2. **F / Enter** abre la consola de hackeo (en móvil, botón **HACK** + chips táctiles). Escribe `/help`.
3. `/scan` lista lo hackeable a 46 m: ciudadanos (`NPC-xx`), vehículos (`CAR-xx`, `FLY-xx`), quioscos (`TRM-xx`), puertas (`DOOR`), cámaras (`CAM`) y núcleos de misión.
4. `/hack [id]`, `/override [id]`, `/interrogate [id]` (a ≤ 14 m) abren el minijuego **ICE BREAKER**: un tablero 4×3, un clic (o la tecla marcada en cada casilla) sobre cada nodo **CIAN ◆** y nunca sobre los **ROJOS ✕** (restan tiempo). Funciona igual con ratón, teclado y táctil. Cuestan RAM, que se regenera.
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

El progreso (nivel, créditos, equipo) se guarda solo en `localStorage` (CONTINUE). La racha diaria y los logros viven en una clave aparte y **no** se borran con NEW GAME.

## Sistemas de retención y monetización

| Sistema | Dónde | Qué hace |
| --- | --- | --- |
| **Tienda** (`/shop`, tecla **B**, botón SHOP) | `src/systems/shop.ts` | Equipo en 5 niveles (hoja de plasma, escudo, núcleo de energía, blindaje) pagable con créditos **o** puntos de habilidad; consumibles (pack de RAM, kit de integridad, adrenalina, teclas **1-3**). |
| **Cambios visibles en 3D** | `src/player/player.ts` (`applyGear`) | Cada nivel modifica el modelo: hombreras, placa pectoral, pinchos, alas de reactor y halo; LEDs más intensos; hoja más larga, de otro color y con estela de partículas evolutiva. |
| **Racha diaria** (`/daily`) | `src/systems/daily.ts` | Panel holográfico de 7 días acumulativos (créditos, RAM, mejora de arma, escudo, suministros, jackpot). Se rompe si se salta un día natural. Opción de reclamar ×2 viendo un anuncio. |
| **Anuncios incentivados** | `src/systems/ads.ts` | `AdService` + proveedores. Duplicar recompensa de misión (**G** / toque), recarga de RAM (`/ram`), créditos de rescate (tienda y pantalla de Game Over). |
| **Combos** | `src/systems/progress.ts` | Cadena de golpes → multiplicador ×1.0–×3.0 sobre créditos y XP de bajas; recibir daño lo reduce a la mitad. |
| **Eventos de calle** | `src/systems/progress.ts` | *Data Drops*: baliza dorada aleatoria cerca de ti (32 s) con créditos, RAM, energía o kits. |
| **Logros** | `src/systems/progress.ts` (`/achievements`) | 16 trofeos con recompensa en créditos. |

### SDK de anuncios (integración nativa)

`src/systems/sdk.ts` detecta, carga e inicializa el SDK correcto sin tocar `index.html`: `?adprovider=` (pruebas), el host/referrer (`crazygames.com`, `poki.com`), un SDK ya presente en `window`, o `VITE_ADSENSE_CLIENT=ca-pub-…` en el build (AdSense H5, con `data-adbreak-test` activado en localhost / `?adtest`). Los callbacks nativos (`adStarted/adFinished/adError` de CrazyGames, `rewardedBreak` de Poki, `adBreak` reward de AdSense) disparan `onAdStarted`, `onAdCompleted` y `onAdFailed`; también se envían `gameplayStart/Stop` y `loadingFinished`. El simulador de 30 s solo se usa si no hay plataforma (desarrollo local); si el SDK está esperado pero no carga (adblock) las ofertas se desactivan y nunca se regala recompensa.


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
src/ui/minigame.ts        ICE BREAKER (hackeo de un clic)
src/systems/shop.ts       tienda · src/systems/ads.ts anuncios · src/systems/daily.ts racha · src/systems/progress.ts combos/eventos/logros
src/systems/meta.ts       datos de cuenta (racha, logros) separados del guardado de partida
src/combat.ts, src/enemies.ts, src/particles.ts, src/audio.ts, src/input.ts, src/transitions.ts
```

## Rendimiento y calidad gráfica

- Calidad por GPU (`TIER_PROFILES` en `config.ts`): RTX / RX 5000+ / Apple M → MSAA 4×, resolución nativa (hasta 2×), interiores a 120 m y máxima densidad de tráfico y peatones; otras dedicadas → MSAA 2×; integradas → perfil medio sin MSAA, presupuesto de píxeles y densidad reducidos; móvil → perfil bajo, bloom a baja resolución y adaptación automática en ~1,5 s si baja de 50 FPS. Selector **GRAPHICS** en el menú (AUTO/LOW/MEDIUM/HIGH) o `?q=low|medium|high`.
- Las fuentes de Google se cargan sin bloquear el primer render. `?debug` muestra FPS y `window.__boot` los tiempos de cada fase de carga.
- **Ciclo día/noche** (7 min): cielo, niebla, sol/luna con sombras, reflejos, neones, farolas y carteles. El reloj aparece junto al distrito.
- **Interiores reales en ventanas** (interior mapping en el shader de fachadas, sin geometría extra): habitaciones con muebles, personas, persianas, luz cálida/TV por la noche y luz solar de día; alcance 42/70/100 m según calidad.
- **Personaje** (`src/player/humanoid.ts`): malla continua con huesos (SkinnedMesh), sudadera, pantalones, botas, guantes y pelo; 5 niveles de armadura visibles y capa con simulación de tela (nivel 4+). Todo se genera en carga, sin descargar modelos.

## Rendimiento (detalles)

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
