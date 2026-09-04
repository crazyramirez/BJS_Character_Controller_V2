// Hand-local triangle connectivity. Cutting successive sections of an open hand
// separates actual digits; a solid mitten never becomes five artificial clusters.
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const length = v => Math.hypot(...v);
const unit = v => v.map(x => x / (length(v) || 1));
const mean = points => points[0].map((_, i) => points.reduce((s, p) => s + p[i], 0) / points.length);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

export function detectHandFingers(primitives, wrist, forearm, { height, fingers, tip } = {}) {
  const review = (reason, detectedCount = 0) => ({ status: 'review', method: 'surface-sections', reason, detectedCount });
  if (!fingers?.length) return { status: 'disabled', detectedCount: 0, reason: 'No finger chains requested.' };
  const reach = tip ? length(sub(tip, wrist)) : height * 0.11;
  const axis = unit(sub(tip || wrist, tip ? wrist : forearm));
  if (!(reach > height * 0.01) || length(axis) < 0.5) return review('Wrist direction is unresolved.');
  const points = [], along = [], edges = [], byPosition = new Map();
  const weld = Math.max(height * 1e-6, Number.EPSILON);
  for (const { positions, indices } of primitives) {
    const local = new Int32Array(positions.length / 3).fill(-1);
    for (let v = 0; v < local.length; v++) {
      const p = Array.from(positions.subarray(v * 3, v * 3 + 3));
      const delta = sub(p, wrist), a = dot(delta, axis);
      if (a < -0.12 * reach || a > 1.6 * reach || dot(delta, delta) - a * a > (0.95 * reach) ** 2) continue;
      const key = delta.map(x => Math.round(x / weld)).join(',');
      let id = byPosition.get(key);
      if (id === undefined) {
        id = points.length;
        byPosition.set(key, id);
        points.push(p); along.push(a); edges.push(new Set());
      }
      local[v] = id;
    }
    const count = indices?.length ?? local.length;
    for (let i = 0; i + 2 < count; i += 3) {
      const ids = [0, 1, 2].map(k => local[indices ? indices[i + k] : i + k]);
      for (let k = 0; k < 3; k++) {
        const a = ids[k], b = ids[(k + 1) % 3];
        if (a < 0 || b < 0 || a === b) continue;
        edges[a].add(b); edges[b].add(a);
      }
    }
  }
  if (points.length < fingers.length * 6) return review('Too little hand geometry to resolve individual digits.');
  if (points.length > 100000) return review('Hand topology exceeds the analysis budget; review the markers.');

  const componentsAt = cut => {
    const seen = new Uint8Array(points.length), components = [];
    for (let start = 0; start < points.length; start++) {
      if (seen[start] || along[start] <= cut) continue;
      const ids = [start]; seen[start] = 1;
      for (let q = 0; q < ids.length; q++) {
        for (const next of edges[ids[q]]) {
          if (seen[next] || along[next] <= cut) continue;
          seen[next] = 1; ids.push(next);
        }
      }
      let low = Infinity, high = -Infinity;
      for (const id of ids) { low = Math.min(low, along[id]); high = Math.max(high, along[id]); }
      // Reject loose triangles, nails, tiny tips, and broad fragments.
      if (ids.length < 6 || high - low < 0.06 * reach || high < 0.25 * reach) continue;
      const cap = ids.filter(id => along[id] >= high - 0.045 * reach);
      const base = ids.filter(id => along[id] <= low + 0.045 * reach);
      const end = mean(cap.map(id => points[id])), basePoint = mean(base.map(id => points[id]));
      const direction = unit(sub(end, basePoint));
      let radius = 0;
      for (const id of ids) {
        const d = sub(points[id], basePoint), projected = dot(d, direction);
        radius = Math.max(radius, Math.sqrt(Math.max(0, dot(d, d) - projected * projected)));
      }
      if (radius > 0.16 * reach || length(sub(end, basePoint)) < 0.10 * reach) continue;
      components.push({ ids, low, high, tip: end, base: basePoint });
    }
    return components;
  };
  let best = null;
  const tracks = [];
  for (let step = 0; step < 15; step++) {
    const groups = componentsAt(reach * (0.22 + step * 0.035));
    for (const group of groups) {
      // The thumb often separates before the other digits and ends before their
      // knuckles. Track narrow branches across cuts instead of requiring all
      // five fingers to intersect the same plane.
      const track = tracks.find(t => t.lastStep === step - 1 &&
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
  if (leaves.length === fingers.length && leaves.every((t, i) => leaves.slice(i + 1).every(other =>
    !other.group.ids.some(id => t.members.has(id))))) best = leaves.map(t => t.group);
  if (!best) return review(`Could not separate ${fingers.length} persistent digits (${leaves.length} resolved). Use an open hand pose or adjust the finger markers.`, leaves.length);

  // Principal lateral direction from the measured branches, independent of
  // hand roll, facing, world up, handedness, and input vertex ordering.
  const center = mean(best.map(g => g.base));
  const offsets = best.map(g => {
    const d = sub(g.base, center), a = dot(d, axis);
    return d.map((v, i) => v - axis[i] * a);
  });
  let across = unit(offsets.reduce((a, b) => length(a) > length(b) ? a : b));
  for (let i = 0; i < 12; i++) {
    const next = [0, 0, 0];
    for (const d of offsets) {
      const w = dot(d, across);
      for (let k = 0; k < 3; k++) next[k] += d[k] * w;
    }
    across = unit(next);
  }
  if (length(across) < 0.5) return review('The finger fan has no clear lateral direction.', best.length);
  best.sort((a, b) => dot(sub(a.base, center), across) - dot(sub(b.base, center), across));
  if (fingers.includes('Thumb')) {
    const first = best[0], last = best.at(-1);
    const gapFirst = length(sub(first.base, best[1].base));
    const gapLast = length(sub(last.base, best.at(-2).base));
    // Label only when the thumb is separated or clearly shorter than the
    // opposite outer digit. Symmetric claws need manual anatomical assignment.
    const separated = Math.max(gapFirst, gapLast) > Math.min(gapFirst, gapLast) * 1.3;
    const shorter = Math.abs(first.high - last.high) > reach * 0.12;
    if (!separated && !shorter) return review('Digits are separated, but the thumb side is ambiguous.', best.length);
    const firstIsThumb = separated ? gapFirst > gapLast : first.high < last.high;
    if (separated && shorter && firstIsThumb !== (first.high < last.high)) {
      return review('Thumb length and separation disagree; review finger names.', best.length);
    }
    if (!firstIsThumb) best.reverse();
  }
  const joints = {}, tips = {};
  for (let f = 0; f < fingers.length; f++) {
    const group = best[f], name = fingers[f];
    tips[name] = group.tip;
    // Cross-section centers follow the actual branch, including its depth.
    // End joints stay inside the digit, leaving room for the distal segment.
    joints[name] = [0.06, 0.48, 0.78].map(t => {
      const level = group.low + t * (group.high - group.low);
      const ordered = [...group.ids].sort((a, b) => Math.abs(along[a] - level) - Math.abs(along[b] - level));
      const ring = ordered.filter(id => Math.abs(along[id] - level) <= 0.04 * reach);
      return ring.length >= 3 ? mean(ring.map(id => points[id])) : mix(group.base, group.tip, t);
    });
    if (joints[name].some((p, i) => i > 0 && length(sub(p, joints[name][i - 1])) < height * 1e-4)) {
      return review('Finger sections are too coarse to place distinct joints.', best.length);
    }
  }
  return { status: 'detected', method: 'surface-sections', detectedCount: best.length,
    reason: 'Separate digits found in consecutive mesh sections. Check the knuckles before animation.', joints, tips };
}
