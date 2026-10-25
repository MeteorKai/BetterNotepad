import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { MASCOT_H, MASCOT_W, type MascotPos } from "../hooks/useMascot";
import { t } from "../i18n";
import { MASCOT_PALETTES, type MascotVariant } from "../mascot/variants";
import MascotPortrait from "./MascotPortrait";

interface MascotProps {
  variant: MascotVariant;
  typingTick: number;
  initialPos: MascotPos | null;
  onSavePos: (p: MascotPos) => void;
  onHide: () => void;
}

// Built per call rather than once at module load, so the lines follow the
// language picked in Settings.
function clickLines(): string[] {
  return [
    t("mascot.click1"),
    t("mascot.click2"),
    t("mascot.click3"),
    t("mascot.click4"),
    t("mascot.click5"),
  ];
}

function typingLines(): string[] {
  return [
    t("mascot.typing1"),
    t("mascot.typing2"),
    t("mascot.typing3"),
    t("mascot.typing4"),
    t("mascot.typing5"),
    t("mascot.typing6"),
    t("mascot.typing7"),
    t("mascot.typing8"),
  ];
}

const BUBBLE_MS = 2600;

function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function createGradientMap(): THREE.Texture {
  // Toon lighting samples along X, not Y. A vertical ramp produces flat grey.
  const shades = Uint8Array.from({ length: 32 }, (_, i) => Math.round(96 + 159 * Math.sqrt(i / 31)));
  const tex = new THREE.DataTexture(shades, shades.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

function createShadowMap(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, "rgba(68, 48, 78, 0.28)");
  grad.addColorStop(0.5, "rgba(68, 48, 78, 0.12)");
  grad.addColorStop(1, "rgba(68, 48, 78, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface FaceRefs {
  face: THREE.Group;
  eyeL: THREE.Group;
  eyeR: THREE.Group;
  mouth: THREE.Mesh;
  armL: THREE.Group;
  tail: THREE.Group;
}

function buildCharacter(grad: THREE.Texture, shadowMap: THREE.Texture, variant: MascotVariant): {
  root: THREE.Group;
  body: THREE.Group;
  shadow: THREE.Mesh;
  refs: FaceRefs;
} {
  const colors = MASCOT_PALETTES[variant];
  const toon = (c: string) => new THREE.MeshToonMaterial({ color: c, gradientMap: grad });
  const bodyMat = toon(colors.body);
  const pinkMat = toon(colors.pink);
  const accentMat = toon(colors.accent);
  const bellyMat = toon(colors.belly);
  const darkMat = new THREE.MeshBasicMaterial({ color: 0x493b50 });
  const whiteMat = new THREE.MeshBasicMaterial({ color: 0xfffdf8 });
  const sphere = new THREE.SphereGeometry(1, 32, 24);
  const ellipsoid = (parent: THREE.Group, material: THREE.Material, position: number[], scale: number[]) => {
    const mesh = new THREE.Mesh(sphere, material);
    mesh.position.set(position[0], position[1], position[2]);
    mesh.scale.set(scale[0], scale[1], scale[2]);
    parent.add(mesh);
    return mesh;
  };

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // A small seated body and oversized head keep the silhouette readable at 150px.
  ellipsoid(body, bodyMat, [0, 0.64, 0], [0.58, 0.64, 0.46]);
  ellipsoid(body, bellyMat, [0, 0.59, 0.41], [0.35, 0.36, 0.07]);
  for (const side of [-1, 1]) {
    ellipsoid(body, bodyMat, [side * 0.3, 0.12, 0.23], [0.24, 0.13, 0.28]);
  }
  const head = new THREE.Group();
  head.position.y = 1.57;
  body.add(head);
  ellipsoid(head, bodyMat, [0, 0, 0], [0.86, 0.72, 0.61]);

  if (variant === "bear" || variant === "rabbit") {
    for (const side of [-1, 1]) {
      const ear = new THREE.Group();
      const rabbit = variant === "rabbit";
      ear.position.set(side * (rabbit ? 0.38 : 0.57), rabbit ? 0.65 : 0.51, 0);
      ear.rotation.z = side * (rabbit ? -0.15 : -0.1);
      ellipsoid(ear, bodyMat, [0, 0, 0], rabbit ? [0.16, 0.52, 0.16] : [0.27, 0.27, 0.18]);
      ellipsoid(ear, pinkMat, [0, 0, 0.16], rabbit ? [0.08, 0.36, 0.035] : [0.15, 0.15, 0.035]);
      head.add(ear);
    }
  } else {
    const earShape = new THREE.Shape();
    earShape.moveTo(-0.25, -0.1);
    earShape.quadraticCurveTo(-0.27, 0.12, -0.12, 0.55);
    earShape.quadraticCurveTo(0, 0.72, 0.12, 0.55);
    earShape.quadraticCurveTo(0.27, 0.12, 0.25, -0.1);
    earShape.closePath();
    const earGeo = new THREE.ExtrudeGeometry(earShape, {
      depth: 0.1, bevelEnabled: true, bevelThickness: 0.06,
      bevelSize: 0.06, bevelSegments: 3, steps: 1, curveSegments: 12,
    });
    for (const side of [-1, 1]) {
      const ear = new THREE.Group();
      ear.position.set(side * 0.53, 0.43, -0.06);
      ear.rotation.z = side * -0.24;
      ear.add(new THREE.Mesh(earGeo, bodyMat));
      const inner = new THREE.Mesh(earGeo, pinkMat);
      inner.scale.set(0.56, 0.65, 0.4);
      inner.position.set(0, 0.04, 0.14);
      ear.add(inner);
      head.add(ear);
    }
  }

  if (variant === "bear") {
    ellipsoid(head, bellyMat, [0, -0.17, 0.56], [0.28, 0.17, 0.065]);
  } else if (variant === "fox") {
    for (const side of [-1, 1]) {
      ellipsoid(head, bellyMat, [side * 0.21, -0.18, 0.52], [0.3, 0.23, 0.1]);
    }
  }

  // Eye highlights live inside the eye groups, so they close with each blink.
  const face = new THREE.Group();
  head.add(face);
  const makeEye = (x: number) => {
    const eye = new THREE.Group();
    eye.position.set(x, 0.015, 0.58);
    ellipsoid(eye, darkMat, [0, 0, 0], [0.085, 0.115, 0.055]);
    ellipsoid(eye, whiteMat, [-0.025, 0.035, 0.05], [0.025, 0.03, 0.015]);
    ellipsoid(eye, whiteMat, [0.025, -0.04, 0.05], [0.011, 0.013, 0.01]);
    face.add(eye);
    return eye;
  };
  const eyeL = makeEye(-0.27);
  const eyeR = makeEye(0.27);
  for (const side of [-1, 1]) {
    ellipsoid(face, pinkMat, [side * 0.48, -0.16, 0.53], [0.14, 0.055, 0.025]);
  }
  ellipsoid(face, pinkMat, [0, -0.105, 0.63], [0.04, 0.027, 0.03]);
  const smile = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.105, -0.02, 0), new THREE.Vector3(-0.06, -0.05, 0),
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.06, -0.05, 0),
    new THREE.Vector3(0.105, -0.02, 0),
  ]);
  const mouth = new THREE.Mesh(new THREE.TubeGeometry(smile, 16, 0.012, 6, false), darkMat);
  mouth.position.set(0, -0.18, 0.64);
  face.add(mouth);

  const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.085, 10, 40), accentMat);
  scarf.rotation.x = Math.PI / 2;
  scarf.scale.set(1.25, 1, 1);
  scarf.position.y = 1.04;
  body.add(scarf);
  const scarfEnd = ellipsoid(body, accentMat, [0.22, 0.79, 0.49], [0.11, 0.26, 0.06]);
  scarfEnd.rotation.z = 0.2;
  ellipsoid(body, accentMat, [0.18, 1.01, 0.49], [0.14, 0.11, 0.08]);

  const armL = new THREE.Group();
  armL.position.set(-0.52, 0.82, 0.06);
  const handL = ellipsoid(armL, bodyMat, [-0.12, -0.13, 0.12], [0.17, 0.27, 0.18]);
  handL.rotation.z = -0.3;
  body.add(armL);
  const handR = ellipsoid(body, bodyMat, [0.64, 0.69, 0.18], [0.17, 0.27, 0.18]);
  handR.rotation.z = 0.3;

  const tail = new THREE.Group();
  tail.position.set(0.43, 0.37, -0.2);
  if (variant === "rabbit" || variant === "bear") {
    ellipsoid(tail, variant === "rabbit" ? bellyMat : bodyMat, [0.15, 0.08, 0], [0.23, 0.23, 0.23]);
  } else {
    const tailCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.46, 0.12, -0.1),
      new THREE.Vector3(0.61, 0.48, -0.1), new THREE.Vector3(0.45, 0.62, -0.1),
    ]);
    const radius = variant === "fox" ? 0.18 : 0.1;
    tail.add(new THREE.Mesh(new THREE.TubeGeometry(tailCurve, 24, radius, 8, false), bodyMat));
    ellipsoid(tail, variant === "fox" ? bellyMat : bodyMat, [0.45, 0.62, -0.1], [radius, radius, radius]);
  }
  body.add(tail);

  // A feathered, camera-facing shadow stays on the ground when the cat hops.
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, 0.38),
    new THREE.MeshBasicMaterial({ map: shadowMap, transparent: true, depthWrite: false })
  );
  shadow.position.set(0, 0.035, -0.4);

  return { root, body, shadow, refs: { face, eyeL, eyeR, mouth, armL, tail } };
}

export default function Mascot({ variant, typingTick, initialPos, onSavePos, onHide }: MascotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MascotPos>(() => {
    if (initialPos) return initialPos;
    return {
      x: Math.max(4, window.innerWidth - MASCOT_W - 18),
      y: Math.max(4, window.innerHeight - MASCOT_H - 54),
    };
  });
  const posRef = useRef(pos);
  posRef.current = pos;

  // Keep the mascot anchored to the same spot relative to the window's
  // bottom-right corner, so maximizing/shrinking the window moves it along.
  const cornerOffsetRef = useRef({ rx: 0, ry: 0 });
  useEffect(() => {
    cornerOffsetRef.current = {
      rx: window.innerWidth - (pos.x + MASCOT_W),
      ry: window.innerHeight - (pos.y + MASCOT_H),
    };
  }, [pos]);

  useEffect(() => {
    const onResize = () => {
      const { rx, ry } = cornerOffsetRef.current;
      const maxX = Math.max(4, window.innerWidth - MASCOT_W - 4);
      const maxY = Math.max(4, window.innerHeight - MASCOT_H - 4);
      setPos({
        x: clamp(window.innerWidth - rx - MASCOT_W, 4, maxX),
        y: clamp(window.innerHeight - ry - MASCOT_H, 4, maxY),
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const [bubble, setBubble] = useState<string | null>(null);
  const bubbleTimer = useRef<number | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);

  const lastTypingBubbleRef = useRef(0);
  const dragRef = useRef({ active: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 });
  const mouseRef = useRef({ x: MASCOT_W / 2, y: MASCOT_H / 2 });
  const jumpSignalRef = useRef(0);
  const lastJumpSignalRef = useRef(0);

  const showBubble = useCallback((text: string) => {
    setBubble(text);
    if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current);
    bubbleTimer.current = window.setTimeout(() => setBubble(null), BUBBLE_MS);
  }, []);

  const triggerJump = useCallback(() => {
    showBubble(pick(clickLines()));
    jumpSignalRef.current++;
  }, [showBubble]);

  // Typing encouragement (throttled + random)
  useEffect(() => {
    const now = performance.now();
    if (now - lastTypingBubbleRef.current > 40000 && Math.random() < 0.6) {
      lastTypingBubbleRef.current = now;
      showBubble(pick(typingLines()));
    }
  }, [typingTick, showBubble]);

  // Three.js scene lifecycle
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setWebglFailed(false);

    let renderer: THREE.WebGLRenderer;
    try {
      // premultipliedAlpha:false prevents WebView2 from compositing the
      // transparent canvas with an opaque white backdrop behind the mascot.
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: true,
        premultipliedAlpha: false,
      });
    } catch {
      setWebglFailed(true);
      return;
    }

    const scene = new THREE.Scene();
    const aspect = MASCOT_W / MASCOT_H;
    const camera = new THREE.OrthographicCamera(-1.8 * aspect, 1.8 * aspect, 1.8, -1.8, 0.1, 20);
    camera.position.set(0, 1.65, 6);
    camera.lookAt(0, 1.4, 0);

    scene.add(new THREE.HemisphereLight(0xfffaf2, 0xcfc3de, 1.1));
    const key = new THREE.DirectionalLight(0xfff5e9, 1.1);
    key.position.set(-3, 4, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xe6e0ff, 0.5);
    rim.position.set(-2, 1.5, -3);
    scene.add(rim);

    const grad = createGradientMap();
    const shadowMap = createShadowMap();
    const { root, body, shadow, refs } = buildCharacter(grad, shadowMap, variant);
    scene.add(shadow, root);

    // Keep the canvas transparent (clear with alpha 0) and sized to match the
    // container, so no white/black box shows around the mascot.
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(MASCOT_W, MASCOT_H);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    let raf = 0;
    let prev = performance.now();
    const anim = {
      nextBlink: performance.now() + 2000 + Math.random() * 3000,
      blinkStart: -Infinity,
      nextWave: performance.now() + 5000 + Math.random() * 6000,
      waveStart: -Infinity,
      jumpT: 1, // 1 = idle
    };

    const render = (now: number) => {
      raf = 0;
      if (document.hidden) return;
      // The small idle companion does not need to render at the monitor's Hz.
      if (now - prev < 1000 / 30) {
        raf = requestAnimationFrame(render);
        return;
      }
      const dt = Math.min((now - prev) / 1000, 0.05);
      prev = now;
      const t = now / 1000;

      // Jump signal from click
      if (jumpSignalRef.current !== lastJumpSignalRef.current) {
        lastJumpSignalRef.current = jumpSignalRef.current;
        anim.jumpT = 0;
      }

      // Float
      root.position.y = Math.sin(t * 1.7) * 0.025;

      // Breathe
      body.scale.y = 1 + Math.sin(t * 2) * 0.012;
      body.scale.x = body.scale.z = 1 - Math.sin(t * 2) * 0.006;

      // Look around
      body.rotation.y = Math.sin(t * 0.4) * 0.09;
      body.rotation.z = Math.sin(t * 0.7) * 0.018;
      refs.tail.rotation.y = Math.sin(t * 1.2) * 0.14;

      // Blink
      if (now >= anim.nextBlink) {
        anim.blinkStart = now;
        anim.nextBlink = now + 2000 + Math.random() * 3000;
      }
      const bk = (now - anim.blinkStart) / 1000;
      let eyeY = 1;
      if (bk < 0.18) {
        eyeY = 1 - Math.sin(Math.PI * bk / 0.18) * 0.94;
      }
      if (anim.jumpT < 1) eyeY = Math.min(eyeY, 0.9);
      refs.eyeL.scale.y = eyeY;
      refs.eyeR.scale.y = eyeY;

      // Wave
      if (now >= anim.nextWave) {
        anim.waveStart = now;
        anim.nextWave = now + 6000 + Math.random() * 6000;
      }
      const wk = (now - anim.waveStart) / 1000;
      if (wk < 1.2) {
        refs.armL.rotation.z = -0.5 * Math.sin(Math.PI * (wk / 1.2));
      } else {
        refs.armL.rotation.z = 0;
      }

      // Jump
      if (anim.jumpT < 1) {
        anim.jumpT += dt / 0.7;
        if (anim.jumpT >= 1) anim.jumpT = 1;
        const j = Math.sin(Math.PI * anim.jumpT);
        root.position.y += j * 0.24;
        refs.mouth.scale.y = 1 + j * 0.5;
      } else {
        refs.mouth.scale.y = 1;
      }
      shadow.scale.setScalar(1 - Math.max(0, root.position.y) * 0.35);

      // Face follows pointer
      const mx = clamp(mouseRef.current.x / MASCOT_W - 0.5, -0.5, 0.5);
      const my = clamp(mouseRef.current.y / MASCOT_H - 0.5, -0.5, 0.5);
      refs.face.position.x = THREE.MathUtils.damp(refs.face.position.x, mx * 0.08, 8, dt);
      refs.face.position.y = THREE.MathUtils.damp(refs.face.position.y, -my * 0.05, 8, dt);

      renderer.render(scene, camera);
      raf = requestAnimationFrame(render);
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (raf === 0) {
        prev = performance.now();
        raf = requestAnimationFrame(render);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    onVisibilityChange();

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      cancelAnimationFrame(raf);
      grad.dispose();
      shadowMap.dispose();
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) geometries.add(m.geometry);
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => materials.add(x));
        else if (mat) materials.add(mat);
      });
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [variant]);

  // Clear bubble timer on unmount
  useEffect(() => {
    return () => {
      if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current);
    };
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragRef.current = { active: true, moved: false, sx: e.clientX, sy: e.clientY, ox: posRef.current.x, oy: posRef.current.y };
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* synthetic or unsupported pointer */
      }
    },
    []
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      mouseRef.current = { x: e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left, y: e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top };
      const d = dragRef.current;
      if (!d.active) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) > 5) d.moved = true;
      if (d.moved) {
        setPos({
          x: clamp(d.ox + dx, 4, window.innerWidth - MASCOT_W - 4),
          y: clamp(d.oy + dy, 4, window.innerHeight - MASCOT_H - 4),
        });
      }
    },
    []
  );

  const handlePointerUp = useCallback(() => {
      const d = dragRef.current;
      if (!d.active) return;
      d.active = false;
      if (!d.moved) {
        triggerJump();
      }
      onSavePos(posRef.current);
    },
    [triggerJump, onSavePos]
  );

  return (
    <div
      ref={containerRef}
      className="group fixed z-[35] select-none cursor-grab active:cursor-grabbing"
      style={{ left: pos.x, top: pos.y, width: MASCOT_W, height: MASCOT_H, touchAction: "none" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => (mouseRef.current = { x: MASCOT_W / 2, y: MASCOT_H / 2 })}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => (dragRef.current.active = false)}
    >
      {webglFailed && (
        <MascotPortrait variant={variant} className="absolute inset-0 h-full w-full pointer-events-none" />
      )}
      <button
        type="button"
        aria-label={t("toolbar.mascot")}
        className="absolute inset-0 rounded-2xl cursor-inherit focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2"
        onClick={(e) => { if (e.detail === 0) triggerJump(); }}
      />
      {bubble && (
        <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-max max-w-[min(210px,90vw)]">
          <div role="status" className="relative bg-elevated border border-line rounded-2xl px-3 py-2 text-center text-xs leading-relaxed text-ink shadow-card">
            {bubble}
            <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-elevated border-r border-b border-line rotate-45" />
          </div>
        </div>
      )}
      <button
        type="button"
        aria-label={t("toolbar.mascotHideTitle")}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onHide}
        title={t("toolbar.mascotHideTitle")}
        className="absolute top-1 right-1 w-6 h-6 rounded-full flex items-center justify-center border border-line bg-elevated text-sub shadow-card opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:text-ink hover:bg-hover transition-opacity text-sm"
      >
        ×
      </button>
    </div>
  );
}
