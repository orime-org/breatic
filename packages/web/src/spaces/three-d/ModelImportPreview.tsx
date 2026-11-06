// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { Box3, DirectionalLight, GridHelper, HemisphereLight, PerspectiveCamera, Scene, SkinnedMesh, Vector3, WebGLRenderer } from 'three';
import type { Group } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { useTranslation } from '@web/i18n/use-translation';
import { applySceneGridTheme } from '@web/spaces/three-d/viewport/scene-grid-theme';

/**
 * Render a view-local clone while the import controller owns its source template.
 * @param props - Model preview inputs.
 * @param props.root - Parsed template retained by the document's import operation.
 * @returns The finite interactive model preview.
 * @throws {never} Renderer failures are shown within the preview.
 */
export const ModelImportPreview = React.memo(function ModelImportPreview({ root }: { root: Group }): React.JSX.Element {
  const host = React.useRef<HTMLDivElement>(null);
  const [failed, setFailed] = React.useState(false);
  const t = useTranslation();

  React.useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return;
    }
    setFailed(false);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearAlpha(0);
    element.append(renderer.domElement);
    const scene = new Scene();
    const camera = new PerspectiveCamera(45, 1, 0.01, 2000);
    const orbit = new OrbitControls(camera, renderer.domElement);
    const instance = clone(root);
    const bounds = new Box3().setFromObject(instance);
    const center = bounds.getCenter(new Vector3());
    const size = bounds.getSize(new Vector3());
    const diameter = Math.max(size.length(), 0.01);
    camera.near = diameter / 1000;
    camera.far = diameter * 1000;
    const distance = diameter / (2 * Math.tan(camera.fov * Math.PI / 360));
    camera.position.copy(center).add(new Vector3(1, 0.7, 1).normalize().multiplyScalar(distance));
    orbit.target.copy(center);
    orbit.update();
    const light = new DirectionalLight(0xffffff, 2);
    light.position.set(4, 7, 5);
    const grid = new GridHelper(diameter * 3, 30);
    grid.position.set(center.x, bounds.min.y - diameter / 1000, center.z);
    scene.add(instance, grid, new HemisphereLight(0xffffff, 0x666666, 3), light);

    /**
     * Draw on demand without retaining an animation loop while hidden.
     * @throws {never} WebGL failures are represented by the preview fallback.
     */
    const draw = (): void => {
      try { renderer.render(scene, camera); } catch { setFailed(true); }
    };
    /**
     * Fit the finite preview to its measured content box.
     * @throws {never} Never directly.
     */
    const resize = (): void => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      draw();
    };
    /**
     * Draw the grid the way the scene viewport does after a theme change.
     * @throws {never} Never directly.
     */
    const theme = (): void => {
      applySceneGridTheme(grid, getComputedStyle(element).getPropertyValue('--color-muted-foreground').trim());
      draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const themeObserver = new MutationObserver(theme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    orbit.addEventListener('change', draw);
    resize();
    theme();
    return (): void => {
      observer.disconnect();
      themeObserver.disconnect();
      orbit.removeEventListener('change', draw);
      orbit.dispose();
      instance.traverse((object) => { if (object instanceof SkinnedMesh) object.skeleton.dispose(); });
      instance.removeFromParent();
      grid.geometry.dispose();
      grid.material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [root]);

  return <div className='relative h-full w-full' data-testid='model-import-preview'>
    <div ref={host} className='h-full w-full' />
    {failed && <div className='absolute inset-0 grid place-items-center bg-muted p-4 text-center text-sm text-muted-foreground'>{t('spaces.threeD.importModel.previewFailed')}</div>}
  </div>;
});
