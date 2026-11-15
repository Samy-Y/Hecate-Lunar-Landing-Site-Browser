# HECATE — Lunar Landing Site Navigator

Interactive 3D globe and 2D polar map application for evaluating lunar South Pole (`80°S–90°S`) landing sites against solar illumination, direct-to-Earth (DTE) visibility, terrain slope/roughness, permanently shadowed region (PSR) proximity, and data confidence.

Built with React 18, TypeScript, Three.js (`@react-three/fiber`), Zustand, D3, Astronomy Engine, and Vite.

## Getting Started

Install dependencies and launch the development server:

```bash
npm install
npm run dev
```

### Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite development server |
| `npm run build` | Type-check and build production assets to `dist/` |
| `npm run preview` | Preview the production build locally |
| `npm run typecheck` | Run TypeScript type checking (`tsc -b --noEmit`) |
| `npm test` | Run the Vitest test suite (`vitest run`) |

## Features

- **Forward Search**: Configure mission baselines (`Artemis III`, `CLPS`, `Rover` or custom parameters), time windows, sunlight, DTE, terrain, science, and solar-array settings, then run regional screening across `80°S–90°S` (manually or with `Auto` enabled).
- **Site Analysis**: Inspect any South Polar location (`80°S–90°S`) or curated Artemis III / CLPS candidate sites, review feasibility (`PASS` / `FAIL` / `UNKNOWN`), suitability scores, solar array power profiles, launch-slip windows, multi-site comparisons, and 360° horizon panoramas.
- **3D & 2D Views**: Switch between an interactive full-Moon 3D WebGL globe (down to 5 m LOLA polar tiles with GPU cast shadows) and a 2D polar stereographic map.
- **Ephemeris Validation**: Uses a local analytical model (`astronomy-engine`) with optional live verification against NASA JPL Horizons for inspected sites.

## Navigation Controls

- **Pan**: Drag terrain or press <kbd>←</kbd> <kbd>↑</kbd> <kbd>↓</kbd> <kbd>→</kbd>
- **Rotate / Tilt (3D)**: Right-drag / <kbd>Ctrl</kbd>-drag or <kbd>Shift</kbd> + arrow keys
- **Zoom**: Mouse wheel, HUD zoom bar, <kbd>PageUp</kbd> / <kbd>PageDown</kbd>, or <kbd>+</kbd> / <kbd>-</kbd>
- **Inspect / Pin**: Click inside `80°S–90°S` to inspect a site; press <kbd>P</kbd> to pin or unpin
- **Timeline**: <kbd>[</kbd> / <kbd>]</kbd> to step epochs, <kbd>Space</kbd> to play/pause

## Project Structure

- `src/components/chrome/` — Header, toolbar/fullscreen button, navigation HUD, main menu, Settings/About/Tutorial modals
- `src/components/globe/` — 3D WebGL Moon globe, camera rig, terrain shaders
- `src/components/map2d/` — 2D polar stereographic map renderer and layers
- `src/components/panels/` — Criteria panels, timeline scrubber, adequacy, horizon panorama, and power charts
- `src/science/` — Ephemeris, horizon ray-casting, illumination, power model, screening, and Vitest suites
- `src/store/` — Zustand state, background screening workers, and session save/restore
- `public/data/` — LOLA elevation/confidence tiles, PSR outlines, and site catalog manifest
- `public/brand/` — HECATE SVG branding assets
- `public/about/` — Scientific disclaimer card assets (`real_nasa_terrain.png`, `resolution_honesty.png`, `geometric_only.png`, `ephemeris.png`), with bundled `.svg` fallbacks when PNGs are not provided

