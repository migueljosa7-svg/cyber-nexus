# CYBER-NEXUS: PROTOCOL ZERO

Juego 3D cyberpunk de arena/acción para navegador (PC y móvil). Three.js + Vite + TypeScript.

## Comandos

```bash
npm install        # instala dependencias
npm run dev        # servidor local en http://localhost:5173 (también accesible desde el móvil en tu red local)
npm run build      # typecheck + build de producción en /dist
npm run preview    # sirve el build de producción para probarlo
```

## Controles

| PC | Móvil |
| --- | --- |
| WASD mover · Ratón cámara | Joystick izquierdo · arrastrar lado derecho = cámara |
| Click / J: combo de espada láser (3 golpes) | ATK |
| Click derecho / K: disparo de energía | SHOT |
| Espacio: salto (doble) · Shift: dash con i-frames | JUMP · DASH |
| Q: pulso EMP · E: escudo de datos · R: ráfaga cuántica | EMP · SHLD · QNTM |
| F: hackear terminal · P: pausa | HACK (aparece junto a terminales) |

## Rendimiento

- **Draw calls ~30-70 y ~20k triángulos por frame**: edificios, neones, lámparas, puentes e islas son `InstancedMesh`; ventanas y bordes de neón se calculan en el shader (sin texturas ni geometría por chunk).
- **Lluvia digital 100% en GPU** (cero trabajo de CPU por frame) y chunks que solo reescriben buffers de instancias (sin tirones al cruzar chunks).
- **Recursos compartidos**: enemigos, efectos de golpe y proyectiles usan pools y geometrías/materiales compartidos; no se crea nada dentro del bucle.
- **Calidad adaptativa**: baja primero la resolución, luego el bloom y por último las sombras si los FPS caen; la recupera poco a poco. MSAA y sombras solo en GPUs capaces; en móvil sin sombras.
- **Colisiones** con cajas AABB / distancia (sin motor de físicas), sin alocaciones.
- Pulsa **F3** (o abre `/?debug`) para ver FPS, draw calls, triángulos, escala de resolución y nivel de calidad.

## Estructura

```
index.html
src/main.ts            máquina de estados (menú → transición → juego → hackeo → game over)
src/engine/renderer.ts renderer, sombras, niebla, bloom, aberración cromática/glitch, resolución dinámica
src/player.ts          héroe en 3ª persona: inercia, doble salto, dash, combo, disparos
src/combat.ts          habilidades EMP / escudo / ráfaga, proyectiles, deflexión, efectos de impacto
src/enemies.ts         agentes, hackers y brutes con IA, barras de vida flotantes, destrucción por partículas
src/world.ts           ciudad procedural por chunks (geometría fusionada), terminales, lluvia digital, portal
src/minigame.ts        minijuegos de hackeo (secuencia de firewall / descifrado de bytes)
src/ui.ts              HUD flotante, menús, joystick y botones táctiles
src/transitions.ts     transiciones de terminal CRT con logs "SYSTEM BREACH..."
src/audio.ts           SFX sintetizados con Web Audio (sin archivos)
src/particles.ts       sistema de partículas GPU (1 draw call)
```

## Despliegue en Vercel

```bash
git init
git add .
git commit -m "CYBER-NEXUS: PROTOCOL ZERO"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/cyber-nexus.git
git push -u origin main
```

1. Entra en <https://vercel.com/new> e importa el repositorio.
2. Vercel detecta Vite automáticamente (Build: `npm run build`, Output: `dist`). Pulsa **Deploy**.

O por CLI: `npm i -g vercel && vercel --prod`.
