import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { runGeneration } from "@/lib/trackGenerator";


type Mode = "edit" | "drive";

type ControlPoint = { x: number; y: number; z: number };

const DEFAULT_POINTS: ControlPoint[] = [
  { x: -30, y: 0, z: -20 },
  { x: 0, y: 0, z: -35 },
  { x: 30, y: 0, z: -20 },
  { x: 35, y: 0, z: 10 },
  { x: 10, y: 0, z: 30 },
  { x: -20, y: 0, z: 25 },
  { x: -35, y: 0, z: 0 },
];

interface SceneAPI {
  setMode: (m: Mode) => void;
  setWidth: (w: number) => void;
  addPoint: () => void;
  removePoint: () => void;
  reset: () => void;
  exportJSON: () => string;
  importJSON: (json: string) => void;
  setPoints: (pts: { x: number; z: number }[]) => void;
  dispose: () => void;
}


async function createScene(container: HTMLDivElement): Promise<SceneAPI> {
  await RAPIER.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xfafafa);
  scene.fog = new THREE.Fog(0xfafafa, 80, 200);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
  camera.position.set(0, 60, 60);
  camera.lookAt(0, 0, 0);

  // Lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0xe0e0e0, 0.7);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(40, 80, 30);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.left = -80;
  dir.shadow.camera.right = 80;
  dir.shadow.camera.top = 80;
  dir.shadow.camera.bottom = -80;
  scene.add(dir);

  // Ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(400, 80, 0xdedede, 0xeeeeee);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.6;
  scene.add(grid);

  // Track
  let trackWidth = 6;
  let points: ControlPoint[] = DEFAULT_POINTS.map((p) => ({ ...p }));

  const trackGroup = new THREE.Group();
  scene.add(trackGroup);

  const handlesGroup = new THREE.Group();
  scene.add(handlesGroup);

  const trackMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.85 });
  const lineMat = new THREE.LineBasicMaterial({ color: 0x999999 });
  const handleMat = new THREE.MeshStandardMaterial({ color: 0x3b82f6, emissive: 0x1e40af, emissiveIntensity: 0.3 });
  const handleHoverMat = new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0x991b1b, emissiveIntensity: 0.4 });

  let trackMesh: THREE.Mesh | null = null;
  let centerLine: THREE.Line | null = null;
  let curve: THREE.CatmullRomCurve3 | null = null;

  // Physics
  const world = new RAPIER.World({ x: 0, y: -20, z: 0 });
  // Ground collider
  world.createCollider(RAPIER.ColliderDesc.cuboid(200, 0.1, 200).setTranslation(0, -0.1, 0));

  let trackColliders: RAPIER.Collider[] = [];

  function rebuildTrack() {
    // Clear previous
    trackGroup.clear();
    if (trackMesh) trackMesh.geometry.dispose();
    trackColliders.forEach((c) => world.removeCollider(c, true));
    trackColliders = [];

    if (points.length < 2) return;

    const vec3Pts = points.map((p) => new THREE.Vector3(p.x, p.y + 0.05, p.z));
    curve = new THREE.CatmullRomCurve3(vec3Pts, true, "catmullrom", 0.5);

    const divisions = Math.max(60, points.length * 20);
    const spaced = curve.getSpacedPoints(divisions);

    // Precompute per-sample frame (tangent, side) and a curvature-aware
    // half-width. The inner edge of a ribbon folds onto itself whenever the
    // local radius of curvature R is smaller than width/2. We clamp the
    // half-width by R - margin so the ribbon never crosses its own centerline.
    const up = new THREE.Vector3(0, 1, 0);
    const N = divisions + 1;
    const sides: THREE.Vector3[] = new Array(N);
    const halfRaw = trackWidth / 2;
    const halfLocal: number[] = new Array(N);
    const margin = 0.15;

    for (let i = 0; i < N; i++) {
      const t = i / divisions;
      const tan = curve.getTangent(t).normalize();
      sides[i] = new THREE.Vector3().crossVectors(tan, up).normalize();
    }
    // Local radius via discrete curvature on three consecutive samples.
    for (let i = 0; i < N; i++) {
      const ip = (i - 1 + N) % N;
      const inx = (i + 1) % N;
      const v1 = new THREE.Vector3().subVectors(spaced[i], spaced[ip]);
      const v2 = new THREE.Vector3().subVectors(spaced[inx], spaced[i]);
      const l1 = v1.length(), l2 = v2.length();
      const ang = l1 > 1e-5 && l2 > 1e-5 ? v1.angleTo(v2) : 0;
      const seg = (l1 + l2) * 0.5;
      const radius = ang > 1e-4 ? seg / ang : Infinity;
      halfLocal[i] = Math.max(0.4, Math.min(halfRaw, radius - margin));
    }
    // Smooth the half-width to avoid abrupt pinches.
    const halfSmooth: number[] = new Array(N);
    for (let i = 0; i < N; i++) {
      const a = halfLocal[(i - 1 + N) % N];
      const b = halfLocal[i];
      const c = halfLocal[(i + 1) % N];
      halfSmooth[i] = (a + 2 * b + c) * 0.25;
    }

    // Build ribbon geometry
    const positions: number[] = [];
    const indices: number[] = [];
    const uvs: number[] = [];

    for (let i = 0; i < N; i++) {
      const t = i / divisions;
      const p = spaced[i];
      const side = sides[i];
      const hw = halfSmooth[i];
      const left = p.clone().addScaledVector(side, -hw);
      const right = p.clone().addScaledVector(side, hw);
      positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
      uvs.push(0, t * divisions * 0.2, 1, t * divisions * 0.2);
    }
    for (let i = 0; i < divisions; i++) {
      const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      indices.push(a, b, d, a, d, c);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    trackMesh = new THREE.Mesh(geom, trackMat);
    trackMesh.receiveShadow = true;
    trackGroup.add(trackMesh);

    // Center dashed line
    const lineGeom = new THREE.BufferGeometry().setFromPoints(spaced);
    centerLine = new THREE.Line(lineGeom, lineMat);
    centerLine.position.y = 0.06;
    trackGroup.add(centerLine);

    // Curbs (left/right strips) — use the same clamped half-width.
    const curbMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    const curbInside: number[] = [];
    const curbOutside: number[] = [];
    for (let i = 0; i < N; i++) {
      const p = spaced[i];
      const side = sides[i];
      const w = halfSmooth[i];
      const lOut = p.clone().addScaledVector(side, -(w + 0.3));
      const lIn = p.clone().addScaledVector(side, -w);
      const rIn = p.clone().addScaledVector(side, w);
      const rOut = p.clone().addScaledVector(side, w + 0.3);
      curbInside.push(lOut.x, lOut.y + 0.01, lOut.z, lIn.x, lIn.y + 0.01, lIn.z);
      curbOutside.push(rIn.x, rIn.y + 0.01, rIn.z, rOut.x, rOut.y + 0.01, rOut.z);
    }
    for (const arr of [curbInside, curbOutside]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      const idx: number[] = [];
      for (let i = 0; i < divisions; i++) {
        const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
        idx.push(a, b, d, a, d, c);
      }
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, curbMat);
      m.receiveShadow = true;
      trackGroup.add(m);
    }

    // Physics: build trimesh from track surface
    const vertsArr = new Float32Array(positions);
    const idxArr = new Uint32Array(indices);
    const colDesc = RAPIER.ColliderDesc.trimesh(vertsArr, idxArr).setFriction(1.2);
    const col = world.createCollider(colDesc);
    trackColliders.push(col);

    rebuildHandles();
  }

  function rebuildHandles() {
    handlesGroup.clear();
    points.forEach((p, i) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 16), handleMat);
      m.position.set(p.x, p.y + 0.9, p.z);
      m.userData.index = i;
      m.castShadow = true;
      handlesGroup.add(m);
    });
  }

  rebuildTrack();

  // ---- Camera controls (orbit-lite for edit mode) ----
  const camState = {
    theta: Math.PI / 4,
    phi: Math.PI / 3.5,
    radius: 90,
    target: new THREE.Vector3(0, 0, 0),
  };

  function updateCamera() {
    const x = camState.target.x + camState.radius * Math.sin(camState.phi) * Math.sin(camState.theta);
    const y = camState.target.y + camState.radius * Math.cos(camState.phi);
    const z = camState.target.z + camState.radius * Math.sin(camState.phi) * Math.cos(camState.theta);
    camera.position.set(x, y, z);
    camera.lookAt(camState.target);
  }
  updateCamera();

  // ---- Interactions ----
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let mode: Mode = "edit";
  let dragging: { index: number; mesh: THREE.Mesh } | null = null;
  let orbiting = false;
  let lastPointer = { x: 0, y: 0 };
  let hovered: THREE.Mesh | null = null;

  function setPointer(e: PointerEvent) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function intersectGround(): THREE.Vector3 | null {
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(ground);
    return hits[0]?.point ?? null;
  }

  function onPointerDown(e: PointerEvent) {
    setPointer(e);
    if (mode !== "edit") return;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(handlesGroup.children);
    if (hits.length > 0) {
      const m = hits[0].object as THREE.Mesh;
      dragging = { index: m.userData.index, mesh: m };
      renderer.domElement.setPointerCapture(e.pointerId);
    } else {
      orbiting = true;
      lastPointer = { x: e.clientX, y: e.clientY };
    }
  }

  function onPointerMove(e: PointerEvent) {
    setPointer(e);
    if (dragging) {
      const p = intersectGround();
      if (p) {
        points[dragging.index].x = p.x;
        points[dragging.index].z = p.z;
        rebuildTrack();
      }
      return;
    }
    if (orbiting) {
      const dx = e.clientX - lastPointer.x;
      const dy = e.clientY - lastPointer.y;
      lastPointer = { x: e.clientX, y: e.clientY };
      camState.theta -= dx * 0.005;
      camState.phi = Math.max(0.15, Math.min(Math.PI / 2 - 0.05, camState.phi - dy * 0.005));
      updateCamera();
      return;
    }
    if (mode === "edit") {
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(handlesGroup.children);
      if (hovered) hovered.material = handleMat;
      hovered = (hits[0]?.object as THREE.Mesh) ?? null;
      if (hovered) hovered.material = handleHoverMat;
      renderer.domElement.style.cursor = hovered ? "grab" : "default";
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (dragging) {
      try { renderer.domElement.releasePointerCapture(e.pointerId); } catch {}
    }
    dragging = null;
    orbiting = false;
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (mode !== "edit") return;
    camState.radius = Math.max(20, Math.min(200, camState.radius + e.deltaY * 0.05));
    updateCamera();
  }

  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

  // ---- Car (Rapier dynamic body) ----
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
  scene.add(carGroup);

  let carBody: RAPIER.RigidBody | null = null;
  let carCollider: RAPIER.Collider | null = null;

  function spawnCar() {
    if (carBody) world.removeRigidBody(carBody);
    const start = points[0];
    const next = points[1] ?? points[0];
    const dir2 = new THREE.Vector3(next.x - start.x, 0, next.z - start.z).normalize();
    const yaw = Math.atan2(dir2.x, dir2.z);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(start.x, 2, start.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(0.5)
      .setAngularDamping(2.0);
    carBody = world.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc.cuboid(0.8, 0.4, 1.5).setFriction(0.9).setRestitution(0.1).setDensity(1.5);
    carCollider = world.createCollider(colDesc, carBody);
  }
  spawnCar();

  // ---- Input ----
  const keys = new Set<string>();
  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    if (down) keys.add(e.key.toLowerCase());
    else keys.delete(e.key.toLowerCase());
  };
  const kd = onKey(true), ku = onKey(false);
  window.addEventListener("keydown", kd);
  window.addEventListener("keyup", ku);

  // ---- Resize ----
  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  // ---- Loop ----
  let raf = 0;
  const clock = new THREE.Clock();
  function tick() {
    const dt = Math.min(clock.getDelta(), 1 / 30);

    // Drive controls
    if (mode === "drive" && carBody) {
      const forward = keys.has("arrowup") || keys.has("w") || keys.has("z");
      const back = keys.has("arrowdown") || keys.has("s");
      const left = keys.has("arrowleft") || keys.has("a") || keys.has("q");
      const right = keys.has("arrowright") || keys.has("d");

      const rot = carBody.rotation();
      const qq = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(qq);
      const lin = carBody.linvel();
      const speed = new THREE.Vector3(lin.x, 0, lin.z).dot(fwd);

      const accel = 22;
      if (forward) {
        carBody.applyImpulse({ x: fwd.x * accel * dt * carBody.mass(), y: 0, z: fwd.z * accel * dt * carBody.mass() }, true);
      }
      if (back) {
        carBody.applyImpulse({ x: -fwd.x * accel * 0.6 * dt * carBody.mass(), y: 0, z: -fwd.z * accel * 0.6 * dt * carBody.mass() }, true);
      }
      const steer = (left ? 1 : 0) + (right ? -1 : 0);
      if (steer !== 0 && Math.abs(speed) > 0.5) {
        const torque = steer * Math.min(Math.abs(speed), 15) * 0.6;
        carBody.applyTorqueImpulse({ x: 0, y: torque * dt * 60, z: 0 }, true);
      }

      // Lateral friction (anti-skid)
      const side = new THREE.Vector3(1, 0, 0).applyQuaternion(qq);
      const lateral = new THREE.Vector3(lin.x, 0, lin.z).dot(side);
      const correction = side.multiplyScalar(-lateral * 0.85 * carBody.mass());
      carBody.applyImpulse({ x: correction.x, y: 0, z: correction.z }, true);
    }

    world.step();

    if (carBody) {
      const t = carBody.translation();
      const r = carBody.rotation();
      carGroup.position.set(t.x, t.y - 0.4, t.z);
      carGroup.quaternion.set(r.x, r.y, r.z, r.w);

      // Spin wheels visually
      const lin = carBody.linvel();
      const sp = Math.hypot(lin.x, lin.z);
      wheels.forEach((w) => (w.rotation.x -= sp * dt * 1.2));

      // Respawn if fallen
      if (t.y < -10) spawnCar();

      if (mode === "drive") {
        const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
        const back = new THREE.Vector3(0, 0, 1).applyQuaternion(q).multiplyScalar(8);
        const desired = new THREE.Vector3(t.x + back.x, t.y + 4, t.z + back.z);
        camera.position.lerp(desired, 0.12);
        camera.lookAt(t.x, t.y + 0.5, t.z);
      }
    }

    handlesGroup.visible = mode === "edit";
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }
  tick();

  return {
    setMode(m) {
      mode = m;
      if (m === "drive") spawnCar();
      else updateCamera();
    },
    setWidth(w) {
      trackWidth = w;
      rebuildTrack();
    },
    addPoint() {
      // Insert mid between last two
      const a = points[points.length - 1];
      const b = points[0];
      points.push({ x: (a.x + b.x) / 2 + 5, y: 0, z: (a.z + b.z) / 2 + 5 });
      rebuildTrack();
    },
    removePoint() {
      if (points.length > 3) {
        points.pop();
        rebuildTrack();
      }
    },
    reset() {
      points = DEFAULT_POINTS.map((p) => ({ ...p }));
      rebuildTrack();
      spawnCar();
    },
    exportJSON() {
      return JSON.stringify({ width: trackWidth, points }, null, 2);
    },
    importJSON(json) {
      try {
        const data = JSON.parse(json);
        if (Array.isArray(data.points)) {
          points = data.points;
          if (typeof data.width === "number") trackWidth = data.width;
          rebuildTrack();
        }
      } catch {}
    },
    setPoints(pts) {
      if (!Array.isArray(pts) || pts.length < 3) return;
      points = pts.map((p) => ({ x: p.x, y: 0, z: p.z }));
      rebuildTrack();
      spawnCar();
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
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
  const [width, setWidth] = useState(6);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let api: SceneAPI | null = null;
    createScene(containerRef.current).then((a) => {
      if (cancelled) {
        a.dispose();
        return;
      }
      api = a;
      apiRef.current = a;
      setReady(true);
    });
    return () => {
      cancelled = true;
      api?.dispose();
      apiRef.current = null;
    };
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-background">
      <div ref={containerRef} className="absolute inset-0" />

      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-between p-4">
        <div className="pointer-events-auto rounded-2xl border border-border bg-card/80 px-4 py-2 shadow-sm backdrop-blur">
          <h1 className="text-sm font-semibold tracking-tight text-foreground">Track Editor</h1>
          <p className="text-xs text-muted-foreground">Build & drive your circuit</p>
        </div>

        <div className="pointer-events-auto flex gap-1 rounded-2xl border border-border bg-card/80 p-1 shadow-sm backdrop-blur">
          <button
            onClick={() => { setMode("edit"); apiRef.current?.setMode("edit"); }}
            className={`rounded-xl px-4 py-1.5 text-xs font-medium transition-colors ${mode === "edit" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
          >
            Edit
          </button>
          <button
            onClick={() => { setMode("drive"); apiRef.current?.setMode("drive"); }}
            className={`rounded-xl px-4 py-1.5 text-xs font-medium transition-colors ${mode === "drive" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
          >
            Drive
          </button>
        </div>
      </div>

      {/* Side panel */}
      {mode === "edit" && ready && (
        <div className="absolute left-4 top-24 w-64 space-y-3 rounded-2xl border border-border bg-card/80 p-4 shadow-sm backdrop-blur">
          <div>
            <label className="mb-1 flex items-center justify-between text-xs font-medium text-muted-foreground">
              Track width <span className="text-foreground">{width.toFixed(1)}m</span>
            </label>
            <input
              type="range" min={3} max={14} step={0.5} value={width}
              onChange={(e) => { const v = parseFloat(e.target.value); setWidth(v); apiRef.current?.setWidth(v); }}
              className="w-full accent-foreground"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => apiRef.current?.addPoint()} className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent">+ Point</button>
            <button onClick={() => apiRef.current?.removePoint()} className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent">− Point</button>
          </div>
          <button onClick={() => apiRef.current?.reset()} className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent">Reset track</button>
          <div className="grid grid-cols-2 gap-2 pt-2">
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
              <input
                type="file" accept="application/json" className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0]; if (!f) return;
                  apiRef.current?.importJSON(await f.text());
                }}
              />
            </label>
          </div>
          <GeneratorPanel
            onGenerate={(pts) => apiRef.current?.setPoints(pts)}
          />
          <p className="pt-2 text-[11px] leading-relaxed text-muted-foreground">
            Drag the blue dots to shape the track. Drag empty space to orbit, scroll to zoom.
          </p>
        </div>
      )}


      {mode === "drive" && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-2xl border border-border bg-card/80 px-5 py-2 text-xs text-muted-foreground shadow-sm backdrop-blur">
          <span className="font-medium text-foreground">WASD / Arrows</span> to drive
        </div>
      )}

      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Loading physics…
        </div>
      )}
    </div>
  );
}

function GeneratorPanel({ onGenerate }: { onGenerate: (pts: { x: number; z: number }[]) => void }) {
  const [n, setN] = useState(18);
  const [length, setLength] = useState(220);
  const [repulsion, setRepulsion] = useState(1.2);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 10000));
  const [progress, setProgress] = useState<number | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  function generate(newSeed?: number) {
    cancelRef.current?.();
    const s = newSeed ?? seed;
    setSeed(s);
    setProgress(0);
    cancelRef.current = runGeneration(
      {
        n,
        seed: s,
        iterations: 120,
        lengthTarget: length,
        repulsion,
        minDist: Math.max(6, length / n * 0.8),
        bbox: 70,
      },
      {
        onStep: (i, total, pts) => {
          setProgress(i / total);
          if (i % 20 === 0) onGenerate(pts);
        },
        onDone: (pts) => {
          setProgress(null);
          onGenerate(pts);
        },
      }
    );
  }

  useEffect(() => () => cancelRef.current?.(), []);

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Procedural generator
      </div>
      <label className="flex items-center justify-between text-xs text-muted-foreground">
        Points <span className="text-foreground">{n}</span>
      </label>
      <input type="range" min={8} max={32} step={1} value={n}
        onChange={(e) => setN(parseInt(e.target.value))} className="w-full accent-foreground" />
      <label className="flex items-center justify-between text-xs text-muted-foreground">
        Length <span className="text-foreground">{length}m</span>
      </label>
      <input type="range" min={120} max={360} step={10} value={length}
        onChange={(e) => setLength(parseInt(e.target.value))} className="w-full accent-foreground" />
      <label className="flex items-center justify-between text-xs text-muted-foreground">
        Repulsion <span className="text-foreground">{repulsion.toFixed(1)}</span>
      </label>
      <input type="range" min={0.4} max={2.5} step={0.1} value={repulsion}
        onChange={(e) => setRepulsion(parseFloat(e.target.value))} className="w-full accent-foreground" />
      <div className="grid grid-cols-2 gap-2 pt-1">
        <button
          onClick={() => generate(seed)}
          className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90"
        >Generate</button>
        <button
          onClick={() => generate(Math.floor(Math.random() * 10000))}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent"
        >New seed</button>
      </div>
      {progress !== null && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-foreground transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      <div className="text-[10px] text-muted-foreground">Seed {seed} · repulsive-curve evolution</div>
    </div>
  );
}

