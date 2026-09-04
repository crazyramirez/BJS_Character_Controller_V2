// Conservative fallback for numbered game rigs. Names alone cannot identify
// anatomy: require two five-finger hands, connected arm chains, an upright
// torso and two matching legs. Ambiguous/non-humanoid graphs stay unresolved.
// This only identifies existing nodes; it never changes vertices or weights.
export function inferNumberedHumanoid(nodes) {
  const joints = new Set(nodes);
  const numbered = nodes.filter(n => /^\d+(?:_\d+)?$/.test(n.getName()));
  if (numbered.length < 45 || numbered.length < nodes.length * 0.9) return new Map();
  const children = n => n.listChildren().filter(c => joints.has(c));
  const parent = new Map();
  for (const n of nodes) for (const c of children(n)) parent.set(c, n);
  const pos = new Map(nodes.map(n => [n, n.getWorldTranslation()]));
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const len = a => Math.hypot(...a);
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const distance = (a, b) => len(sub(pos.get(a), pos.get(b)));
  const height = Math.max(...nodes.map(n => pos.get(n)[1])) - Math.min(...nodes.map(n => pos.get(n)[1]));
  if (!(height > 1e-6)) return new Map();
  const ancestors = n => { const path = []; for (; n; n = parent.get(n)) path.push(n); return path; };
  const common = (a, b) => { const chain = new Set(ancestors(b)); return ancestors(a).find(n => chain.has(n)); };
  const pathFrom = (root, tip) => ancestors(tip).slice(0, ancestors(tip).indexOf(root)).reverse();

  const hands = [];
  for (const palm of nodes) {
    if (children(palm).length < 3 || children(palm).length > 5) continue;
    const paths = [];
    let truncated = false;
    const visit = (n, path) => {
      if (path.length > 5 || paths.length > 5) { truncated = true; return; }
      const next = [...path, n], kids = children(n);
      if (!kids.length) paths.push(next);
      else for (const child of kids) visit(child, next);
    };
    for (const c of children(palm)) visit(c, []);
    if (truncated || paths.length !== 5 || paths.some(p => p.length < 3 || p.length > 4)) continue;
    // A shared cup/metacarpal may precede ring and pinky. Select their three
    // phalanges, leaving the shared helper untouched.
    const fingers = paths.map(p => p.slice(-3));
    if (new Set(fingers.flat()).size !== 15) continue;
    if (fingers.some(f => f.some(n => distance(palm, n) > height * 0.17) ||
        distance(f[0], f[1]) < height * 0.003 || distance(f[1], f[2]) < height * 0.003)) continue;
    const bases = fingers.slice().sort((a, b) => distance(palm, a[0]) - distance(palm, b[0]));
    // The thumb starts near the wrist, distinctly before the knuckle row.
    if (distance(palm, bases[0][0]) > distance(palm, bases[1][0]) * 0.7) continue;
    const thumb = bases.shift();
    const center = [0, 1, 2].map(k => bases.reduce((s, f) => s + pos.get(f[0])[k], 0) / 4);
    const across = sub(pos.get(thumb[1]), center);
    const direction = sub(center, pos.get(palm));
    const projection = dot(across, direction) / dot(direction, direction);
    const axis = across.map((v, i) => v - projection * direction[i]);
    if (len(axis) < height * 0.008) continue;
    bases.sort((a, b) => dot(sub(pos.get(b[0]), pos.get(a[0])), axis));
    const gaps = bases.slice(1).map((f, i) => dot(sub(pos.get(bases[i][0]), pos.get(f[0])), axis) / len(axis));
    if (gaps.some(g => g < height * 0.003)) continue;
    hands.push({ palm, fingers: [thumb, ...bases] });
  }
  if (hands.length !== 2) return new Map();
  const chest = common(hands[0].palm, hands[1].palm);
  if (!chest) return new Map();
  const arms = hands.map(hand => {
    const path = pathFrom(chest, hand.palm), distinct = [];
    for (const n of path) {
      if (!distinct.length || distance(n, distinct.at(-1)) > height * 0.002) distinct.push(n);
    }
    return { ...hand, path, chain: distinct };
  });
  if (arms.some(a => a.chain.length !== 4)) return new Map();
  const lateral = sub(pos.get(arms[0].palm), pos.get(arms[1].palm));
  // The fallback is deliberately limited to upright X-spread import poses.
  // Do not guess left/right from a rotated or crossed-arm character.
  if (Math.abs(lateral[0]) < len(lateral) * 0.9) return new Map();
  arms.sort((a, b) => pos.get(b.palm)[0] - pos.get(a.palm)[0]);
  for (const arm of arms) {
    const [shoulder, upper, elbow, wrist] = arm.chain;
    if (distance(upper, elbow) < height * 0.1 || distance(elbow, wrist) < height * 0.1 ||
        distance(shoulder, upper) > height * 0.15) return new Map();
  }
  const armRoots = new Set(arms.map(a => a.path[0]));
  const necks = children(chest).filter(n => !armRoots.has(n) && pos.get(n)[1] > pos.get(chest)[1]);
  if (necks.length !== 1 || children(necks[0]).length !== 1) return new Map();
  const neck = necks[0], head = children(neck)[0];
  if (pos.get(head)[1] - pos.get(chest)[1] < height * 0.12) return new Map();

  let hips, legs;
  for (const candidate of ancestors(chest).slice(1)) {
    const spineRoot = pathFrom(candidate, chest)[0];
    let branches = children(candidate).filter(n => n !== spineRoot);
    if (branches.length === 1) branches = children(branches[0]); // split hip/pelvis helper
    if (branches.length !== 2) continue;
    const chains = branches.map(n => {
      const path = [n];
      while (children(n).length === 1 && path.length < 5) { n = children(n)[0]; path.push(n); }
      return path;
    });
    if (chains.some(c => c.length < 3 || c.length > 4 || children(c.at(-1)).length)) continue;
    if (chains.some(c => pos.get(c[0])[1] - pos.get(c[1])[1] < height * 0.15 ||
        pos.get(c[1])[1] - pos.get(c[2])[1] < height * 0.15)) continue;
    const x = pos.get(candidate)[0];
    if ((pos.get(chains[0][0])[0] - x) * (pos.get(chains[1][0])[0] - x) >= 0) continue;
    hips = candidate;
    legs = chains.sort((a, b) => pos.get(b[0])[0] - pos.get(a[0])[0]);
    break;
  }
  if (!hips) return new Map();
  const spine = pathFrom(hips, chest);
  if (spine.length < 2 || spine.length > 3) return new Map();
  const up = sub(pos.get(head), pos.get(hips));
  if (up[1] < len(up) * 0.95) return new Map();
  const result = new Map([['Hips', hips], ['Spine', spine[0]], ['Spine2', chest], ['Neck', neck], ['Head', head]]);
  if (spine.length === 3) result.set('Spine1', spine[1]);
  for (const [i, side] of ['Left', 'Right'].entries()) {
    ['Shoulder', 'Arm', 'ForeArm', 'Hand'].forEach((role, j) => result.set(side + role, arms[i].chain[j]));
    legs[i].forEach((node, j) => result.set(side + ['UpLeg', 'Leg', 'Foot', 'ToeBase'][j], node));
    ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].forEach((finger, j) => {
      arms[i].fingers[j].forEach((node, k) => result.set(`${side}Hand${finger}${k + 1}`, node));
    });
  }
  return result;
}
