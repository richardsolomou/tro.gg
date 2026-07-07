import * as THREE from "three";
import { FIRST_FIRE_LIT_RADIUS, getZone, STARTING_ZONE_SLUG } from "@trogg/shared";
import { buildTerrain } from "../game/terrain.js";
import { buildBoulder, buildBrazier, buildTree } from "../game/items.js";
import { buildTrogg } from "../game/creatures.js";
import { DAYLIGHT_3D } from "../game/palette.js";

/**
 * Fire lab (`/firelab/`, dev-only): the campfire lighting scene in isolation —
 * the real world-zone terrain, the real First Fire (same light constants as
 * `world.ts#upsertBrazier`), the real sun/sky math (`world.ts#updateDaylight`),
 * a trogg standing beside the fire — with the camera URL-addressable, so the
 * exact same world state can be screenshotted from many orbit angles and
 * diffed. Anything that changes between two azimuths of the same phase is a
 * view-dependent artifact. `?phase=` day-cycle phase (0 dawn, 0.25 noon, 0.75
 * midnight), `?az=` camera azimuth in radians, `?r=` orbit distance,
 * `?polar=` polar angle.
 */
const params = new URLSearchParams(location.search);
const phase = Number(params.get("phase") ?? 0.75);
const az = Number(params.get("az") ?? 0);
const dist = Number(params.get("r") ?? 12);
const polar = Number(params.get("polar") ?? 1.05);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 120);

scene.background = new THREE.Color(DAYLIGHT_3D.sky);
scene.fog = new THREE.Fog(DAYLIGHT_3D.haze, 60, 150);
const hemi = new THREE.HemisphereLight(0xdcebff, DAYLIGHT_3D.bounce, 1.5);
scene.add(hemi);
const key = new THREE.DirectionalLight(DAYLIGHT_3D.sun, 3.2);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -56;
key.shadow.camera.right = 56;
key.shadow.camera.top = 56;
key.shadow.camera.bottom = -56;
scene.add(key, key.target);

const zone = getZone(STARTING_ZONE_SLUG)!;
const terrain = buildTerrain(zone, () => "interior");
scene.add(terrain.group);

const spawn = zone.spawn ?? { x: Math.floor(zone.width / 2), y: Math.floor(zone.height / 2) };

// The First Fire, wired exactly like world.ts#upsertBrazier.
const brazier = buildBrazier();
const fireLight = new THREE.PointLight(0xff8c2e, 9, Math.max(14, FIRST_FIRE_LIT_RADIUS * 2.4), 1.6);
fireLight.position.set(0.5, 0.7, 0.5);
fireLight.shadow.mapSize.set(512, 512);
fireLight.shadow.camera.near = 0.3;
fireLight.shadow.bias = -0.005;
fireLight.castShadow = params.get("fireshadow") !== "0";
brazier.add(fireLight);
const litGround = new THREE.Mesh(
  new THREE.RingGeometry(0.6, FIRST_FIRE_LIT_RADIUS, 32),
  new THREE.MeshBasicMaterial({ color: 0xff8c2e, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }),
);
litGround.rotation.x = -Math.PI / 2;
litGround.position.set(0.5, 0.02, 0.5);
litGround.renderOrder = 1; // after the transparent floor, whatever the camera angle
brazier.add(litGround);
const cels = brazier.userData.flameCels as THREE.Group[];
cels.forEach((cel, i) => (cel.visible = i === 0));
// Isolation toggles: turn off one element of the fire at a time to attribute
// a rendering artifact to its source.
if (params.get("fire") === "0") fireLight.visible = false;
if (params.get("ring") === "0") litGround.visible = false;
if (params.get("flame") === "0") cels.forEach((cel) => (cel.visible = false));
// Debug paint: make the ring unmissable to see its exact rendered shape —
// this is how the transparent-floor paint-over was caught.
if (params.get("ringdebug") === "1") {
  const m = litGround.material as THREE.MeshBasicMaterial;
  m.color.set(0xff00ff);
  m.opacity = 0.85;
}
brazier.position.set(spawn.x, 0, spawn.y);
scene.add(brazier);

// A trogg two tiles from the fire, a boulder and a tree nearby — bodies the
// firelight should interact with.
const trogg = buildTrogg("moss");
trogg.root.traverse((o) => {
  o.castShadow = true;
});
trogg.root.position.set(spawn.x + 0.5, 0, spawn.y + 2.5);
scene.add(trogg.root);
const boulder = buildBoulder();
boulder.position.set(spawn.x - 3, 0, spawn.y + 1);
scene.add(boulder);
const tree = buildTree();
tree.position.set(spawn.x + 3, 0, spawn.y - 2);
scene.add(tree);

// The sun/sky at the requested phase — world.ts#updateDaylight verbatim,
// minus the cave and emergence blends.
const skyDay = new THREE.Color(DAYLIGHT_3D.sky);
const skyNight = new THREE.Color(0x0d1424);
const hazeDay = new THREE.Color(DAYLIGHT_3D.haze);
const hazeNight = new THREE.Color(0x101a2c);
const target = new THREE.Vector3(spawn.x + 0.5, 0.9, spawn.y + 2.5);
const sunAngle = phase * Math.PI * 2 - Math.PI / 2;
const elevation = Math.sin(sunAngle + Math.PI / 2);
const daylight = Math.max(0, Math.min(1, (elevation + 0.12) * 2.4));
key.position.set(target.x + Math.cos(sunAngle) * 30, 8 + Math.max(0.05, elevation) * 26, target.z + Math.sin(sunAngle) * 14 + 8);
key.target.position.set(target.x, 0, target.z);
key.intensity = 3.2 * daylight;
hemi.intensity = 0.3 + 1.2 * daylight;
(scene.background as THREE.Color).lerpColors(skyNight, skyDay, daylight);
(scene.fog as THREE.Fog).color.lerpColors(hazeNight, hazeDay, daylight);

camera.position.copy(target).add(new THREE.Vector3().setFromSphericalCoords(dist, polar, az));
camera.lookAt(target);

let frames = 0;
function tick(): void {
  requestAnimationFrame(tick);
  terrain.update(target.x, target.z, dist);
  renderer.render(scene, camera);
  frames++;
  // Chunk streaming is time-budgeted, so give it plenty of frames to finish.
  if (frames === 120) (window as unknown as { __fireReady?: boolean }).__fireReady = true;
}
tick();
