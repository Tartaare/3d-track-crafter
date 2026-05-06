import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

type Mode = "edit" | "drive";
type PieceType = "straight" | "turnLeft" | "turnRight" | "rampUp" | "rampDown" | "start";

const CELL = 8;
const HEIGHT_STEP = 2;
const GRID = 20; // 20x20

interface Piece {
  type: PieceType;
  gx: number; // grid x (-GRID/2 .. GRID/2-1)
  gz: number;
  level: number; // integer height level
  rot: number; // 0..3 (× 90deg)
}

const PIECE_LABELS: Record<PieceType, string> = {
  straight: "Straight",
  turnLeft: "Turn ←",
  turnRight: "Turn →",
  rampUp: "Ramp ↑",
  rampDown: "Ramp ↓",
  start: "Start",
};

// ---------- Geometry builders (a piece occupies one CELLxCELL footprint) ----------
// Local space: piece centered on (0,0,0), road surface at y=0 by default.
// rampUp: enters at y=0 (-Z side), exits at y=HEIGHT_STEP (+Z side) — but trackmania convention: enter front (-Z) at low, exit back (+Z) at high. We'll say enter at -Z end and exit at +Z end going up.

function buildPieceMeshes(type: PieceType): { road: THREE.BufferGeometry; curbs: THREE.BufferGeometry } {
  const half = CELL / 2;
  const roadW = CELL * 0.7;
  const hw = roadW / 2;
  const curbW = (CELL - roadW) / 2;

  const road = new THREE.BufferGeometry();
  const curbs = new THREE.BufferGeometry();

  if (type === "straight" || type === "start") {
    // Flat strip along Z
    const pos = new Float32Array([
      -hw, 0, -half, hw, 0, -half, hw, 0, half, -hw, 0, half,
    ]);
    const idx = [0, 2, 1, 0, 3, 2];
    road.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    road.setIndex(idx);
    // Curbs both sides
    const curbPos: number[] = [];
    const curbIdx: number[] = [];
    const addStrip = (x0: number, x1: number) => {
      const base = curbPos.length / 3;
      curbPos.push(x0, 0.05, -half, x1, 0.05, -half, x1, 0.05, half, x0, 0.05, half);
      curbIdx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    };
    addStrip(-half, -hw);
    addStrip(hw, half);
    curbs.setAttribute("position", new THREE.Float32BufferAttribute(curbPos, 3));
    curbs.setIndex(curbIdx);
  } else if (type === "rampUp" || type === "rampDown") {
    // Ramp going from y=0 at -Z to y=HEIGHT_STEP at +Z (rampUp). rampDown opposite.
    const lo = type === "rampUp" ? 0 : HEIGHT_STEP;
    const hi = type === "rampUp" ? HEIGHT_STEP : 0;
    const pos = new Float32Array([
      -hw, lo, -half, hw, lo, -half, hw, hi, half, -hw, hi, half,
    ]);
    road.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    road.setIndex([0, 2, 1, 0, 3, 2]);
    const cp: number[] = [];
    const ci: number[] = [];
    const addStrip = (x0: number, x1: number) => {
      const b = cp.length / 3;
      cp.push(x0, lo + 0.05, -half, x1, lo + 0.05, -half, x1, hi + 0.05, half, x0, hi + 0.05, half);
      ci.push(b, b + 2, b + 1, b, b + 3, b + 2);
    };
    addStrip(-half, -hw);
    addStrip(hw, half);
    curbs.setAttribute("position", new THREE.Float32BufferAttribute(cp, 3));
    curbs.setIndex(ci);
  } else {
    // turnLeft / turnRight — quarter circle in XZ plane
    // Convention: enters at -Z (south), exits at -X (turnLeft) or +X (turnRight)
    const segs = 12;
    const sign = type === "turnLeft" ? -1 : 1;
    // Center of curve: (sign*half, 0, half) — i.e. the corner, but we want enter at south edge (0,_,-half) tangent +Z, and exit at east/west edge tangent ±X.
    // Curve center: (sign*half, 0, -half)? Let's parametrize:
    // start point on south edge midline: (0, 0, -half) tangent (0,0,+1)
    // end point on side edge midline: (sign*half, 0, 0) tangent (sign,0,0)
    // arc center: (sign*half, 0, -half), radius = half
    const cx = sign * half;
    const cz = -half;
    const r = half;
    const pos: number[] = [];
    const idx: number[] = [];
    const cp: number[] = [];
    const ci: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      // angle from start (pointing -X·sign direction from center) to end (pointing +Z from center)
      // From center, start point is at angle: atan2(-half - cz, 0 - cx) = atan2(0, -sign*half) = π or 0
      // Let's just compute directly: at t=0 point = (0,0,-half). Vector from center: (-sign*half, 0, 0)
      // At t=1 point = (sign*half, 0, 0). Vector from center: (0, 0, half)
      // Sweep angle 90°. Param: angle = π (or 0) rotating toward +Z direction.
      // Use: dir from center = rotate (-sign,0,0) by angle*sign around Y? Let's just lerp via angle.
      // Vector start (relative to center): (-sign, 0, 0), Vector end: (0, 0, 1). Angle between = 90°.
      // Rotate (-sign,0,0) toward (0,0,1) by t*90°.
      const a = t * Math.PI / 2;
      // For turnLeft (sign=-1), start vec = (1,0,0), end vec = (0,0,1). Rotation around +Y by +a takes (1,0,0)→(cos a, 0, -sin a) — wrong direction.
      // Let's do explicit: dir(t) = lerp via slerp-like in XZ plane.
      // Start v0 = (-sign, 0, 0), end v1 = (0,0,1).
      // dir = v0 * cos(a) + perp * sin(a), where perp = v1 (orthogonal to v0).
      const dx = -sign * Math.cos(a) + 0 * Math.sin(a);
      const dz = 0 * Math.cos(a) + 1 * Math.sin(a);
      const innerR = r - hw;
      const outerR = r + hw;
      const ix = cx + dx * innerR;
      const iz = cz + dz * innerR;
      const ox = cx + dx * outerR;
      const oz = cz + dz * outerR;
      pos.push(ix, 0, iz, ox, 0, oz);
      // curbs
      const innerCurbR = r - hw - curbW;
      const outerCurbR = r + hw + curbW;
      const cix = cx + dx * innerCurbR;
      const ciz = cz + dz * innerCurbR;
      const cox = cx + dx * outerCurbR;
      const coz = cz + dz * outerCurbR;
      cp.push(cix, 0.05, ciz, ix, 0.05, iz, ox, 0.05, oz, cox, 0.05, coz);
    }
    for (let i = 0; i < segs; i++) {
      const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      // For turnLeft (sign=-1) winding may flip; just emit both triangle orderings via double-sided material handled outside
      idx.push(a, c, b, b, c, d);
    }
    for (let i = 0; i < segs; i++) {
      const base = i * 4;
      const next = (i + 1) * 4;
      // inner curb quad: cix(0)-ix(1)-next ix - next cix
      idx; // unused
      ci.push(base + 0, next + 0, next + 1, base + 0, next + 1, base + 1);
      ci.push(base + 2, next + 2, next + 3, base + 2, next + 3, base + 3);
    }
    road.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    road.setIndex(idx);
    curbs.setAttribute("position", new THREE.Float32BufferAttribute(cp, 3));
    curbs.setIndex(ci);
  }

  road.computeVertexNormals();
  curbs.computeVertexNormals();
  return { road, curbs };
}

// Returns spawn transform from a Start piece
function startTransform(p: Piece): { pos: THREE.Vector3; yaw: number } {
  const wx = (p.gx + 0.5) * CELL;
  const wz = (p.gz + 0.5) * CELL;
  const wy = p.level * HEIGHT_STEP;
  // local forward (+Z) rotated by piece rot
  const yaw = (p.rot * Math.PI) / 2;
  return { pos: new THREE.Vector3(wx, wy + 1, wz), yaw };
}

interface SceneAPI {
  setMode: (m: Mode) => void;
  setSelectedType: (t: PieceType | null) => void;
  setLevel: (n: number) => void;
  rotate: () => void;
  clear: () => void;
  exportJSON: () => string;
  importJSON: (json: string) => void;
  dispose: () => void;
}

async function createScene(container: HTMLDivElement, onState: (s: { mode: Mode; level: number; rot: number }) => void): Promise<SceneAPI> {
  await RAPIER.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xfafafa);
  scene.fog = new THREE.Fog(0xfafafa, 100, 280);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 800);

  // Lights
  scene.add(new THREE.HemisphereLight(0xffffff, 0xe5e5e5, 0.7));
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(60, 120, 40);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  const s = GRID * CELL;
  Object.assign(dir.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 400 });
  dir.shadow.camera.updateProjectionMatrix();
  scene.add(dir);

  // Ground
  const groundSize = GRID * CELL;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundSize, groundSize),
    new THREE.MeshStandardMaterial({ color: 0xf3f3f3, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Grid lines
  const grid = new THREE.GridHelper(groundSize, GRID, 0xcccccc, 0xe5e5e5);
  scene.add(grid);

  // Border
  const border = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(groundSize, 0.01, groundSize)),
    new THREE.LineBasicMaterial({ color: 0xbbbbbb })
  );
  scene.add(border);

  // Materials
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8, side: THREE.DoubleSide });
  const curbMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, side: THREE.DoubleSide });
  const startMat = new THREE.MeshStandardMaterial({ color: 0x10b981, roughness: 0.6, side: THREE.DoubleSide });
  const ghostMat = new THREE.MeshStandardMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.45, side: THREE.DoubleSide });
  const ghostInvalidMat = new THREE.MeshStandardMaterial({ color: 0xef4444, transparent: true, opacity: 0.45, side: THREE.DoubleSide });
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0xe0e0e0, roughness: 1 });

  // World state
  const pieces = new Map<string, Piece>(); // key gx,gz,level
  const pieceMeshes = new Map<string, THREE.Group>();
  const piecesGroup = new THREE.Group();
  scene.add(piecesGroup);

  const keyOf = (p: { gx: number; gz: number; level: number }) => `${p.gx},${p.gz},${p.level}`;

  // Physics
  const world = new RAPIER.World({ x: 0, y: -25, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(groundSize / 2, 0.1, groundSize / 2).setTranslation(0, -0.1, 0).setFriction(1));
  const pieceColliders = new Map<string, RAPIER.Collider[]>();

  function makePieceGroup(p: Piece): THREE.Group {
    const g = new THREE.Group();
    const { road, curbs } = buildPieceMeshes(p.type);
    const roadMesh = new THREE.Mesh(road, p.type === "start" ? startMat : roadMat);
    roadMesh.receiveShadow = true;
    roadMesh.castShadow = true;
    g.add(roadMesh);
    const curbMesh = new THREE.Mesh(curbs, curbMat);
    curbMesh.receiveShadow = true;
    g.add(curbMesh);

    // Pillar if elevated
    if (p.level > 0) {
      const h = p.level * HEIGHT_STEP;
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.2, h, 1.2), pillarMat);
      pillar.position.y = -h / 2;
      pillar.castShadow = true;
      pillar.receiveShadow = true;
      g.add(pillar);
    }

    g.position.set((p.gx + 0.5) * CELL - groundSize / 2, p.level * HEIGHT_STEP, (p.gz + 0.5) * CELL - groundSize / 2);
    g.rotation.y = (p.rot * Math.PI) / 2;
    return g;
  }

  function addColliderForPiece(p: Piece, group: THREE.Group) {
    const { road } = buildPieceMeshes(p.type);
    const posAttr = road.getAttribute("position") as THREE.BufferAttribute;
    const idx = road.getIndex()!;
    // Transform vertices into world space
    group.updateMatrixWorld(true);
    const verts = new Float32Array(posAttr.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(group.matrixWorld);
      verts[i * 3] = v.x; verts[i * 3 + 1] = v.y; verts[i * 3 + 2] = v.z;
    }
    const indices = new Uint32Array(idx.array as ArrayLike<number>);
    const colDesc = RAPIER.ColliderDesc.trimesh(verts, indices).setFriction(1.4);
    const col = world.createCollider(colDesc);
    pieceColliders.set(keyOf(p), [col]);
  }

  function placePiece(p: Piece) {
    const k = keyOf(p);
    if (pieces.has(k)) removePiece(p.gx, p.gz, p.level);
    pieces.set(k, p);
    const g = makePieceGroup(p);
    pieceMeshes.set(k, g);
    piecesGroup.add(g);
    addColliderForPiece(p, g);
  }

  function removePiece(gx: number, gz: number, level: number) {
    const k = keyOf({ gx, gz, level });
    const g = pieceMeshes.get(k);
    if (g) {
      piecesGroup.remove(g);
      g.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
      pieceMeshes.delete(k);
    }
    pieces.delete(k);
    const cols = pieceColliders.get(k);
    cols?.forEach((c) => world.removeCollider(c, true));
    pieceColliders.delete(k);
  }

  // Default starter
  placePiece({ type: "start", gx: 0, gz: 0, level: 0, rot: 0 });
  placePiece({ type: "straight", gx: 0, gz: 1, level: 0, rot: 0 });
  placePiece({ type: "straight", gx: 0, gz: 2, level: 0, rot: 0 });

  // ---- Ghost preview ----
  let selectedType: PieceType | null = "straight";
  let ghostLevel = 0;
  let ghostRot = 0;
  let ghostGX = 0;
  let ghostGZ = 0;
  let ghostGroup: THREE.Group | null = null;

  function rebuildGhost() {
    if (ghostGroup) {
      piecesGroup.remove(ghostGroup);
      ghostGroup.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
      ghostGroup = null;
    }
    if (!selectedType || mode !== "edit") return;
    const p: Piece = { type: selectedType, gx: ghostGX, gz: ghostGZ, level: ghostLevel, rot: ghostRot };
    const g = new THREE.Group();
    const { road } = buildPieceMeshes(p.type);
    const m = new THREE.Mesh(road, ghostMat);
    g.add(m);
    g.position.set((p.gx + 0.5) * CELL - groundSize / 2, p.level * HEIGHT_STEP + 0.02, (p.gz + 0.5) * CELL - groundSize / 2);
    g.rotation.y = (p.rot * Math.PI) / 2;
    ghostGroup = g;
    piecesGroup.add(g);
  }

  // ---- Camera ----
  const camState = { theta: Math.PI / 4, phi: Math.PI / 3, radius: 100, target: new THREE.Vector3(0, 0, 0) };
  function updateCamera() {
    const x = camState.target.x + camState.radius * Math.sin(camState.phi) * Math.sin(camState.theta);
    const y = camState.target.y + camState.radius * Math.cos(camState.phi);
    const z = camState.target.z + camState.radius * Math.sin(camState.phi) * Math.cos(camState.theta);
    camera.position.set(x, y, z);
    camera.lookAt(camState.target);
  }
  updateCamera();

  // ---- Input ----
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let mode: Mode = "edit";
  let panning = false;
  let lastP = { x: 0, y: 0 };
  let downP = { x: 0, y: 0 };

  function setPointer(e: PointerEvent) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function gridFromPointer(): { gx: number; gz: number } | null {
    raycaster.setFromCamera(pointer, camera);
    // Intersect a virtual plane at y = ghostLevel * HEIGHT_STEP
    const planeY = ghostLevel * HEIGHT_STEP;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    const gx = Math.floor((hit.x + groundSize / 2) / CELL);
    const gz = Math.floor((hit.z + groundSize / 2) / CELL);
    if (gx < 0 || gz < 0 || gx >= GRID || gz >= GRID) return null;
    return { gx: gx - GRID / 2, gz: gz - GRID / 2 };
  }

  function emitState() {
    onState({ mode, level: ghostLevel, rot: ghostRot });
  }

  function onPointerDown(e: PointerEvent) {
    setPointer(e);
    downP = { x: e.clientX, y: e.clientY };
    if (e.button === 2 || e.shiftKey) {
      panning = true;
      lastP = { x: e.clientX, y: e.clientY };
    } else if (mode === "edit") {
      // could be drag-orbit or click-place; decide on up
      panning = true;
      lastP = { x: e.clientX, y: e.clientY };
    }
  }

  function onPointerMove(e: PointerEvent) {
    setPointer(e);
    if (panning) {
      const dx = e.clientX - lastP.x;
      const dy = e.clientY - lastP.y;
      const dist = Math.hypot(e.clientX - downP.x, e.clientY - downP.y);
      if (dist > 4) {
        camState.theta -= dx * 0.005;
        camState.phi = Math.max(0.15, Math.min(Math.PI / 2 - 0.05, camState.phi - dy * 0.005));
        lastP = { x: e.clientX, y: e.clientY };
        updateCamera();
      }
    }
    if (mode === "edit") {
      const g = gridFromPointer();
      if (g && (g.gx !== ghostGX || g.gz !== ghostGZ)) {
        ghostGX = g.gx;
        ghostGZ = g.gz;
        rebuildGhost();
      }
    }
  }

  function onPointerUp(e: PointerEvent) {
    const dist = Math.hypot(e.clientX - downP.x, e.clientY - downP.y);
    const wasClick = dist < 5;
    panning = false;
    if (!wasClick || mode !== "edit") return;

    if (e.button === 2) {
      // remove piece at hovered cell at any level (topmost)
      const g = gridFromPointer();
      if (g) {
        for (let l = 10; l >= 0; l--) {
          if (pieces.has(keyOf({ gx: g.gx, gz: g.gz, level: l }))) {
            removePiece(g.gx, g.gz, l);
            break;
          }
        }
      }
      return;
    }

    if (selectedType) {
      const g = gridFromPointer();
      if (g) {
        placePiece({ type: selectedType, gx: g.gx, gz: g.gz, level: ghostLevel, rot: ghostRot });
      }
    }
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (mode !== "edit") return;
    camState.radius = Math.max(20, Math.min(220, camState.radius + e.deltaY * 0.08));
    updateCamera();
  }

  function onContext(e: Event) { e.preventDefault(); }

  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
  renderer.domElement.addEventListener("contextmenu", onContext);

  // Keys
  const keys = new Set<string>();
  function onKeyDown(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    keys.add(k);
    if (mode === "edit") {
      if (k === "r") { ghostRot = (ghostRot + 1) % 4; rebuildGhost(); emitState(); }
      else if (k === "e") { ghostLevel = Math.min(8, ghostLevel + 1); rebuildGhost(); emitState(); }
      else if (k === "q") { ghostLevel = Math.max(0, ghostLevel - 1); rebuildGhost(); emitState(); }
    }
  }
  function onKeyUp(e: KeyboardEvent) { keys.delete(e.key.toLowerCase()); }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  // ---- Car ----
  const carGroup = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.6, 3),
    new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.4, metalness: 0.2 })
  );
  body.castShadow = true;
  body.position.y = 0.4;
  carGroup.add(body);
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.3, 0.5, 1.4),
    new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4 })
  );
  cabin.position.set(0, 0.95, -0.1);
  cabin.castShadow = true;
  carGroup.add(cabin);
  const wheelGeom = new THREE.CylinderGeometry(0.35, 0.35, 0.3, 16);
  wheelGeom.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
  const wheels: THREE.Mesh[] = [];
  [[-0.85, 0.35, 1], [0.85, 0.35, 1], [-0.85, 0.35, -1], [0.85, 0.35, -1]].forEach(([x, y, z]) => {
    const w = new THREE.Mesh(wheelGeom, wheelMat);
    w.position.set(x, y, z);
    w.castShadow = true;
    carGroup.add(w);
    wheels.push(w);
  });
  carGroup.visible = false;
  scene.add(carGroup);

  let carBody: RAPIER.RigidBody | null = null;

  function spawnCar() {
    if (carBody) { world.removeRigidBody(carBody); carBody = null; }
    // Find first start piece
    let start: Piece | null = null;
    for (const p of pieces.values()) if (p.type === "start") { start = p; break; }
    if (!start) {
      // fallback to grid origin
      start = { type: "start", gx: 0, gz: 0, level: 0, rot: 0 };
    }
    const { pos, yaw } = startTransform(start);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x - groundSize / 2, pos.y, pos.z - groundSize / 2)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(0.4)
      .setAngularDamping(2.5);
    carBody = world.createRigidBody(desc);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.8, 0.4, 1.5).setFriction(1.0).setRestitution(0.05).setDensity(1.5),
      carBody
    );
  }

  // Resize
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  rebuildGhost();
  emitState();

  // Loop
  let raf = 0;
  const clock = new THREE.Clock();
  function tick() {
    const dt = Math.min(clock.getDelta(), 1 / 30);

    if (mode === "drive" && carBody) {
      const forward = keys.has("arrowup") || keys.has("w") || keys.has("z");
      const back = keys.has("arrowdown") || keys.has("s");
      const left = keys.has("arrowleft") || keys.has("a") || keys.has("q");
      const right = keys.has("arrowright") || keys.has("d");
      const rot = carBody.rotation();
      const qq = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(qq);
      const lin = carBody.linvel();
      const speed = new THREE.Vector3(lin.x, 0, lin.z).dot(fwd);
      const m = carBody.mass();
      const accel = 28;
      if (forward) carBody.applyImpulse({ x: fwd.x * accel * dt * m, y: 0, z: fwd.z * accel * dt * m }, true);
      if (back) carBody.applyImpulse({ x: -fwd.x * accel * 0.6 * dt * m, y: 0, z: -fwd.z * accel * 0.6 * dt * m }, true);
      const steer = (left ? 1 : 0) + (right ? -1 : 0);
      if (steer !== 0 && Math.abs(speed) > 0.5) {
        const torque = steer * Math.min(Math.abs(speed), 18) * 0.7 * Math.sign(speed);
        carBody.applyTorqueImpulse({ x: 0, y: torque * dt * 60, z: 0 }, true);
      }
      // anti-skid
      const side = new THREE.Vector3(1, 0, 0).applyQuaternion(qq);
      const lateral = new THREE.Vector3(lin.x, 0, lin.z).dot(side);
      const corr = side.multiplyScalar(-lateral * 0.85 * m);
      carBody.applyImpulse({ x: corr.x, y: 0, z: corr.z }, true);
    }

    world.step();

    if (carBody) {
      const t = carBody.translation();
      const r = carBody.rotation();
      carGroup.position.set(t.x, t.y - 0.4, t.z);
      carGroup.quaternion.set(r.x, r.y, r.z, r.w);
      const lin = carBody.linvel();
      const sp = Math.hypot(lin.x, lin.z);
      wheels.forEach((w) => (w.rotation.x -= sp * dt * 1.2));
      if (t.y < -10) spawnCar();
      if (mode === "drive") {
        const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
        const back = new THREE.Vector3(0, 0, -1).applyQuaternion(q).multiplyScalar(9);
        const desired = new THREE.Vector3(t.x + back.x, t.y + 5, t.z + back.z);
        camera.position.lerp(desired, 0.12);
        camera.lookAt(t.x, t.y + 0.5, t.z);
      }
    }

    if (ghostGroup) ghostGroup.visible = mode === "edit";
    grid.visible = mode === "edit";
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }
  tick();

  return {
    setMode(m) {
      mode = m;
      carGroup.visible = m === "drive";
      if (m === "drive") spawnCar();
      else { if (carBody) { world.removeRigidBody(carBody); carBody = null; } updateCamera(); }
      rebuildGhost();
      emitState();
    },
    setSelectedType(t) { selectedType = t; rebuildGhost(); },
    setLevel(n) { ghostLevel = Math.max(0, Math.min(8, n)); rebuildGhost(); emitState(); },
    rotate() { ghostRot = (ghostRot + 1) % 4; rebuildGhost(); emitState(); },
    clear() {
      Array.from(pieces.values()).forEach((p) => removePiece(p.gx, p.gz, p.level));
      placePiece({ type: "start", gx: 0, gz: 0, level: 0, rot: 0 });
    },
    exportJSON() { return JSON.stringify({ pieces: Array.from(pieces.values()) }, null, 2); },
    importJSON(json) {
      try {
        const data = JSON.parse(json);
        if (!Array.isArray(data.pieces)) return;
        Array.from(pieces.values()).forEach((p) => removePiece(p.gx, p.gz, p.level));
        data.pieces.forEach((p: Piece) => placePiece(p));
      } catch {}
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerup", onPointerUp);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

export default function TrackEditor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<SceneAPI | null>(null);
  const [mode, setMode] = useState<Mode>("edit");
  const [selected, setSelected] = useState<PieceType>("straight");
  const [level, setLevel] = useState(0);
  const [rot, setRot] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let api: SceneAPI | null = null;
    createScene(containerRef.current, (s) => {
      setMode(s.mode); setLevel(s.level); setRot(s.rot);
    }).then((a) => {
      if (cancelled) { a.dispose(); return; }
      api = a;
      apiRef.current = a;
      a.setSelectedType("straight");
      setReady(true);
    });
    return () => { cancelled = true; api?.dispose(); apiRef.current = null; };
  }, []);

  const pieceTypes: PieceType[] = ["straight", "turnLeft", "turnRight", "rampUp", "rampDown", "start"];

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-background">
      <div ref={containerRef} className="absolute inset-0" />

      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-4">
        <div className="pointer-events-auto rounded-2xl border border-border bg-card/85 px-4 py-2 shadow-sm backdrop-blur">
          <h1 className="text-sm font-semibold tracking-tight text-foreground">Track Builder</h1>
          <p className="text-xs text-muted-foreground">Place road pieces · then drive</p>
        </div>

        <div className="pointer-events-auto flex gap-1 rounded-2xl border border-border bg-card/85 p-1 shadow-sm backdrop-blur">
          <button
            onClick={() => { setMode("edit"); apiRef.current?.setMode("edit"); }}
            className={`rounded-xl px-4 py-1.5 text-xs font-medium transition-colors ${mode === "edit" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
          >Edit</button>
          <button
            onClick={() => { setMode("drive"); apiRef.current?.setMode("drive"); }}
            className={`rounded-xl px-4 py-1.5 text-xs font-medium transition-colors ${mode === "drive" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
          >Drive</button>
        </div>
      </div>

      {/* Side panel — pieces */}
      {mode === "edit" && ready && (
        <div className="absolute left-4 top-24 w-64 space-y-4 rounded-2xl border border-border bg-card/85 p-4 shadow-sm backdrop-blur">
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pieces</div>
            <div className="grid grid-cols-2 gap-2">
              {pieceTypes.map((t) => (
                <button
                  key={t}
                  onClick={() => { setSelected(t); apiRef.current?.setSelectedType(t); }}
                  className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${selected === t ? "border-foreground bg-foreground text-background" : "border-border bg-background text-foreground hover:bg-accent"}`}
                >{PIECE_LABELS[t]}</button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-muted-foreground">Height</span>
              <div className="flex items-center gap-1">
                <button onClick={() => { const v = Math.max(0, level - 1); setLevel(v); apiRef.current?.setLevel(v); }} className="h-6 w-6 rounded border border-border bg-background hover:bg-accent">−</button>
                <span className="w-8 text-center font-mono text-foreground">{level}</span>
                <button onClick={() => { const v = Math.min(8, level + 1); setLevel(v); apiRef.current?.setLevel(v); }} className="h-6 w-6 rounded border border-border bg-background hover:bg-accent">+</button>
              </div>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-muted-foreground">Rotation</span>
              <button onClick={() => { apiRef.current?.rotate(); setRot((rot + 1) % 4); }} className="rounded border border-border bg-background px-2 py-1 font-mono hover:bg-accent">{rot * 90}°</button>
            </div>
          </div>

          <div className="space-y-2 border-t border-border pt-3">
            <button onClick={() => apiRef.current?.clear()} className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent">Clear all</button>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => {
                  const json = apiRef.current?.exportJSON() ?? "";
                  const blob = new Blob([json], { type: "application/json" });
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = "track.json";
                  a.click();
                }}
                className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90"
              >Export</button>
              <label className="cursor-pointer rounded-lg border border-border bg-background px-3 py-1.5 text-center text-xs font-medium hover:bg-accent">
                Import
                <input type="file" accept="application/json" className="hidden"
                  onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; apiRef.current?.importJSON(await f.text()); }}
                />
              </label>
            </div>
          </div>

          <div className="space-y-1 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
            <div><span className="font-mono text-foreground">Click</span> place · <span className="font-mono text-foreground">Right-click</span> remove</div>
            <div><span className="font-mono text-foreground">Drag</span> orbit · <span className="font-mono text-foreground">Wheel</span> zoom</div>
            <div><span className="font-mono text-foreground">R</span> rotate · <span className="font-mono text-foreground">Q/E</span> height</div>
          </div>
        </div>
      )}

      {mode === "drive" && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-2xl border border-border bg-card/85 px-5 py-2 text-xs text-muted-foreground shadow-sm backdrop-blur">
          <span className="font-medium text-foreground">WASD / Arrows</span> to drive
        </div>
      )}

      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      )}
    </div>
  );
}
