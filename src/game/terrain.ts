import * as THREE from "three";
import { logInfo } from "../analytics.js";
import { BIOMES, DEEP_WATER_TILE, GLOWMOSS_TILE, GRAVEL_TILE, MOSS_TILE, regionAt, rockHeightAt, tileGlyph, WALL_TILE, WATER_TILE, type RegionVisibility, type Zone } from "@trogg/shared";
import { biomePalette, DAYLIGHT_3D, FOG_MIX } from "./palette.js";

/**
 * Procedural cave terrain. The floor and void are pixel-painted patch
 * textures (nearest-filtered, so the cave stays chunky); walls are read from the
 * same tilemap movement collides against, so what you see is exactly what blocks
 * you — drawn as ONE instanced mesh, so a generated 64×44 world costs the same
 * draw calls as the old hand-carved room. Decorative floor variants (gravel,
 * moss, water, glowmoss) are baked into a single zone-sized overlay texture
 * instead of per-tile quads; glowmoss point lights are clustered and capped so
 * the forward renderer never sees more than a dozen.
 */

/** Texels per tile edge of the painted patch textures. */
const ART = 16;
/** Tiles per generated patch; tiling a multi-tile patch hides the repeat. */
const PATCH = 4;
/**
 * Rock height comes from the shared skyline (`shared/heights.ts`) — the same
 * per-tile values the fly cheat's clearance reads, so what you see is exactly
 * what you can fly over. Deterministic, so every client carves the same skyline.
 */

export interface Terrain3D {
  group: THREE.Group;
  /** Stream chunks around the camera focus; call once per frame. */
  update(focusX: number, focusY: number, camDistance: number): void;
  /** Drop every currently-built chunk so the next `update()` rebuilds them
   *  against a changed `revealed` boundary (GDD "Generation: only as far as
   *  the light reaches") — cheap since region reveals are rare events. */
  invalidate(): void;
  dispose(): void;
}

/** Tiles per streamed chunk (a region is 64×44, so seams stay region-aligned on x). */
const CHUNK = 32;

/** The haze tint washed over anything short of interior — the same cool haze
 *  the sky fog uses, so "not yours yet" reads as one more shade of the same
 *  uncertainty, not a separate effect. The wash alone reads as frost, not
 *  weather, so it stays light (`FOG_MIX`, shared with the M map) and the
 *  actual fog is the drifting translucent layer below — never a solid
 *  substitute tile, since that would show a wall where the fog should be. */
const FOG_TINT = new THREE.Color(DAYLIGHT_3D.haze);
const FOG_TINT_CSS = `#${DAYLIGHT_3D.haze.toString(16).padStart(6, "0")}`;

/** The drifting mist over unclaimed ground: per fogged chunk, ONE merged mesh
 *  of soft puffs — each a horizontal quad plus two vertical cross quads, with
 *  vertex alpha falling to zero at the rim — textured by a shared noise sheet
 *  scrolled slowly in `update()`, so fog visibly flows from any camera angle
 *  (a lone ground plane vanishes edge-on at the game's shoulder-height view)
 *  instead of reading as a frozen painted-on white. (initial) */
const FOG_PUFF: Record<RegionVisibility, { density: number; alpha: number }> = {
  interior: { density: 0, alpha: 0 },
  penumbra: { density: 0.07, alpha: 0.3 },
  unreached: { density: 0.14, alpha: 0.5 },
};
const FOG_SHEET_TILES = 24; // world tiles per repeat of the noise sheet
const FOG_DRIFT_TILES_PER_SEC = 0.55;

function fogHash(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263) ^ salt;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A tileable sheet of soft fog blobs, alpha-on-white, shared by every chunk. */
function fogSheet(): HTMLCanvasElement {
  const SIZE = 256;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(255, 255, 255, 0.28)"; // a thin base so the fog never fully opens
  ctx.fillRect(0, 0, SIZE, SIZE);
  let seed = 0x706646;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let blob = 0; blob < 90; blob++) {
    const x = rand() * SIZE;
    const y = rand() * SIZE;
    const r = 14 + rand() * 34;
    const a = 0.1 + rand() * 0.2;
    // draw wrapped so the sheet tiles seamlessly
    for (const ox of [-SIZE, 0, SIZE]) {
      for (const oy of [-SIZE, 0, SIZE]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, `rgba(255, 255, 255, ${a})`);
        g.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.fillStyle = g;
        ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  }
  return canvas;
}

/**
 * `regionState` gates how much of the fully-generated committed tilemap
 * reads as clear (GDD "Generation: only as far as the light reaches"):
 * interior renders and collides plainly; penumbra and unreached both draw
 * their real tiles and walls, fogged rather than replaced, so ground you
 * can't yet reach still reads as a landscape rather than a rock face — just
 * one you can't see well enough to cross. Unreached still collides as solid
 * (Zones), the fog is the only visible sign of the boundary. The terrain
 * generator and its committed map are untouched either way.
 */
export function buildTerrain(zone: Zone, regionState: (x: number, y: number) => RegionVisibility): Terrain3D {
  const group = new THREE.Group();
  const globalDisposables: { dispose(): void }[] = [];

  // Painter caches: each biome paints its patch canvases once; every chunk of
  // that biome blits from the shared canvases.
  const patchCache = new Map<string, Record<string, HTMLCanvasElement>>();
  const patchesFor = (biome: string): Record<string, HTMLCanvasElement> => {
    let entry = patchCache.get(biome);
    if (!entry) {
      const pal = biomePalette(biome);
      entry = {
        floor: floorPatch(pal),
        [GRAVEL_TILE]: gravelPatch(pal),
        [MOSS_TILE]: mossPatch(pal),
        [WATER_TILE]: waterPatch(pal),
        [GLOWMOSS_TILE]: glowmossPatch(pal),
        [DEEP_WATER_TILE]: deepWaterPatch(pal),
      };
      patchCache.set(biome, entry);
    }
    return entry;
  };
  // region palettes are the world map's; any other zone is one biome throughout
  const tileBiome = (x: number, y: number): string => (zone.slug === "world" ? (regionAt(x, y)?.biome ?? "cave") : zone.biome);

  // Pre-warm every biome's patch canvases shortly after boot, one biome per
  // tick: first contact with a new biome used to pay all six paints
  // synchronously mid-walk — the "entering a dark area hangs, re-entering is
  // fine" cold cache. Warming them behind the boot screen makes first entry
  // feel like re-entry.
  if (zone.slug === "world") {
    const pending = [...BIOMES];
    const step = () => {
      const biome = pending.shift();
      if (!biome) return;
      patchesFor(biome);
      setTimeout(step, 100);
    };
    setTimeout(step, 1500);
  }

  // The void beyond and beneath the world: one dim rock plane.
  const cavePal = biomePalette("cave");
  const voidTex = new THREE.CanvasTexture(floorlessPatch(cavePal));
  voidTex.colorSpace = THREE.SRGBColorSpace;
  voidTex.magFilter = THREE.NearestFilter;
  voidTex.minFilter = THREE.NearestFilter;
  voidTex.wrapS = THREE.RepeatWrapping;
  voidTex.wrapT = THREE.RepeatWrapping;
  voidTex.repeat.set(600 / PATCH, 600 / PATCH);
  globalDisposables.push(voidTex);
  const voidPlane = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ map: voidTex, roughness: 1 }));
  voidPlane.rotation.x = -Math.PI / 2;
  // well below the sunken river channels (whose tops sit at -0.18): anything cut
  // out of the floor must reveal what's carved beneath it, not this underlay
  voidPlane.position.set(zone.unbounded ? (zone.spawn?.x ?? 0) : zone.width / 2, -0.62, zone.unbounded ? (zone.spawn?.y ?? 0) : zone.height / 2);
  voidPlane.receiveShadow = true;
  group.add(voidPlane);

  // One fog sheet, shared by every fogged chunk's drifting layer.
  const fogImage = fogSheet();

  // Walls tint per tile through instance colours, so biome borders stay
  // tile-exact even when a chunk straddles two regions.
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  const wallGeo = new THREE.BoxGeometry(1, 1, 1); // unit box, scaled per instance to its rock height
  globalDisposables.push(wallMat, wallGeo);
  const rockHeight = (x: number, y: number): number => rockHeightAt(zone, x, y);

  // Rivers sink where walls rise: a sunken box per deep-water tile, its textured
  // top a step below the floor with dark banks — impassability reads in the
  // z-axis without a tooltip.
  const riverTopTex = new THREE.CanvasTexture(deepWaterPatch(cavePal));
  riverTopTex.colorSpace = THREE.SRGBColorSpace;
  riverTopTex.magFilter = THREE.NearestFilter;
  riverTopTex.minFilter = THREE.NearestFilter;
  const riverTop = new THREE.MeshStandardMaterial({ map: riverTopTex, roughness: 0.7 });
  const riverBank = new THREE.MeshStandardMaterial({ color: cavePal.floor.crack, roughness: 1 });
  const riverMats = [riverBank, riverBank, riverTop, riverBank, riverBank, riverBank];
  const RIVER_DEPTH = 0.5;
  const riverGeo = new THREE.BoxGeometry(1, RIVER_DEPTH, 1);
  globalDisposables.push(riverTopTex, riverTop, riverBank, riverGeo);

  interface BuiltChunk {
    group: THREE.Group;
    disposables: { dispose(): void }[];
    lights: THREE.PointLight[];
    /** The drifting fog layer's texture and its world-aligned base offset —
     *  `update()` scrolls it so unclaimed ground smokes instead of sitting
     *  under a frozen wash. */
    fog?: { tex: THREE.Texture; baseX: number; baseY: number };
  }
  const chunks = new Map<string, BuiltChunk>();
  const wallColour = new THREE.Color();

  const buildChunk = (cx: number, cy: number): BuiltChunk | undefined => {
    const x0 = cx * CHUNK;
    const y0 = cy * CHUNK;
    const w = zone.unbounded ? CHUNK : Math.min(CHUNK, zone.width - x0);
    const h = zone.unbounded ? CHUNK : Math.min(CHUNK, zone.height - y0);
    if (w <= 0 || h <= 0) return undefined;

    const chunkGroup = new THREE.Group();
    const disposables: { dispose(): void }[] = [];
    const lights: THREE.PointLight[] = [];

    // Floor: one canvas per chunk, each tile blitted from its biome's patch at
    // the world-aligned sub-cell so seams between chunks and regions vanish.
    const canvas = document.createElement("canvas");
    canvas.width = w * ART;
    canvas.height = h * ART;
    const ctx = canvas.getContext("2d")!;
    const wallTiles: { x: number; y: number; biome: string; fogMix: number }[] = [];
    const glowTiles: { x: number; y: number; biome: string }[] = [];
    const deepTiles: { x: number; y: number }[] = [];
    const fogTiles: { x: number; y: number; puff: { density: number; alpha: number } }[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const wx = x0 + x;
        const wy = y0 + y;
        const state = regionState(wx, wy);
        const puff = FOG_PUFF[state];
        if (puff.density > 0) fogTiles.push({ x: wx, y: wy, puff });
        const glyph = tileGlyph(zone, wx, wy)!;
        const biome = tileBiome(wx, wy);
        const fogMix = FOG_MIX[state];
        const patches = patchesFor(biome);
        const sx = (wx % PATCH) * ART;
        const sy = (wy % PATCH) * ART;
        if (glyph === DEEP_WATER_TILE) {
          // impassable water is CUT OUT of the floor: a sunken channel renders
          // below it, so depth says "you can't walk here" the way height does
          // for walls (GDD "Zones")
          ctx.clearRect(x * ART, y * ART, ART, ART);
          deepTiles.push({ x: wx, y: wy });
          continue;
        }
        ctx.drawImage(patches.floor!, sx, sy, ART, ART, x * ART, y * ART, ART, ART);
        if (glyph === WALL_TILE) {
          wallTiles.push({ x: wx, y: wy, biome, fogMix });
          continue;
        }
        const decal = patches[glyph];
        if (decal) ctx.drawImage(decal, sx, sy, ART, ART, x * ART, y * ART, ART, ART);
        if (glyph === GLOWMOSS_TILE) glowTiles.push({ x: wx, y: wy, biome });
        // Non-interior ground is real, just fogged — a region you can't yet
        // enter reads as "out there," not as a wall (GDD "Generation: only
        // as far as the light reaches").
        if (fogMix > 0) {
          ctx.fillStyle = FOG_TINT_CSS;
          ctx.globalAlpha = fogMix;
          ctx.fillRect(x * ART, y * ART, ART, ART);
          ctx.globalAlpha = 1;
        }
      }
    }
    const floorTex = new THREE.CanvasTexture(canvas);
    floorTex.colorSpace = THREE.SRGBColorSpace;
    floorTex.magFilter = THREE.NearestFilter;
    floorTex.minFilter = THREE.NearestFilter;
    disposables.push(floorTex);
    const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 1, transparent: true });
    disposables.push(floorMat);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, h), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(x0 + w / 2, 0, y0 + h / 2);
    floor.receiveShadow = true;
    chunkGroup.add(floor);

    if (deepTiles.length > 0) {
      const channel = new THREE.InstancedMesh(riverGeo, riverMats, deepTiles.length);
      const place = new THREE.Matrix4();
      deepTiles.forEach((tile, i) => {
        place.makeTranslation(tile.x + 0.5, -RIVER_DEPTH / 2 - 0.18, tile.y + 0.5);
        channel.setMatrixAt(i, place);
      });
      channel.receiveShadow = true;
      chunkGroup.add(channel);
      disposables.push(channel);
    }

    if (wallTiles.length > 0) {
      const walls = new THREE.InstancedMesh(wallGeo, wallMat, wallTiles.length);
      const place = new THREE.Matrix4();
      const shape = new THREE.Vector3();
      wallTiles.forEach((tile, i) => {
        const height = rockHeight(tile.x, tile.y);
        place.makeTranslation(tile.x + 0.5, height / 2, tile.y + 0.5);
        place.scale(shape.set(1, height, 1));
        walls.setMatrixAt(i, place);
        wallColour.setHex(biomePalette(tile.biome).wall.face);
        if (tile.fogMix > 0) wallColour.lerp(FOG_TINT, tile.fogMix);
        walls.setColorAt(i, wallColour);
      });
      walls.castShadow = true;
      walls.receiveShadow = true;
      chunkGroup.add(walls);
      disposables.push(walls);
    }

    // Glowmoss: one light per moss patch, at most two per chunk.
    const clusters: { x: number; y: number; count: number; biome: string }[] = [];
    for (const tile of glowTiles) {
      const near = clusters.find((c) => Math.abs(c.x - tile.x) + Math.abs(c.y - tile.y) <= 5);
      if (near) near.count++;
      else clusters.push({ ...tile, count: 1 });
    }
    for (const cluster of clusters.slice(0, 2)) {
      const glow = new THREE.PointLight(biomePalette(cluster.biome).glowmoss.mid, 1.2 + Math.min(cluster.count, 3) * 0.3, 5);
      glow.position.set(cluster.x + 0.5, 0.5, cluster.y + 0.5);
      glow.visible = false; // the light budget below turns the nearest ones on
      chunkGroup.add(glow);
      lights.push(glow);
    }

    // The drifting mist: merge every puff (a horizontal quad plus two vertical
    // cross quads, each subdivided so vertex alpha can fall to zero at the rim)
    // into one geometry — one draw call per fogged chunk, readable from any
    // camera angle. The shared noise sheet scrolls in `update()`, so the mist
    // flows through the puff volumes. Lambert, so night dims it.
    let fog: BuiltChunk["fog"];
    const puffs: { x: number; y: number; r: number; alpha: number }[] = [];
    for (const tile of fogTiles) {
      if (fogHash(tile.x, tile.y, 0x1066) >= tile.puff.density) continue;
      puffs.push({
        x: tile.x + fogHash(tile.x, tile.y, 0x2066) * 2 - 0.5,
        y: tile.y + fogHash(tile.x, tile.y, 0x3066) * 2 - 0.5,
        r: 2.4 + fogHash(tile.x, tile.y, 0x4066) * 2.2,
        alpha: tile.puff.alpha * (0.75 + fogHash(tile.x, tile.y, 0x5066) * 0.5),
      });
    }
    if (puffs.length > 0) {
      const positions: number[] = [];
      const uvs: number[] = [];
      const colors: number[] = [];
      const indices: number[] = [];
      // one 3×3-vertex quad: centre at full alpha, rim at zero, so every puff
      // fades out instead of showing a square edge
      const addQuad = (centre: THREE.Vector3, axisU: THREE.Vector3, axisV: THREE.Vector3, uvBase: { u: number; v: number }, uvSpan: number, alpha: number) => {
        const base = positions.length / 3;
        for (let gv = 0; gv <= 2; gv++) {
          for (let gu = 0; gu <= 2; gu++) {
            const fu = gu / 2 - 0.5;
            const fv = gv / 2 - 0.5;
            positions.push(centre.x + axisU.x * fu + axisV.x * fv, centre.y + axisU.y * fu + axisV.y * fv, centre.z + axisU.z * fu + axisV.z * fv);
            uvs.push(uvBase.u + (fu + 0.5) * uvSpan, uvBase.v + (fv + 0.5) * uvSpan);
            colors.push(1, 1, 1, gu === 1 && gv === 1 ? alpha : 0);
          }
        }
        for (let gv = 0; gv < 2; gv++) {
          for (let gu = 0; gu < 2; gu++) {
            const a = base + gv * 3 + gu;
            indices.push(a, a + 3, a + 1, a + 1, a + 3, a + 4);
          }
        }
      };
      for (const puff of puffs) {
        const height = 0.8 + puff.r * 0.22;
        const centre = new THREE.Vector3(puff.x + 0.5, height, puff.y + 0.5);
        const uvBase = { u: puff.x / FOG_SHEET_TILES, v: puff.y / FOG_SHEET_TILES };
        const uvSpan = puff.r / FOG_SHEET_TILES;
        const d = puff.r * 2;
        addQuad(centre, new THREE.Vector3(d, 0, 0), new THREE.Vector3(0, 0, d), uvBase, uvSpan, puff.alpha);
        addQuad(centre, new THREE.Vector3(d, 0, 0), new THREE.Vector3(0, height * 1.7, 0), uvBase, uvSpan, puff.alpha * 0.85);
        addQuad(centre, new THREE.Vector3(0, 0, d), new THREE.Vector3(0, height * 1.7, 0), uvBase, uvSpan, puff.alpha * 0.85);
      }
      const fogGeo = new THREE.BufferGeometry();
      fogGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      fogGeo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      fogGeo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 4));
      fogGeo.setIndex(indices);
      const sheetTex = new THREE.CanvasTexture(fogImage);
      sheetTex.wrapS = THREE.RepeatWrapping;
      sheetTex.wrapT = THREE.RepeatWrapping;
      const fogMat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(DAYLIGHT_3D.haze).lerp(new THREE.Color(0xffffff), 0.15),
        map: sheetTex,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const fogMesh = new THREE.Mesh(fogGeo, fogMat);
      fogMesh.renderOrder = 3;
      chunkGroup.add(fogMesh);
      disposables.push(sheetTex, fogMat, fogGeo);
      fog = { tex: sheetTex, baseX: 0, baseY: 0 };
    }

    group.add(chunkGroup);
    return { group: chunkGroup, disposables, lights, fog };
  };

  const dropChunk = (key: string) => {
    const chunk = chunks.get(key);
    if (!chunk) return;
    chunks.delete(key);
    group.remove(chunk.group);
    for (const d of chunk.disposables) d.dispose();
  };

  const update = (focusX: number, focusY: number, camDistance: number) => {
    // the void underlay follows the camera through the edgeless world, snapped
    // to whole texture patches so its repeating pattern never visibly swims
    if (zone.unbounded) {
      voidPlane.position.x = Math.round(focusX / PATCH) * PATCH;
      voidPlane.position.z = Math.round(focusY / PATCH) * PATCH;
    }
    // The streamed radius follows the zoom, Google-Maps style: close in you get
    // the neighbourhood, zoomed out the chunks fan out to what the fog reveals.
    const radius = Math.min(320, Math.max(48, camDistance * 2.6 + 40));
    const c0x = zone.unbounded ? Math.floor((focusX - radius) / CHUNK) : Math.max(0, Math.floor((focusX - radius) / CHUNK));
    const c1x = zone.unbounded ? Math.floor((focusX + radius) / CHUNK) : Math.min(Math.ceil(zone.width / CHUNK) - 1, Math.floor((focusX + radius) / CHUNK));
    const c0y = zone.unbounded ? Math.floor((focusY - radius) / CHUNK) : Math.max(0, Math.floor((focusY - radius) / CHUNK));
    const c1y = zone.unbounded ? Math.floor((focusY + radius) / CHUNK) : Math.min(Math.ceil(zone.height / CHUNK) - 1, Math.floor((focusY + radius) / CHUNK));
    const wanted: { cx: number; cy: number; dist: number; needed: boolean }[] = [];
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const centreX = cx * CHUNK + CHUNK / 2;
        const centreY = cy * CHUNK + CHUNK / 2;
        const dist = Math.hypot(centreX - focusX, centreY - focusY);
        // needed chunks are visible ground; the outer ring is prefetch —
        // built ahead of the walk so entering fresh dark finds the ground
        // already there (still inside the drop hysteresis, so prefetched
        // chunks aren't immediately disposed).
        if (dist <= radius + CHUNK * 2.5) wanted.push({ cx, cy, dist, needed: dist <= radius + CHUNK });
      }
    }
    // Build nearest-first on a TIME budget, not a count: a chunk's cost
    // varies wildly with terrain (mountain cores merge far more geometry
    // than flat floor), and "two per frame" of expensive chunks was a
    // sustained main-thread hitch while panning across unbuilt dark ground
    // — always build the nearest missing chunk, then keep building only
    // while the frame's budget has room. Slow builds also get logged, so
    // hitch reports come with the culprit named.
    wanted.sort((a, b) => a.dist - b.dist);
    const buildStart = performance.now();
    let built = 0;
    const keep = new Set<string>();
    for (const want of wanted) {
      const key = `${want.cx},${want.cy}`;
      if (want.needed) keep.add(key);
      if (chunks.has(key)) continue;
      // a needed chunk always gets built (nearest first, one minimum);
      // prefetch chunks only ever spend leftover budget, never force a build
      if (want.needed ? built > 0 && performance.now() - buildStart > 6 : performance.now() - buildStart > 6) continue;
      const chunk = buildChunk(want.cx, want.cy);
      if (chunk) chunks.set(key, chunk);
      built++;
    }
    const buildMs = performance.now() - buildStart;
    if (buildMs > 40) logInfo("Chunk build hitch", { surface: "perf", action: "chunk_build", duration_ms: Math.round(buildMs), chunks_built: built });
    // drop chunks that fell out of range (with hysteresis so edges don't thrash)
    for (const key of [...chunks.keys()]) {
      if (keep.has(key)) continue;
      const [cx, cy] = key.split(",").map(Number);
      const dist = Math.hypot(cx! * CHUNK + CHUNK / 2 - focusX, cy! * CHUNK + CHUNK / 2 - focusY);
      if (dist > radius + CHUNK * 2) dropChunk(key);
    }

    // Drift the fog: one shared clock, per-chunk world-aligned offsets, so the
    // haze over unclaimed ground visibly crawls instead of reading as frost.
    const driftT = (performance.now() / 1000) * (FOG_DRIFT_TILES_PER_SEC / FOG_SHEET_TILES);
    for (const chunk of chunks.values()) {
      if (chunk.fog) chunk.fog.tex.offset.set(chunk.fog.baseX + driftT, chunk.fog.baseY + driftT * 0.45);
    }

    // The light budget: a forward renderer pays every light on every fragment, so
    // only the nearest few glowmoss lights are live no matter how far the chunks
    // fan out — dozens of live point lights is how the frame rate dies.
    const allLights: { light: THREE.PointLight; dist: number }[] = [];
    for (const chunk of chunks.values()) {
      for (const light of chunk.lights) {
        allLights.push({ light, dist: Math.hypot(light.position.x - focusX, light.position.z - focusY) });
      }
    }
    allLights.sort((a, b) => a.dist - b.dist);
    allLights.forEach(({ light, dist }, i) => {
      light.visible = i < 8 && dist < 48;
    });
  };

  return {
    group,
    update,
    invalidate() {
      for (const key of [...chunks.keys()]) dropChunk(key);
    },
    dispose() {
      for (const key of [...chunks.keys()]) dropChunk(key);
      for (const d of globalDisposables) d.dispose();
    },
  };
}

// ── pixel painters — the cave's procedural patch textures ───────────────────────

function pixelCanvas(w: number, h: number, paint: (set: (x: number, y: number, color: number, alpha?: number) => void) => void): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const set = (x: number, y: number, color: number, alpha = 0xff) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = (color >> 16) & 0xff;
    data[i + 1] = (color >> 8) & 0xff;
    data[i + 2] = color & 0xff;
    data[i + 3] = alpha;
  };
  paint(set);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Cave floor: mottled stone, tile seams, a few cracks and pebbles. Deterministic. */
function floorPatch(pal: ReturnType<typeof biomePalette>): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0xc0ffee);
  const F = pal.floor;
  return pixelCanvas(size, size, (set) => {
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        const r = rand();
        const col = r < 0.12 ? F.dark : r < 0.24 ? F.light : F.base;
        set(x, y, col);
        set(x + 1, y, col);
        set(x, y + 1, col);
        set(x + 1, y + 1, col);
      }
    }
    for (let edge = 0; edge < size; edge += ART) {
      for (let i = 0; i < size; i++) {
        set(edge, i, F.seam);
        set(i, edge, F.seam);
      }
    }
    for (let k = 0; k < 3; k++) {
      let cx = 2 + Math.floor(rand() * (size - 4));
      let cy = 2 + Math.floor(rand() * (size - 4));
      const len = 4 + Math.floor(rand() * 6);
      for (let s = 0; s < len; s++) {
        set(cx, cy, F.crack);
        if (rand() < 0.5) cx++;
        else cy++;
      }
    }
    for (let k = 0; k < 10; k++) {
      const px = Math.floor(rand() * size);
      const py = Math.floor(rand() * size);
      set(px, py, F.pebble);
      set(px + 1, py, F.pebble);
      set(px, py + 1, F.pebble);
    }
  });
}

/** Flat rock fill with sparse darker specks — the void beyond the zone. */
function floorlessPatch(pal: ReturnType<typeof biomePalette>): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0xbadbad);
  return pixelCanvas(size, size, (set) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, pal.voidBase);
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        if (rand() >= 0.1) continue;
        const col = pal.voidSpecks[Math.floor(rand() * pal.voidSpecks.length)]!;
        set(x, y, col);
        set(x + 1, y, col);
        set(x, y + 1, col);
        set(x + 1, y + 1, col);
      }
    }
  });
}

/** Gravel scree: a scatter of light/dark stone chips over the floor. */
function gravelPatch(pal: ReturnType<typeof biomePalette>): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x9e3a11);
  const G = pal.gravel;
  return pixelCanvas(size, size, (set) => {
    for (let i = 0; i < size * size * 0.22; i++) {
      const x = Math.floor(rand() * size);
      const y = Math.floor(rand() * size);
      const r = rand();
      const col = r < 0.4 ? G.light : r < 0.75 ? G.mid : G.dark;
      set(x, y, col);
      if (rand() < 0.5) set(x + 1, y, col);
    }
  });
}

/** Moss: soft clumps of damp green with darker flecks, leaving stone gaps. */
function mossPatch(pal: ReturnType<typeof biomePalette>): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x2c7b3f);
  const M = pal.moss;
  return pixelCanvas(size, size, (set) => {
    for (let k = 0; k < 26; k++) {
      const cx = Math.floor(rand() * size);
      const cy = Math.floor(rand() * size);
      const r = 1 + Math.floor(rand() * 2);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          if (rand() < 0.25) continue;
          const t = rand();
          const col = t < 0.15 ? M.dark : t < 0.6 ? M.mid : M.light;
          set(cx + dx, cy + dy, col, 0xe6);
        }
      }
    }
  });
}

/** Shallow water: a near-opaque pool with darker depths and lit ripples. */
function waterPatch(pal: ReturnType<typeof biomePalette>): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x1f6fae);
  const W = pal.water;
  return pixelCanvas(size, size, (set) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) set(x, y, rand() < 0.3 ? W.deep : W.base, 0xea);
    }
    for (let k = 0; k < 60; k++) {
      const x = Math.floor(rand() * size);
      const y = Math.floor(rand() * size);
      const len = 1 + Math.floor(rand() * 3);
      for (let s = 0; s < len; s++) set(x + s, y, W.ripple, 0xf0);
    }
    for (let k = 0; k < 8; k++) set(Math.floor(rand() * size), Math.floor(rand() * size), W.glint, 0xc0);
  });
}

/** Glowmoss: sparse bioluminescent specks with a dim halo, mostly transparent. */
/** The river: deep water too dark to wade — near-opaque, sparse slow ripples. */
function deepWaterPatch(pal: ReturnType<typeof biomePalette>): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x2f6fae);
  const W = pal.water;
  return pixelCanvas(size, size, (set) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) set(x, y, rand() < 0.16 ? W.base : W.deep, 0xfa);
    }
    for (let k = 0; k < 26; k++) {
      const x = Math.floor(rand() * size);
      const y = Math.floor(rand() * size);
      const len = 2 + Math.floor(rand() * 3);
      for (let s = 0; s < len; s++) set(x + s, y, W.ripple, 0x70);
    }
  });
}

function glowmossPatch(pal: ReturnType<typeof biomePalette>): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x33d6c0);
  const G = pal.glowmoss;
  return pixelCanvas(size, size, (set) => {
    for (let k = 0; k < 22; k++) {
      const x = Math.floor(rand() * size);
      const y = Math.floor(rand() * size);
      set(x, y, G.halo, 0x66);
      set(x + 1, y, G.halo, 0x66);
      set(x, y + 1, G.halo, 0x66);
      set(x + 1, y + 1, G.halo, 0x66);
      set(x, y, rand() < 0.5 ? G.core : G.mid);
    }
  });
}

/** mulberry32 — small deterministic PRNG so terrain looks identical everywhere. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
