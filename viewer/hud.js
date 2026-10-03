/* global THREE */
(() => {
  const viewer = window.mcrlViewer;
  const renderer = window.mcrlRenderer;
  const names = new Map();
  const labels = new Map();
  const rings = new Map();
  const animations = new Map();
  const initializedRigs = new WeakSet();
  const actionNames = ['HOLD + ATTACK', 'APPROACH', 'SPRINT', 'STRAFE LEFT', 'STRAFE RIGHT', 'APPROACH LEFT', 'APPROACH RIGHT', 'RETREAT', 'RETREAT LEFT', 'RETREAT RIGHT', 'SPRINT JUMP', 'JUMP LEFT', 'JUMP RIGHT', 'IDLE'];
  let state = { players: [] };
  let rendered = false;
  viewer.camera.fov = 48;
  viewer.camera.updateProjectionMatrix();
  window.mcrlSocket.on('player', ({ id, name }) => names.set(name, id));
  window.mcrlSocket.on('combatAnimation', ({ id, type }) => {
    const animation = animations.get(id) || {};
    animation[type] = performance.now();
    animations.set(id, animation);
  });
  window.mcrlSocket.on('loadChunk', () => { rendered = true; });
  window.mcrlSocket.on('entity', packet => {
    const mesh = viewer.entities.entities[packet.id];
    if (mesh && packet.yaw === 0) mesh.rotation.y = 0;
  });
  const number = (value, places = 0) => Number(value || 0).toFixed(places);
  const players = () => Array.isArray(state.players) ? state.players : Object.values(state.players || {});

  async function poll() {
    try {
      const response = await fetch('/state', { cache: 'no-store' });
      if (!response.ok) throw new Error('bridge unavailable');
      state = await response.json();
      window.mcrlState = state;
      const list = players();
      for (const [index, name] of list.map(p => p.name || p.username).entries()) {
        const player = list.find(p => p.name === name || p.username === name) || list[index];
        if (!player) continue;
        const card = document.getElementById(index ? 'blue' : 'red');
        card.querySelector('h2').textContent = name;
        card.querySelector('.health i').style.width = `${Math.max(0, Math.min(100, Number(player.health) * 5))}%`;
        card.querySelector('.metrics').textContent = `HP ${number(player.health, 1)} / 20    HITS ${number(player.hits)}\nDEALT ${number(player.damageDealt, 1)}  TAKEN ${number(player.damageTaken, 1)}\nDIST ${number(player.distance, 1)}b   CHARGE ${number(player.cooldown * 100)}%`;
        const action = typeof player.action === 'object' ? JSON.stringify(player.action) : (actionNames[player.action] ?? player.action ?? '-');
        card.querySelector('.action').textContent = `ACTION ${action}`;
      }
      document.getElementById('round').textContent = `EPISODE ${state.episode ?? '-'}  /  ${String(state.phase || 'evaluation').toUpperCase()}  /  ${number(state.elapsed, 1)}s`;
      const winner = state.winner ?? (state.terminal?.winner === null ? null : list[state.terminal?.winner]?.name);
      document.getElementById('result').textContent = state.done ? `ROUND ENDED / ${state.terminal?.doubleKO ? 'DOUBLE KO' : winner || state.terminal?.reason || state.reason || 'terminal'}` : 'Real server entity positions and health';
    } catch {
      document.getElementById('round').textContent = 'Waiting for bridge telemetry...';
    }
    setTimeout(poll, 100);
  }
  poll();

  function frame() {
    requestAnimationFrame(frame);
    const list = players().filter(p => p.position && Number.isFinite(p.position.x));
    const center = list.length ? new THREE.Vector3(list.reduce((sum, p) => sum + p.position.x, 0) / list.length, 64.8, list.reduce((sum, p) => sum + p.position.z, 0) / list.length) : new THREE.Vector3(0, 64.8, 0);
    const separation = list.length > 1 ? Math.hypot(list[0].position.x - list[1].position.x, list[0].position.z - list[1].position.z) : 4;
    const distance = Math.max(10.5, Math.min(30, separation * 1.3 + 5));
    const camera = center.clone().add(new THREE.Vector3(distance * 0.55, distance * 0.8, distance));
    viewer.camera.position.lerp(camera, 0.045);
    viewer.camera.lookAt(center);
    viewer.camera.updateMatrixWorld();
    const currentNames = list.map(p => p.name || p.username);
    for (const [name, label] of labels) {
      if (!currentNames.includes(name)) { label.style.display = 'none'; rings.get(name).visible = false; }
    }
    for (const [index, name] of currentNames.entries()) {
      const id = names.get(name);
      const entity = viewer.entities.entities[id];
      if (!entity) {
        if (labels.has(name)) labels.get(name).style.display = 'none';
        if (rings.has(name)) rings.get(name).visible = false;
        continue;
      }
      const telemetry = list.find(p => p.name === name || p.username === name);
      const animation = animations.get(id) || {};
      const time = performance.now();
      const speed = telemetry?.velocity ? Math.hypot(telemetry.velocity.x, telemetry.velocity.z) : 0;
      const stride = Math.sin(time / 110) * Math.min(0.8, speed * 4);
      const swingProgress = (time - (animation.swing ?? -Infinity)) / 300;
      const punch = swingProgress < 1 ? Math.sin(Math.max(0, swingProgress) * Math.PI) * 1.6 : 0;
      entity.traverse(child => {
        if (child.isSprite) child.visible = false;
        if (!child.isSkinnedMesh || child.skeleton.bones.length < 17) return;
        const bones = child.skeleton.bones;
        if (!initializedRigs.has(child)) {
          // The packaged model uses absolute pivots as parented local positions.
          // Static bind matrices hide that error; animation needs relative pivots.
          const pivots = bones.map(bone => bone.position.clone());
          for (const [boneIndex, bone] of bones.entries()) {
            const parentIndex = bones.indexOf(bone.parent);
            if (parentIndex >= 0) bone.position.sub(pivots[parentIndex]);
            bone.rotation.set(0, 0, 0);
          }
          child.updateWorldMatrix(true, true);
          child.bind(child.skeleton);
          initializedRigs.add(child);
        }
        // Indices match the pinned default player geometry, including its layers.
        bones[6].rotation.x = stride;
        bones[9].rotation.x = -stride - punch;
        bones[12].rotation.x = -stride;
        bones[14].rotation.x = stride;
        bones[3].rotation.x = -(telemetry?.pitch || 0);
        child.material.color.setHex(time - (animation.hurt ?? -Infinity) < 220 ? 0xff7777 : 0xffffff);
      });
      const color = index ? 0x55b9ff : 0xff635e;
      if (!labels.has(name)) {
        const label = document.createElement('div');
        label.className = 'label';
        label.style.borderColor = index ? '#55b9ff' : '#ff635e';
        label.textContent = name;
        document.getElementById('labels').append(label);
        labels.set(name, label);
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.48, 0.59, 32), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2;
        viewer.scene.add(ring);
        rings.set(name, ring);
      }
      rings.get(name).position.set(entity.position.x, entity.position.y + 0.025, entity.position.z);
      rings.get(name).visible = true;
      const projected = entity.position.clone().add(new THREE.Vector3(0, 2.2, 0)).project(viewer.camera);
      const label = labels.get(name);
      label.style.left = `${(projected.x + 1) * innerWidth / 2}px`;
      label.style.top = `${(1 - projected.y) * innerHeight / 2}px`;
      label.style.display = projected.z > 1 ? 'none' : 'block';
    }
    window.mcrlReady = rendered && currentNames.length === 2 && currentNames.every(name => names.has(name)) && Boolean(viewer.version);
    window.mcrlRenderInfo = { ready: window.mcrlReady, entities: names.size, chunks: Object.keys(viewer.world.loadedChunks || {}).length, width: renderer.domElement.width };
  }
  viewer.camera.position.set(8, 77, 14);
  frame();
})();
