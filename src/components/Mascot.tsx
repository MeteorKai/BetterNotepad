import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { MASCOT_H, MASCOT_W, type MascotPos } from "../hooks/useMascot";
import { t } from "../i18n";

interface MascotProps {
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
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.55, "#c9c2d8");
  grad.addColorStop(1, "#8f88a0");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

interface FaceRefs {
  face: THREE.Group;
  eyeL: THREE.Mesh;
  eyeR: THREE.Mesh;
  mouth: THREE.Mesh;
  armL: THREE.Group;
}

function buildCharacter(grad: THREE.Texture): {
  root: THREE.Group;
  body: THREE.Group;
  refs: FaceRefs;
} {
  const toon = (c: number) => new THREE.MeshToonMaterial({ color: c, gradientMap: grad });
  const bodyMat = toon(0xfff0df);
  const darkMat = toon(0x342c48);
  const pinkMat = toon(0xffb7c5);
  const accentMat = toon(0xb7a8f5);
  const whiteMat = toon(0xffffff);
  const bellyMat = toon(0xfff8ef);

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // Rounded torso
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.9, 48, 48), bodyMat);
  torso.scale.set(1, 0.95, 1);
  torso.position.y = 0.85;
  body.add(torso);

  // Belly patch
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 32), bellyMat);
  belly.position.set(0, 0.58, 0.68);
  belly.scale.set(1, 0.75, 0.5);
  body.add(belly);

  // Antenna
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.28, 12), accentMat);
  stick.position.set(0, 1.78, 0);
  body.add(stick);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 20), accentMat);
  tip.position.set(0, 1.96, 0);
  body.add(tip);

  // Face group (eyes/cheeks/mouth) so it can track the pointer subtly
  const face = new THREE.Group();
  face.position.set(0, 1.02, 0);
  body.add(face);

  const eyeGeo = new THREE.SphereGeometry(0.15, 24, 24);
  const eyeL = new THREE.Mesh(eyeGeo, darkMat);
  eyeL.position.set(-0.3, 0, 0.78);
  const eyeR = new THREE.Mesh(eyeGeo, darkMat);
  eyeR.position.set(0.3, 0, 0.78);
  face.add(eyeL, eyeR);

  const hlGeo = new THREE.SphereGeometry(0.05, 12, 12);
  const hlL = new THREE.Mesh(hlGeo, whiteMat);
  hlL.position.set(-0.34, 0.06, 0.93);
  const hlR = new THREE.Mesh(hlGeo, whiteMat);
  hlR.position.set(0.26, 0.06, 0.93);
  face.add(hlL, hlR);

  const cheekGeo = new THREE.SphereGeometry(0.1, 16, 16);
  const cheekL = new THREE.Mesh(cheekGeo, pinkMat);
  cheekL.position.set(-0.64, -0.26, 0.64);
  cheekL.scale.set(1, 0.7, 0.4);
  const cheekR = new THREE.Mesh(cheekGeo, pinkMat);
  cheekR.position.set(0.64, -0.26, 0.64);
  cheekR.scale.set(1, 0.7, 0.4);
  face.add(cheekL, cheekR);

  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 16), darkMat);
  mouth.position.set(0, -0.3, 0.92);
  mouth.scale.set(1.5, 0.75, 0.5);
  face.add(mouth);

  // Arms (pivot groups so a hand can wave)
  const armGeo = new THREE.SphereGeometry(0.16, 20, 20);
  const armL = new THREE.Group();
  armL.position.set(-0.9, 0.8, 0);
  const handL = new THREE.Mesh(armGeo, bodyMat);
  handL.position.set(-0.22, -0.05, 0);
  armL.add(handL);
  const armR = new THREE.Group();
  armR.position.set(0.9, 0.8, 0);
  const handR = new THREE.Mesh(armGeo, bodyMat);
  handR.position.set(0.22, -0.05, 0);
  armR.add(handR);
  body.add(armL, armR);

  // Soft ground shadow
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.85, 32),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.01;
  root.add(shadow);

  return { root, body, refs: { face, eyeL, eyeR, mouth, armL } };
}

export default function Mascot({ typingTick, initialPos, onSavePos, onHide }: MascotProps) {
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
  const mouseRef = useRef({ x: 0, y: 0 });
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
    const camera = new THREE.PerspectiveCamera(38, aspect, 0.1, 100);
    camera.position.set(0, 1.45, 5.4);
    camera.lookAt(0, 1.12, 0);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xd8ccf0, 0.95));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(2, 3, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xe6e0ff, 0.5);
    rim.position.set(-2, 1.5, -3);
    scene.add(rim);

    const grad = createGradientMap();
    const { root, body, refs } = buildCharacter(grad);
    scene.add(root);

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
      blinkStart: 0,
      nextWave: performance.now() + 3000 + Math.random() * 6000,
      waveStart: 0,
      jumpT: 1, // 1 = idle
    };

    const render = (now: number) => {
      const dt = Math.min((now - prev) / 1000, 0.05);
      prev = now;
      const t = now / 1000;

      // Jump signal from click
      if (jumpSignalRef.current !== lastJumpSignalRef.current) {
        lastJumpSignalRef.current = jumpSignalRef.current;
        anim.jumpT = 0;
      }

      // Float
      root.position.y = Math.sin(t * 1.7) * 0.05;

      // Breathe
      body.scale.y = 1 + Math.sin(t * 2.4) * 0.022;
      body.scale.x = 1 - Math.sin(t * 2.4) * 0.011;
      body.scale.z = 1 - Math.sin(t * 2.4) * 0.011;

      // Look around
      body.rotation.y = Math.sin(t * 0.4) * 0.3;

      // Blink
      if (now >= anim.nextBlink) {
        anim.blinkStart = now;
        anim.nextBlink = now + 2000 + Math.random() * 3000;
      }
      const bk = (now - anim.blinkStart) / 1000;
      let eyeY = 1;
      if (bk < 0.18) {
        const half = bk < 0.09 ? bk / 0.09 : (0.18 - bk) / 0.09;
        eyeY = 0.12 + 0.88 * clamp(half, 0, 1);
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
        root.position.y += j * 0.5;
        refs.mouth.scale.y = 0.75 + j * 1.1;
      } else {
        refs.mouth.scale.y = 0.75 + Math.sin(t * 2.4) * 0.05;
      }

      // Face follows pointer
      const mx = mouseRef.current.x / MASCOT_W - 0.5;
      const my = mouseRef.current.y / MASCOT_H - 0.5;
      refs.face.position.x = mx * 0.1;
      refs.face.position.y = 1.02 - my * 0.06;

      renderer.render(scene, camera);
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      grad.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

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

  if (webglFailed) {
    return (
      <div className="fixed z-[35] select-none" style={{ left: pos.x, top: pos.y, width: MASCOT_W, height: MASCOT_H }}>
        <div className="text-4xl flex items-center justify-center h-full">🐾</div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="fixed z-[35] select-none cursor-grab active:cursor-grabbing"
      style={{ left: pos.x, top: pos.y, width: MASCOT_W, height: MASCOT_H, touchAction: "none" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => (dragRef.current.active = false)}
    >
      {bubble && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 whitespace-nowrap">
          <div className="relative bg-elevated border border-line rounded-xl px-3 py-1.5 text-sm text-ink shadow-card">
            {bubble}
            <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-elevated border-r border-b border-line rotate-45" />
          </div>
        </div>
      )}
      <div
        onClick={onHide}
        title={t("toolbar.mascotHideTitle")}
        className="absolute top-1 right-1 w-5 h-5 rounded-md flex items-center justify-center text-faint hover:text-ink hover:bg-hover transition-colors text-xs"
      >
        ×
      </div>
    </div>
  );
}
