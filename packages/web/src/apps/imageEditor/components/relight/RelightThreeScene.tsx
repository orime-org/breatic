import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { cn } from '@/utils/classnames';

export type RelightViewMode = 'perspective' | 'front';
export type RelightLightPreset = 'free' | 'left' | 'top' | 'right' | 'front' | 'bottom' | 'back';

type RelightThreeSceneProps = {
  imageSrc?: string;
  rimLight: boolean;
  brightness: number;
  temperatureKelvin: number;
  viewMode: RelightViewMode;
  lightPreset: RelightLightPreset;
  className?: string;
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

const kelvinToRgb01 = (kelvin: number) => {
  const t = clamp(kelvin, 2000, 10000) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return {
    r: clamp(r / 255, 0, 1),
    g: clamp(g / 255, 0, 1),
    b: clamp(b / 255, 0, 1),
  };
};

type RelightThreeApi = {
  setViewMode: (v: RelightViewMode) => void;
  setLighting: (opts: { rimLight: boolean; brightness: number; temperatureKelvin: number }) => void;
  applyPreset: (p: RelightLightPreset) => void;
  setTexture: (src?: string) => Promise<void>;
  dispose: () => void;
  isDraggingEnabled: () => boolean;
};

type LightingDeps = {
  gridShader: THREE.ShaderMaterial;
  rimGlowShader: THREE.ShaderMaterial;
  spot: THREE.SpotLight;
  rimSpot: THREE.SpotLight;
  coreMat: THREE.MeshBasicMaterial;
  midGlowMat: THREE.MeshBasicMaterial;
  haloMat: THREE.MeshBasicMaterial;
  ambientLight: THREE.AmbientLight;
  rayMat: THREE.LineBasicMaterial;
  coneMat: THREE.ShaderMaterial;
  sphereFrontMat: THREE.MeshPhysicalMaterial;
};

type TextureDeps = {
  planeMat: THREE.MeshStandardMaterial;
  defaultTex: THREE.Texture;
  vignetteMat: THREE.MeshBasicMaterial;
  makeVignette: (w: number, h: number) => THREE.Texture;
  textureState: { planeTexture: THREE.Texture; vignetteTexture: THREE.Texture | null };
};

const setCameraViewMode = (camera: THREE.PerspectiveCamera, viewMode: RelightViewMode) => {
  if (viewMode === 'perspective') camera.position.set(6.8, 6.8, 12.2);
  else camera.position.set(0, 0, 15.2);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
};

const applySceneLighting = (
  deps: LightingDeps,
  opts: { rimLight: boolean; brightness: number; temperatureKelvin: number },
) => {
  const b01 = clamp(opts.brightness / 100, 0, 1);
  deps.gridShader.uniforms.brightness01.value = 0.6 + b01 * 0.4;
  const rgb = kelvinToRgb01(opts.temperatureKelvin);
  const color = new THREE.Color(rgb.r, rgb.g, rgb.b);
  deps.spot.color.copy(color);
  deps.rimSpot.color.copy(color);
  deps.coreMat.color.copy(color);
  deps.midGlowMat.color.copy(color);
  deps.haloMat.color.copy(color);
  deps.rimGlowShader.uniforms.glowColor.value.set(
    0.55 * (0.6 + rgb.r * 0.4),
    0.72 * (0.6 + rgb.g * 0.4),
    1.0 * (0.6 + rgb.b * 0.4),
  );
  deps.gridShader.uniforms.gridColor.value.set(
    0.45 * (0.6 + rgb.r * 0.4),
    0.48 * (0.6 + rgb.g * 0.4),
    0.55 * (0.6 + rgb.b * 0.4),
  );
  deps.ambientLight.intensity = 0.04 + b01 * 0.08;
  deps.spot.intensity = 0.2 + b01 * 10;
  deps.rimSpot.intensity = opts.rimLight ? 0.18 + b01 * 3.5 : 0;
  deps.rayMat.opacity = 0.05 + b01 * 0.35;
  deps.coneMat.uniforms.beamAlpha.value = 0.04 + b01 * 0.2;
  deps.sphereFrontMat.opacity = opts.rimLight ? 0.04 + b01 * 0.04 : 0.03;
  deps.rimGlowShader.uniforms.glowIntensity.value = 0.7 + b01 * 0.6;
};

const applyLightPreset = (
  preset: RelightLightPreset,
  presetToNode: (p: RelightLightPreset) => { lat: number; lon: number; pos: THREE.Vector3 } | null,
  applyNode: (node: { lat: number; lon: number; pos: THREE.Vector3 }) => void,
) => {
  if (preset === 'free') return;
  const node = presetToNode(preset);
  if (node) applyNode(node);
};

const applySceneTexture = async (deps: TextureDeps, src?: string) => {
  if (!src) {
    deps.planeMat.map = deps.defaultTex;
    deps.planeMat.needsUpdate = true;
    if (deps.textureState.vignetteTexture) deps.textureState.vignetteTexture.dispose?.();
    deps.textureState.vignetteTexture = deps.makeVignette(512, 400);
    deps.vignetteMat.map = deps.textureState.vignetteTexture;
    deps.vignetteMat.needsUpdate = true;
    deps.textureState.planeTexture = deps.defaultTex;
    return;
  }
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin?.('anonymous');
  const tex = await new Promise<THREE.Texture>((resolve, reject) => {
    loader.load(src, resolve, undefined, reject);
  });
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  deps.planeMat.map = tex;
  deps.planeMat.needsUpdate = true;
  deps.textureState.planeTexture = tex;
  const imgW = (tex.image as { width?: number } | undefined)?.width ?? 512;
  const imgH = (tex.image as { height?: number } | undefined)?.height ?? 400;
  if (deps.textureState.vignetteTexture) deps.textureState.vignetteTexture.dispose?.();
  deps.textureState.vignetteTexture = deps.makeVignette(imgW, imgH);
  deps.vignetteMat.map = deps.textureState.vignetteTexture;
  deps.vignetteMat.needsUpdate = true;
};

const RelightThreeScene: React.FC<RelightThreeSceneProps> = (props) => {
  const { imageSrc, rimLight, brightness, temperatureKelvin, viewMode, lightPreset, className } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lightPresetRef = useRef(lightPreset);
  const apiRef = useRef<RelightThreeApi | null>(null);

  useEffect(() => {
    lightPresetRef.current = lightPreset;
  }, [lightPreset]);

  const defaultTextureCanvas = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 400;
    const ctx = c.getContext('2d');
    if (!ctx) return c;
    const sky = ctx.createLinearGradient(0, 0, 0, 200);
    sky.addColorStop(0, '#ff6030');
    sky.addColorStop(0.4, '#cc3a20');
    sky.addColorStop(1, '#551810');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 512, 220);
    const ground = ctx.createLinearGradient(0, 220, 0, 400);
    ground.addColorStop(0, '#1a120a');
    ground.addColorStop(1, '#080503');
    ctx.fillStyle = ground;
    ctx.fillRect(0, 220, 512, 180);
    return c;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;

    const sphereRadius = 4.2;
    const planeW = 3.2;
    const planeH = 2.55;
    const border = 0.07;
    const planeCenter = new THREE.Vector3(0, -0.3, 0);

    const latDegs = [-90, -60, -30, 0, 30, 60, 90];
    const lonCount = 12;
    const lonStep = 360 / lonCount;
    const gridNodes: Array<{ lat: number; lon: number; pos: THREE.Vector3 }> = [];

    latDegs.forEach((lat) => {
      const latRad = (lat * Math.PI) / 180;
      if (lat === 90 || lat === -90) {
        gridNodes.push({ lat, lon: 0, pos: new THREE.Vector3(0, sphereRadius * Math.sin(latRad), 0) });
        return;
      }
      for (let lonDeg = 0; lonDeg < 360; lonDeg += lonStep) {
        const lonRad = (lonDeg * Math.PI) / 180;
        const r = sphereRadius * Math.cos(latRad);
        gridNodes.push({
          lat,
          lon: lonDeg,
          pos: new THREE.Vector3(r * Math.sin(lonRad), sphereRadius * Math.sin(latRad), r * Math.cos(lonRad)),
        });
      }
    });

    const nearestNode = (wp: THREE.Vector3) => {
      let best: (typeof gridNodes)[number] | null = null;
      let bestD = Infinity;
      for (const n of gridNodes) {
        const d = wp.distanceTo(n.pos);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      return best;
    };

    const presetToNode = (p: RelightLightPreset) => {
      if (p === 'free') return null;
      const map: Record<Exclude<RelightLightPreset, 'free'>, { lat: number; lon: number }> = {
        left: { lat: 0, lon: 270 },
        right: { lat: 0, lon: 90 },
        front: { lat: 0, lon: 0 },
        back: { lat: 0, lon: 180 },
        top: { lat: 90, lon: 0 },
        bottom: { lat: -90, lon: 0 },
      };
      const { lat, lon } = map[p];
      const latRad = (lat * Math.PI) / 180;
      const lonRad = (lon * Math.PI) / 180;
      const r = sphereRadius * Math.cos(latRad);
      return nearestNode(new THREE.Vector3(r * Math.sin(lonRad), sphereRadius * Math.sin(latRad), r * Math.cos(lonRad)));
    };

    const createVignetteTexture = (w: number, h: number) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const gradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) / 1.7);
      gradient.addColorStop(0, 'rgba(0,0,0,0)');
      gradient.addColorStop(0.6, 'rgba(0,0,0,0.15)');
      gradient.addColorStop(1, 'rgba(0,0,0,0.75)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
      return new THREE.CanvasTexture(c);
    };

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x16161e);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);

    const ro = new ResizeObserver(() => {
      const rect = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    });
    ro.observe(host);

    const defaultTex = new THREE.CanvasTexture(defaultTextureCanvas);
    defaultTex.colorSpace = THREE.SRGBColorSpace;
    const textureState: { planeTexture: THREE.Texture; vignetteTexture: THREE.Texture | null } = {
      planeTexture: defaultTex,
      vignetteTexture: null,
    };

    const planeMat = new THREE.MeshStandardMaterial({
      map: textureState.planeTexture,
      roughness: 0.45,
      transparent: true,
      opacity: 1.0,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(planeW, planeH), planeMat);
    plane.position.set(0, -0.3, 0);
    scene.add(plane);

    const makeVignette = (w: number, h: number) => createVignetteTexture(w, h) ?? new THREE.Texture();
    textureState.vignetteTexture = makeVignette(512, 400);
    const vignetteMat = new THREE.MeshBasicMaterial({ map: textureState.vignetteTexture, transparent: true });
    const vignettePlane = new THREE.Mesh(new THREE.PlaneGeometry(planeW, planeH), vignetteMat);
    vignettePlane.position.set(0, -0.3, 0.001);
    scene.add(vignettePlane);

    const gridSegs = 96;
    const allPoints: number[] = [];
    const parallelLats = latDegs.filter((l) => l !== 90 && l !== -90);
    parallelLats.forEach((lat) => {
      const latRad = (lat * Math.PI) / 180;
      const r = sphereRadius * Math.cos(latRad),
        y = sphereRadius * Math.sin(latRad);
      for (let i = 0; i <= gridSegs; i++) {
        const a = (i / gridSegs) * Math.PI * 2;
        allPoints.push(Math.cos(a) * r, y, Math.sin(a) * r);
      }
    });
    for (let lonDeg = 0; lonDeg < 360; lonDeg += lonStep) {
      const lon = (lonDeg * Math.PI) / 180;
      for (let i = 0; i <= gridSegs; i++) {
        const a = (i / gridSegs) * Math.PI * 2;
        allPoints.push(
          Math.sin(a) * sphereRadius * Math.cos(lon),
          Math.cos(a) * sphereRadius,
          Math.sin(a) * sphereRadius * Math.sin(lon),
        );
      }
    }
    const totalLines = parallelLats.length + lonCount;
    const lineIndices: number[] = [];
    for (let li = 0; li < totalLines; li++) {
      const base = li * (gridSegs + 1);
      for (let si = 0; si < gridSegs; si++) lineIndices.push(base + si, base + si + 1);
    }
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(allPoints, 3));
    gridGeo.setIndex(lineIndices);
    const gridShader = new THREE.ShaderMaterial({
      uniforms: {
        lightPos: { value: new THREE.Vector3(0, sphereRadius * 0.99, 0) },
        highlightRadius: { value: 2.8 },
        brightness01: { value: 0.8 },
        gridColor: { value: new THREE.Vector3(0.55, 0.58, 0.65) },
      },
      vertexShader: `
        uniform vec3 lightPos; uniform float highlightRadius; uniform float brightness01; varying float vBright;
        void main() {
          vec3 wPos = (modelMatrix * vec4(position, 1.0)).xyz;
          float hb = smoothstep(highlightRadius, 0.0, distance(wPos, lightPos));
          vBright = mix(0.008, 0.30, hb) * brightness01;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `uniform vec3 gridColor; varying float vBright; void main(){ gl_FragColor = vec4(gridColor, vBright); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const gridLines = new THREE.LineSegments(gridGeo, gridShader);
    scene.add(gridLines);

    const rimGlowShader = new THREE.ShaderMaterial({
      uniforms: {
        lightPos: { value: new THREE.Vector3(0, sphereRadius * 0.99, 0) },
        glowColor: { value: new THREE.Vector3(0.55, 0.72, 1.0) },
        glowIntensity: { value: 1.0 },
      },
      vertexShader: `varying float vFresnel; varying vec3 vWorldPos;
        void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vWorldPos = wp.xyz; vec3 vd = normalize(cameraPosition - wp.xyz); vFresnel = 1.0 - abs(dot(normalize(normal), vd)); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 lightPos; uniform vec3 glowColor; uniform float glowIntensity; varying float vFresnel; varying vec3 vWorldPos;
        void main(){ float lightD = distance(vWorldPos, lightPos) / (${sphereRadius.toFixed(1)} * 2.0); float lightGlow = pow(1.0 - clamp(lightD,0.0,1.0), 2.5) * 0.45; float rim = pow(vFresnel, 2.5); float alpha = (rim * 0.38 + lightGlow) * glowIntensity; gl_FragColor = vec4(glowColor, alpha);} `,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    });
    const rimGlowSphere = new THREE.Mesh(new THREE.SphereGeometry(sphereRadius + 0.06, 64, 64), rimGlowShader);
    scene.add(rimGlowSphere);

    const sphereFrontMat = new THREE.MeshPhysicalMaterial({ color: 0x778899, transparent: true, opacity: 0.03, side: THREE.FrontSide, depthWrite: false });
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(sphereRadius, 64, 64), sphereFrontMat));

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.06);
    scene.add(ambientLight);
    const spot = new THREE.SpotLight(0xffffff, 8);
    spot.angle = Math.PI / 9;
    const rimSpot = new THREE.SpotLight(0xffffff, 0);
    rimSpot.angle = Math.PI / 9;
    scene.add(spot, spot.target, rimSpot, rimSpot.target);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 20), coreMat);
    scene.add(core);
    const midGlowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false });
    const midGlow = new THREE.Mesh(new THREE.SphereGeometry(0.27, 24, 24), midGlowMat);
    scene.add(midGlow);
    const haloMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false });
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.48, 24, 24), haloMat);
    scene.add(halo);

    const rayPositions = new Float32Array(6);
    const rayGeo = new THREE.BufferGeometry();
    rayGeo.setAttribute('position', new THREE.BufferAttribute(rayPositions, 3));
    const rayMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending });
    scene.add(new THREE.Line(rayGeo, rayMat));
    const coneGeo = new THREE.BufferGeometry();
    const coneMat = new THREE.ShaderMaterial({
      uniforms: { beamAlpha: { value: 0.12 } },
      vertexShader: 'attribute float alpha; varying float vAlpha; void main(){ vAlpha=alpha; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'uniform float beamAlpha; varying float vAlpha; void main(){ gl_FragColor=vec4(1.0,1.0,1.0,vAlpha*beamAlpha); }',
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    scene.add(new THREE.Mesh(coneGeo, coneMat));

    let activeNode: (typeof gridNodes)[number] | null = null;
    const applyNode = (node: (typeof gridNodes)[number]) => {
      activeNode = node;
      const { x: lx, y: ly, z: lz } = node.pos;
      spot.position.set(lx, ly, lz);
      rimSpot.position.set(-lx, ly, -lz);
      core.position.set(lx, ly, lz);
      midGlow.position.set(lx, ly, lz);
      halo.position.set(lx, ly, lz);
      gridShader.uniforms.lightPos.value.set(lx, ly, lz);
      rimGlowShader.uniforms.lightPos.value.set(lx, ly, lz);
      rayPositions[0] = lx;
      rayPositions[1] = ly;
      rayPositions[2] = lz;
      rayPositions[3] = planeCenter.x;
      rayPositions[4] = planeCenter.y;
      rayPositions[5] = planeCenter.z;
      (rayGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      const hw = planeW / 2 + border;
      const hh = planeH / 2 + border;
      const corners: [number, number, number][] = [[-hw, -0.3 - hh, 0], [hw, -0.3 - hh, 0], [hw, -0.3 + hh, 0], [-hw, -0.3 + hh, 0]];
      const pos: number[] = [];
      const alp: number[] = [];
      for (let i = 0; i < 4; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % 4];
        pos.push(lx, ly, lz, a[0], a[1], a[2], b[0], b[1], b[2]);
        alp.push(1, 0, 0);
      }
      coneGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      coneGeo.setAttribute('alpha', new THREE.Float32BufferAttribute(alp, 1));
    };

    applyNode(presetToNode('right') ?? gridNodes.find((n) => n.lat === 90) ?? gridNodes[0]);

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let dragging = false;
    let activePointerId: number | null = null;
    const sphereHit = new THREE.Mesh(new THREE.SphereGeometry(sphereRadius, 48, 48), new THREE.MeshBasicMaterial({ visible: false }));
    scene.add(sphereHit);
    const hitDetectMesh = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 8), new THREE.MeshBasicMaterial({ visible: false }));
    scene.add(hitDetectMesh);

    const getMousePos = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    };
    const setCursor = (value: string) => { canvas.style.cursor = value; };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType !== 'touch') return;
      if (!apiRef.current?.isDraggingEnabled()) return;
      getMousePos(e); raycaster.setFromCamera(mouse, camera);
      if (raycaster.intersectObject(hitDetectMesh, false).length > 0) { dragging = true; activePointerId = e.pointerId; setCursor('grabbing'); }
    };
    const onPointerMove = (e: PointerEvent) => {
      getMousePos(e); raycaster.setFromCamera(mouse, camera);
      if (dragging && activePointerId === e.pointerId) {
        const hits = raycaster.intersectObject(sphereHit, false);
        if (hits.length > 0) { const node = nearestNode(hits[0].point); if (node && node !== activeNode) applyNode(node); }
        return;
      }
      const onHead = raycaster.intersectObject(hitDetectMesh, false).length > 0;
      if (apiRef.current?.isDraggingEnabled() && onHead) setCursor('grab');
      else setCursor('default');
    };
    const endDrag = (e: PointerEvent) => {
      if (activePointerId !== e.pointerId) return;
      dragging = false; activePointerId = null; setCursor('default');
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    const lightingDeps: LightingDeps = {
      gridShader, rimGlowShader, spot, rimSpot, coreMat, midGlowMat, haloMat, ambientLight, rayMat, coneMat, sphereFrontMat,
    };
    const textureDeps: TextureDeps = { planeMat, defaultTex, vignetteMat, makeVignette, textureState };
    const setViewModeImpl = (v: RelightViewMode) => setCameraViewMode(camera, v);
    const applyLighting = (opts: { rimLight: boolean; brightness: number; temperatureKelvin: number }) => applySceneLighting(lightingDeps, opts);
    const setTextureImpl = async (src?: string) => applySceneTexture(textureDeps, src);
    const applyPreset = (p: RelightLightPreset) => applyLightPreset(p, presetToNode, applyNode);

    setViewModeImpl(viewMode);
    applyLighting({ rimLight, brightness, temperatureKelvin });
    applyPreset(lightPreset);

    apiRef.current = {
      setViewMode: setViewModeImpl,
      setLighting: applyLighting,
      applyPreset,
      setTexture: setTextureImpl,
      isDraggingEnabled: () => lightPresetRef.current === 'free',
      dispose: () => {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', endDrag);
        canvas.removeEventListener('pointercancel', endDrag);
        ro.disconnect();
        renderer.dispose();
      },
    };

    let t = 0;
    let frameId = 0;
    const tick = () => {
      frameId = requestAnimationFrame(tick);
      t += 0.016;
      haloMat.opacity = 0.06 + Math.sin(t * 1.8) * 0.025;
      midGlowMat.opacity = 0.16 + Math.sin(t * 2.2) * 0.04;
      hitDetectMesh.position.copy(core.position);
      renderer.render(scene, camera);
    };
    tick();
    return () => {
      cancelAnimationFrame(frameId);
      apiRef.current?.dispose();
      apiRef.current = null;
    };
  }, [defaultTextureCanvas]);

  useEffect(() => {
    apiRef.current?.setViewMode(viewMode);
  }, [viewMode]);
  useEffect(() => {
    apiRef.current?.setLighting({ rimLight, brightness, temperatureKelvin });
  }, [rimLight, brightness, temperatureKelvin]);
  useEffect(() => {
    apiRef.current?.applyPreset(lightPreset);
  }, [lightPreset]);
  useEffect(() => {
    void apiRef.current?.setTexture(imageSrc);
  }, [imageSrc]);

  return (
    <div ref={hostRef} className={cn('h-full w-full', className)}>
      <canvas ref={canvasRef} className='h-full w-full' />
    </div>
  );
};

export default RelightThreeScene;
