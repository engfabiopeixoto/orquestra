import { useEffect, useRef, useState } from 'react';
import type { FlowGeometry } from '@orquestra/shared/flow';

export function GeometryPreview({ geometry }: { geometry: FlowGeometry }) {
  const mount = useRef<HTMLDivElement>(null); const [error, setError] = useState(''); const [selection, setSelection] = useState('');
  useEffect(() => {
    let disposed = false; let cleanup = () => {};
    void (async () => {
      const [T, { OrbitControls }] = await Promise.all([import('three'), import('three/examples/jsm/controls/OrbitControls.js')]);
      const target = mount.current; if (disposed || !target) return;
      const renderer = new T.WebGLRenderer({ antialias: true, alpha: false }); renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); renderer.setClearColor('#10151e'); target.appendChild(renderer.domElement);
      const scene = new T.Scene(); const camera = new T.PerspectiveCamera(45, 1, 0.001, 1000000); camera.up.set(0, 0, 1);
      const objects = new T.Group(); const factor = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048 }[geometry.units];
      objects.scale.setScalar(factor); objects.position.fromArray(geometry.origin).multiplyScalar(factor);
      if (geometry.transform) { const matrix = new T.Matrix4().fromArray(geometry.transform); objects.applyMatrix4(matrix); }
      const pickable: import('three').Object3D[] = [];
      for (const item of geometry.items) {
        const buffer = new T.BufferGeometry(); const points = item.kind === 'mesh' ? item.vertices : item.points;
        buffer.setAttribute('position', new T.Float32BufferAttribute(points.flat(), 3));
        let object: import('three').Object3D;
        if (item.kind === 'mesh') { buffer.setIndex(item.faces.flat()); buffer.computeVertexNormals(); object = new T.Mesh(buffer, new T.MeshStandardMaterial({ color: item.color, side: T.DoubleSide, roughness: 0.8 })); }
        else if (item.kind === 'line') object = new T.Line(buffer, new T.LineBasicMaterial({ color: item.color }));
        else object = new T.Points(buffer, new T.PointsMaterial({ color: item.color, size: 0.06, sizeAttenuation: true }));
        object.name = item.id; objects.add(object); pickable.push(object);
      }
      scene.add(objects, new T.HemisphereLight('#f5f8ff', '#293449', 2)); const light = new T.DirectionalLight('#ffffff', 2); light.position.set(4, -3, 8); scene.add(light);
      const box = new T.Box3().setFromObject(objects); const center = box.isEmpty() ? new T.Vector3() : box.getCenter(new T.Vector3()); const size = Math.max(0.1, box.isEmpty() ? 1 : box.getSize(new T.Vector3()).length());
      camera.near = Math.max(size / 10000, 0.00001); camera.far = Math.max(size * 100, 100); camera.position.copy(center).add(new T.Vector3(size, -size, size * 0.7)); camera.updateProjectionMatrix();
      const grid = new T.GridHelper(size * 2, 20, '#405476', '#253247'); grid.rotation.x = Math.PI / 2; grid.position.copy(center); grid.position.z = box.isEmpty() ? 0 : box.min.z; scene.add(grid, new T.AxesHelper(size / 4));
      const controls = new OrbitControls(camera, renderer.domElement); controls.target.copy(center); controls.enableDamping = false; controls.update();
      const render = () => { if (!disposed) renderer.render(scene, camera); }; controls.addEventListener('change', render);
      const resize = new ResizeObserver(() => { const width = target.clientWidth, height = target.clientHeight; if (!width || !height) return; renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); render(); }); resize.observe(target);
      const ray = new T.Raycaster(); ray.params.Line.threshold = size / 100; ray.params.Points.threshold = size / 100;
      let pressed: { x: number; y: number } | null = null;
      const down = (event: PointerEvent) => { pressed = { x: event.clientX, y: event.clientY }; };
      const up = (event: PointerEvent) => { if (!pressed || Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 4) return; const rect = renderer.domElement.getBoundingClientRect(); ray.setFromCamera(new T.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera); setSelection(ray.intersectObjects(pickable)[0]?.object.name ?? ''); };
      renderer.domElement.addEventListener('pointerdown', down); renderer.domElement.addEventListener('pointerup', up);
      cleanup = () => { resize.disconnect(); controls.dispose(); renderer.domElement.removeEventListener('pointerdown', down); renderer.domElement.removeEventListener('pointerup', up); scene.traverse((object) => { const drawable = object as import('three').Mesh; drawable.geometry?.dispose(); const materials = drawable.material; if (Array.isArray(materials)) materials.forEach((material) => material.dispose()); else materials?.dispose(); }); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); };
      if (disposed) cleanup(); else render();
    })().catch((error) => { if (!disposed) setError(`Prévia 3D indisponível: ${(error as Error).message}`); });
    return () => { disposed = true; cleanup(); };
  }, [geometry]);
  return <><div ref={mount} className="flow-3d" data-testid="flow-3d">{error ? <p role="alert">{error}</p> : null}</div><p className="muted">Arraste para orbitar · botão direito para mover · roda para aproximar · clique para selecionar. Z para cima; unidade {geometry.units}; origem [{geometry.origin.join(', ')}].{selection ? ` Selecionado: ${selection}` : ''}</p></>;
}
