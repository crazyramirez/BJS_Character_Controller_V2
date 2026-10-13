// Hand-local triangle connectivity. Cutting successive sections of an open hand
// separates actual digits; a solid mitten never becomes five artificial clusters.
const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, s) => a.map(v => v * s);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = v => Math.hypot(...v);
const unit = v => v.map(x => x / (length(v) || 1));
const mean = points => points[0].map((_, i) => points.reduce((s, p) => s + p[i], 0) / points.length);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const percentile = (values, q) => {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
};

// Finger joints along the visible digit (web → tip). Sections separate at the
// web between fingers, roughly 29% of the visible length past the knuckle
// (MCP); Mixamo rigs put the PIP and DIP at 39% and 71% of knuckle-to-tip.
const KNUCKLE_BEHIND_WEB = 0.29;
const PIP_FRACTION = 0.39, DIP_FRACTION = 0.71;
// Thumb CMC/MCP/IP along the wrist→thumb-tip line (Mixamo references: the
// visible thumb branch starts past the MCP, so its base is not Thumb1).
const THUMB_FRACTIONS = [0.29, 0.57, 0.80];
// Knuckle-to-tip is 44-49% of the wrist-to-tip length on Mixamo rigs. Fingers
// pressed together separate only near the tips, so the visible branch alone
// would compress the chain toward the nails: keep at least this share.
const MIN_FINGER_SHARE = 0.42;

export function detectHandFingers(primitives, wrist, forearm, { height, fingers, tip, forward } = {}) {
  const review = (reason, detectedCount = 0, estimate = null) => ({
    status: 'review', method: 'surface-sections', reason, detectedCount, ...(estimate ? { estimate } : {}),
  });
  if (!fingers?.length) return { status: 'disabled', detectedCount: 0, reason: 'No finger chains requested.' };
  const guessReach = tip ? length(sub(tip, wrist)) : height * 0.11;
  const guessAxis = unit(sub(tip || wrist, tip ? wrist : forearm));
  if (!(guessReach > height * 0.01) || length(guessAxis) < 0.5) return review('Wrist direction is unresolved.');
  const armAxis = forearm ? unit(sub(wrist, forearm)) : guessAxis;
  const back = length(armAxis) > 0.5 ? armAxis : guessAxis;

  // Neighbourhood on the hand side of the wrist. The silhouette tip is the
  // outermost point of the arm, which for hanging or curled hands (A-pose) is
  // the back of the hand, not a fingertip — gather generously, then keep only
  // geometry connected to the wrist (drops thighs, belts and props nearby).
  const radius = 1.8 * guessReach;
  const points = [], links = [], exits = [], byPosition = new Map();
  const weld = Math.max(height * 1e-6, Number.EPSILON);
  for (const { positions, indices } of primitives) {
    const local = new Int32Array(positions.length / 3).fill(-1);
    const beyondSphere = new Uint8Array(positions.length / 3);
    for (let v = 0; v < local.length; v++) {
      const p = Array.from(positions.subarray(v * 3, v * 3 + 3));
      const delta = sub(p, wrist);
      if (dot(delta, delta) > radius * radius) {
        if (dot(delta, back) > 0.2 * guessReach) beyondSphere[v] = 1;
        continue;
      }
      if (dot(delta, back) < -0.12 * guessReach) continue;
      const key = delta.map(x => Math.round(x / weld)).join(',');
      let id = byPosition.get(key);
      if (id === undefined) {
        id = points.length;
        byPosition.set(key, id);
        points.push(p); links.push([]); exits.push(0);
      }
      local[v] = id;
    }
    const count = indices?.length ?? local.length;
    for (let i = 0; i + 2 < count; i += 3) {
      const corners = [0, 1, 2].map(k => indices ? indices[i + k] : i + k);
      const ids = corners.map(v => local[v]);
      if (corners.some(v => beyondSphere[v])) for (const id of ids) if (id >= 0) exits[id] = 1;
      for (let k = 0; k < 3; k++) {
        const a = ids[k], b = ids[(k + 1) % 3];
        if (a < 0 || b < 0 || a === b) continue;
        links[a].push(b); links[b].push(a);
      }
    }
  }
  if (points.length > 400000) return review('Hand topology exceeds the analysis budget; review the markers.');

  // Sections are level sets of the GEODESIC distance from the wrist section
  // (Dijkstra over the surface): digits separate as branches whichever way
  // they point (a sideways thumb, curled fingers), and geometry not connected
  // to the wrist (a held crowbar, the thigh beside an A-pose hand) is never
  // reached. Seeds: the wrist cross-section, plus the start of a glove that
  // is a separate mesh.
  // Separate shells (fingerless gloves over skin, nails, rings) join through
  // short proximity bridges. Pieces reaching the edge of the neighbourhood on
  // the hand side are held props (crowbar, sword grip), never digits.
  const armSide = points.map(p => dot(sub(p, wrist), back));
  const seedLimit = Math.max(0.1 * guessReach, armSide.reduce((m, v) => Math.min(m, v), Infinity) + 0.05 * guessReach);
  const isSeed = i => {
    const d = sub(points[i], wrist), a = armSide[i];
    return a <= seedLimit && dot(d, d) - a * a <= (0.6 * guessReach) ** 2;
  };
  const piece = new Int32Array(points.length).fill(-1);
  const pieceLeaves = [];
  for (let start = 0, id = 0; start < points.length; start++) {
    if (piece[start] >= 0) continue;
    const queue = [start];
    piece[start] = id;
    let leaves = false, seeded = false;
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      if (exits[i]) leaves = true;
      if (isSeed(i)) seeded = true;
      for (const j of links[i]) if (piece[j] < 0) { piece[j] = id; queue.push(j); }
    }
    pieceLeaves.push(leaves && !seeded);
    id++;
  }
  const bridge = 0.05 * guessReach;
  const buckets = new Map();
  const bucketKey = (x, y, z) => `${x},${y},${z}`;
  points.forEach((p, i) => {
    const k = bucketKey(...p.map(v => Math.floor(v / bridge)));
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(i);
  });
  const nearbyPieces = function* (i) {
    const [bx, by, bz] = points[i].map(v => Math.floor(v / bridge));
    for (let x = bx - 1; x <= bx + 1; x++) for (let y = by - 1; y <= by + 1; y++) for (let z = bz - 1; z <= bz + 1; z++) {
      for (const j of buckets.get(bucketKey(x, y, z)) || []) {
        if (piece[j] !== piece[i] && !pieceLeaves[piece[j]] && length(sub(points[i], points[j])) <= bridge) yield j;
      }
    }
  };

  const along = new Float64Array(points.length).fill(Infinity);
  {
    const heap = [];
    const push = (i, d) => {
      heap.push([d, i]);
      for (let c = heap.length - 1; c > 0;) {
        const parent = (c - 1) >> 1;
        if (heap[parent][0] <= heap[c][0]) break;
        [heap[parent], heap[c]] = [heap[c], heap[parent]]; c = parent;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let c = 0; ;) {
          const l = 2 * c + 1, r = l + 1;
          let m = c;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === c) break;
          [heap[m], heap[c]] = [heap[c], heap[m]]; c = m;
        }
      }
      return top;
    };
    for (let i = 0; i < points.length; i++) {
      if (!pieceLeaves[piece[i]] && isSeed(i)) {
        along[i] = Math.max(0, armSide[i]);
        push(i, along[i]);
      }
    }
    const relax = (i, j, d) => {
      const next = d + length(sub(points[i], points[j]));
      if (next < along[j]) { along[j] = next; push(j, next); }
    };
    while (heap.length) {
      const [d, i] = pop();
      if (d > along[i]) continue;
      for (const j of links[i]) relax(i, j, d);
      for (const j of nearbyPieces(i)) relax(i, j, d);
    }
  }
  const inHand = new Uint8Array(points.length);
  const hand = [];
  for (let i = 0; i < points.length; i++) if (Number.isFinite(along[i])) { inHand[i] = 1; hand.push(i); }
  if (hand.length < fingers.length * 6) return review('Too little hand geometry to resolve individual digits.');

  // Measured hand frame: fingers point from the wrist to the fingertip zone.
  // `axial`/`axialReach` measure along that direction (palm geometry), while
  // `reach` is how far the surface runs from the wrist (digit sections).
  const beyond = hand.filter(i => dot(sub(points[i], wrist), back) > 0);
  if (beyond.length < fingers.length * 6) return review('Too little hand geometry to resolve individual digits.');
  const farthest = percentile(beyond.map(i => length(sub(points[i], wrist))), 0.995);
  const axis = unit(sub(mean(beyond.filter(i => length(sub(points[i], wrist)) >= 0.85 * farthest).map(i => points[i])), wrist));
  const axial = new Float64Array(points.length);
  for (const i of hand) axial[i] = dot(sub(points[i], wrist), axis);
  const axialReach = percentile(hand.map(i => axial[i]), 0.995);
  const reach = percentile(hand.map(i => along[i]), 0.995);
  if (!(reach > height * 0.01) || !(axialReach > height * 0.01) || length(axis) < 0.5) return review('Hand geometry is unresolved.');

  const componentsAt = cut => {
    const seen = new Uint8Array(points.length), raw = [], components = [];
    for (const start of hand) {
      if (seen[start] || along[start] <= cut) continue;
      const ids = [start]; seen[start] = 1;
      for (let q = 0; q < ids.length; q++) {
        for (const next of links[ids[q]]) {
          if (seen[next] || !inHand[next] || along[next] <= cut) continue;
          seen[next] = 1; ids.push(next);
        }
      }
      if (ids.length < 3) continue;
      const section = ids.filter(id => along[id] <= cut + 0.045 * reach);
      raw.push({ ids, section: section.length ? mean(section.map(id => points[id])) : null });
    }
    // Nested shells (a glove tube around the finger inside it) share their
    // section centre; side-by-side digits sit a finger width apart.
    for (let i = 0; i < raw.length; i++) {
      if (!raw[i] || !raw[i].section) continue;
      for (let j = i + 1; j < raw.length; j++) {
        if (!raw[j] || !raw[j].section || length(sub(raw[i].section, raw[j].section)) > 0.05 * reach) continue;
        raw[i].ids = raw[i].ids.concat(raw[j].ids);
        raw[j] = null;
      }
    }
    for (const { ids } of raw.filter(Boolean)) {
      let low = Infinity, high = -Infinity;
      for (const id of ids) { low = Math.min(low, along[id]); high = Math.max(high, along[id]); }
      // Reject loose triangles, nails, tiny tips, and broad fragments.
      if (ids.length < 6 || high - low < 0.06 * reach || high < 0.25 * reach) continue;
      const cap = ids.filter(id => along[id] >= high - 0.045 * reach);
      const base = ids.filter(id => along[id] <= low + 0.045 * reach);
      const end = mean(cap.map(id => points[id])), basePoint = mean(base.map(id => points[id]));
      const direction = unit(sub(end, basePoint));
      let spread = 0;
      for (const id of ids) {
        const d = sub(points[id], basePoint), projected = dot(d, direction);
        spread = Math.max(spread, Math.sqrt(Math.max(0, dot(d, d) - projected * projected)));
      }
      if (spread > 0.16 * reach || length(sub(end, basePoint)) < 0.10 * reach) continue;
      components.push({ ids, low, high, tip: end, base: basePoint });
    }
    return components;
  };
  const tracks = [];
  // Fine steps: a sideways thumb is short along the hand axis and must still
  // persist across consecutive sections.
  for (let step = 0; step < 46; step++) {
    const groups = componentsAt(reach * (0.18 + step * 0.015));
    for (const group of groups) {
      // The thumb often separates before the other digits and ends before their
      // knuckles. Track narrow branches across cuts instead of requiring all
      // five fingers to intersect the same plane.
      // Low-poly digits can drop out of one section and reappear: continue
      // the same track across short gaps instead of counting it twice.
      const track = tracks.find(t => t.lastStep < step && t.lastStep >= step - 3 &&
        group.ids.length >= t.lastSize * 0.65 &&
        length(sub(group.tip, t.group.tip)) < 0.07 * reach && group.ids.some(id => t.members.has(id)));
      if (track) { track.hits++; track.lastStep = step; track.lastSize = group.ids.length; }
      else tracks.push({ group, members: new Set(group.ids), hits: 1, lastStep: step, lastSize: group.ids.length });
    }
  }
  const persistent = tracks.filter(t => t.hits >= 2);
  // A broad parent component cannot be counted again as one of its children.
  const leaves = persistent.filter(t => !persistent.some(other => other !== t &&
    other.group.ids.length < t.group.ids.length * 0.8 && other.group.ids.every(id => t.members.has(id))));
  const disjoint = leaves.every((t, i) => leaves.slice(i + 1).every(other => !other.group.ids.some(id => t.members.has(id))));

  // Joints inside a detected digit: cross-section centres follow the branch,
  // including its depth. Non-thumb chains start at the knuckle behind the web.
  const ringCenter = (group, level, fallback) => {
    const ring = group.ids.filter(id => Math.abs(along[id] - level) <= 0.04 * reach);
    return ring.length >= 3 ? mean(ring.map(id => points[id])) : fallback;
  };
  const chainFor = (group, thumb) => {
    const span = group.high - group.low;
    if (thumb) {
      return THUMB_FRACTIONS.map(f => {
        // Geodesic distance runs wrist → thumb tip, so the line fraction maps
        // straight onto a section level of the branch.
        const point = mix(wrist, group.tip, f), level = f * group.high;
        return level > group.low + 0.02 * span && level < group.high - 0.02 * span ? ringCenter(group, level, point) : point;
      });
    }
    const visible = length(sub(group.tip, group.base));
    const web = ringCenter(group, group.low + 0.03 * span, group.base);
    const direction = unit(sub(ringCenter(group, group.low + 0.45 * span, mix(group.base, group.tip, 0.45)), web));
    const total = Math.max(visible * (1 + KNUCKLE_BEHIND_WEB), MIN_FINGER_SHARE * group.high);
    const behind = total - visible; // knuckle sits this far behind the web
    return [0, PIP_FRACTION, DIP_FRACTION].map(t => {
      const distance = t * total - behind;
      if (distance <= 0) return add(web, scale(direction, distance));
      const level = group.low + span * Math.min(0.97, distance / visible);
      return ringCenter(group, level, add(web, scale(direction, distance)));
    });
  };

  // Palm frame from the measured geometry: across = the widest direction
  // perpendicular to the fingers, normal = through the palm.
  const palm = hand.filter(i => axial[i] >= 0.05 * axialReach && axial[i] <= axialReach);
  const perpendicular = id => {
    const d = sub(points[id], wrist);
    return sub(d, scale(axis, axial[id]));
  };
  let across = unit(cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  for (let iteration = 0; iteration < 16; iteration++) {
    const next = [0, 0, 0];
    for (const id of palm) {
      const d = perpendicular(id), w = dot(d, across);
      for (let k = 0; k < 3; k++) next[k] += d[k] * w;
    }
    if (length(next) < 1e-30) break;
    across = unit(next);
  }
  const normal = unit(cross(axis, across));
  const frame = id => { const d = sub(points[id], wrist); return [axial[id], dot(d, across), dot(d, normal)]; };
  const at = (a, c, n) => add(wrist, add(scale(axis, a), add(scale(across, c), scale(normal, n))));
  const knuckleBand = palm.filter(id => Math.abs(axial[id] - 0.5 * axialReach) <= 0.07 * axialReach).map(frame);
  const handWidth = knuckleBand.length >= 8
    ? { low: percentile(knuckleBand.map(f => f[1]), 0.05), high: percentile(knuckleBand.map(f => f[1]), 0.95) }
    : null;
  // Thumb side: the thumb base bulges sideways below the knuckles; without a
  // bulge, T/A poses point the thumb forward.
  const thumbSideOf = () => {
    if (!handWidth) return 1;
    const center = (handWidth.low + handWidth.high) / 2, half = (handWidth.high - handWidth.low) / 2;
    const lowBand = palm.filter(id => axial[id] >= 0.12 * axialReach && axial[id] <= 0.38 * axialReach).map(frame);
    const shift = lowBand.length >= 8 ? lowBand.reduce((s, f) => s + f[1], 0) / lowBand.length - center : 0;
    if (Math.abs(shift) > 0.08 * half) return Math.sign(shift);
    if (forward && Math.abs(dot(across, forward)) > 0.3) return Math.sign(dot(across, forward));
    return 1;
  };

  // Geometric estimate when digits do not separate (mittens, fused AI hands):
  // finger lanes across the measured knuckle line, each running to the
  // farthest geometry in its lane, at the lane's mid-depth.
  const estimate = (thumbSide, detectedGroups = null) => {
    if (!handWidth) return null;
    const center = (handWidth.low + handWidth.high) / 2, half = (handWidth.high - handWidth.low) / 2;
    const palmPoints = palm.map(frame);
    const joints = {};
    const nonThumb = fingers.filter(f => f !== 'Thumb');
    nonThumb.forEach((name, i) => {
      if (detectedGroups?.[i]) { joints[name] = chainFor(detectedGroups[i], false); return; }
      const laneHalf = 0.85 * half / nonThumb.length;
      const lane = center + thumbSide * 0.85 * half * (1 - (2 * i + 1) / nonThumb.length);
      const inLane = palmPoints.filter(f => Math.abs(f[1] - lane) <= laneHalf && f[0] >= 0.45 * axialReach);
      const end = inLane.length >= 4 ? percentile(inLane.map(f => f[0]), 0.98) : axialReach;
      const depth = inLane.length >= 4 ? inLane.reduce((s, f) => s + f[2], 0) / inLane.length : 0;
      const knuckle = 0.5 * axialReach, fingerLength = Math.max(0.2 * axialReach, end - knuckle);
      joints[name] = [0, PIP_FRACTION, DIP_FRACTION].map(t => at(knuckle + t * fingerLength, lane, depth));
    });
    if (fingers.includes('Thumb')) {
      const region = palmPoints.filter(f => (f[1] - center) * thumbSide > 0.35 * half && f[0] >= 0.08 * axialReach && f[0] <= 0.8 * axialReach);
      const depth = region.length >= 4 ? region.reduce((s, f) => s + f[2], 0) / region.length : 0;
      const outward = unit(add(axis, scale(across, thumbSide)));
      let end = at(0.4 * axialReach, center + thumbSide * 0.9 * half, depth);
      if (region.length >= 4) {
        const best = region.reduce((a, b) => dot(sub(at(...b), wrist), outward) > dot(sub(at(...a), wrist), outward) ? b : a);
        const tipPoint = at(best[0], best[1], depth);
        if (length(sub(tipPoint, wrist)) > 0.3 * axialReach) end = tipPoint;
      }
      joints.Thumb = THUMB_FRACTIONS.map(f => mix(wrist, end, f));
    }
    return joints;
  };

  const ordered = leaves.map(t => t.group);
  if (disjoint && (ordered.length === fingers.length ||
    (fingers.includes('Thumb') && ordered.length > 0 && ordered.length === fingers.length - 1))) {
    // Principal lateral direction from the measured branches, independent of
    // hand roll, facing, world up, handedness, and input vertex ordering.
    const center = mean(ordered.map(g => g.base));
    const offsets = ordered.map(g => {
      const d = sub(g.base, center), a = dot(d, axis);
      return d.map((v, i) => v - axis[i] * a);
    });
    let fan = unit(offsets.reduce((a, b) => length(a) > length(b) ? a : b));
    for (let i = 0; i < 12; i++) {
      const next = [0, 0, 0];
      for (const d of offsets) {
        const w = dot(d, fan);
        for (let k = 0; k < 3; k++) next[k] += d[k] * w;
      }
      fan = unit(next);
    }
    if (ordered.length > 1 && length(fan) < 0.5) return review('The finger fan has no clear lateral direction.', ordered.length, estimate(thumbSideOf()));
    if (ordered.length > 1) ordered.sort((a, b) => dot(sub(a.base, center), fan) - dot(sub(b.base, center), fan));

    if (ordered.length === fingers.length - 1) {
      // One digit short. When an outer branch is plainly the thumb (it splits
      // off first and ends well before the rest), two fingers are fused: keep
      // the thumb and the separated fingers from the thumb side, estimate the
      // rest. Otherwise the thumb is fused to the palm: estimate it instead.
      const outer = ordered.length > 1 ? [ordered[0], ordered.at(-1)] : [];
      const others = g => ordered.filter(o => o !== g);
      const thumbLike = outer.find(g => others(g).every(o => g.low < o.low - 0.04 * reach && g.high < o.high - 0.08 * reach));
      if (thumbLike && fingers.length > 2) {
        if (thumbLike !== ordered[0]) ordered.reverse();
        const [thumb, ...rest] = ordered;
        const thumbSide = Math.sign(dot(sub(thumb.base, rest[0].base), across)) || thumbSideOf();
        const joints = estimate(thumbSide, rest);
        if (joints) joints.Thumb = chainFor(thumb, true);
        return review(`Found the thumb and ${rest.length} separate fingers; the remaining finger is estimated. Check its markers.`,
          ordered.length, joints);
      }
      const thumbSide = thumbSideOf();
      const firstSide = dot(sub(ordered[0].base, wrist), across) - dot(sub(ordered.at(-1).base, wrist), across);
      if (Math.sign(firstSide) !== thumbSide) ordered.reverse();
      return review(`Found ${ordered.length} separate fingers; the thumb is estimated. Check the thumb markers.`,
        ordered.length, estimate(thumbSide, ordered));
    }

    if (fingers.includes('Thumb') && ordered.length > 1) {
      const first = ordered[0], last = ordered.at(-1);
      const gapFirst = length(sub(first.base, ordered[1].base));
      const gapLast = length(sub(last.base, ordered.at(-2).base));
      // Label only when the thumb is separated or clearly shorter than the
      // opposite outer digit. Symmetric claws need manual anatomical assignment.
      const separated = Math.max(gapFirst, gapLast) > Math.min(gapFirst, gapLast) * 1.3;
      const shorter = Math.abs(first.high - last.high) > reach * 0.12;
      if (!separated && !shorter) return review('Digits are separated, but the thumb side is ambiguous.', ordered.length);
      const firstIsThumb = separated ? gapFirst > gapLast : first.high < last.high;
      if (separated && shorter && firstIsThumb !== (first.high < last.high)) {
        return review('Thumb length and separation disagree; review finger names.', ordered.length);
      }
      if (!firstIsThumb) ordered.reverse();
    }
    const joints = {}, tips = {};
    for (let f = 0; f < fingers.length; f++) {
      const group = ordered[f], name = fingers[f];
      tips[name] = group.tip;
      joints[name] = chainFor(group, name === 'Thumb');
      if (joints[name].some((p, i) => i > 0 && length(sub(p, joints[name][i - 1])) < height * 1e-4)) {
        return review('Finger sections are too coarse to place distinct joints.', ordered.length);
      }
    }
    return { status: 'detected', method: 'surface-sections', detectedCount: ordered.length,
      reason: 'Separate digits found in consecutive mesh sections. Check the knuckles before animation.', joints, tips };
  }
  return review(`Could not separate ${fingers.length} persistent digits (${ordered.length} resolved). Markers follow the hand shape; adjust them or use an open hand pose.`,
    ordered.length, estimate(thumbSideOf()));
}
