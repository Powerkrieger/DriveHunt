// Drive-hunt simulation.
//
// Model: the arrow is a path (2+ points) giving the drive direction, possibly
// with bends. Everything is expressed in path coordinates: s = distance along
// the path, t = sideways offset. The line of hunters always stands
// perpendicular to the path and swings round bends; every hunter keeps a lane
// (t) and slides inward along the field edge where the area narrows.
//
// Drivers (Treiber) walk forward; the outer ends (flanks) keep their lead so
// the line forms a cup until they reach the standers. Standers (Schützen) wait
// at the far end; as soon as the drivers are within meetDistance (350 m) of a
// stander, that stander walks towards them until they meet.
//
// A drive over several fields in a row runs field by field (stages): the line
// crosses the whole width of the current field, waits at the boundary until
// everyone has arrived, lines up again on the other side and continues. The
// standers only start walking once the drivers are in the last field.
//
// Start positions are either computed (auto) or given by the drive's setup
// (Aufstellung) placed by the hunt leader.

(function (global) {
  const M_PER_DEG_LAT = 110540;

  function makeProjection(lat0, lng0) {
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    return {
      toXY: ([lat, lng]) => [(lng - lng0) * kx, (lat - lat0) * M_PER_DEG_LAT],
      toLatLng: ([x, y]) => [lat0 + y / M_PER_DEG_LAT, lng0 + x / kx],
    };
  }

  // GeoJSON geometry -> list of rings as [[lat,lng], ...]
  function ringsOf(geometry) {
    const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polys.flatMap((poly) => poly.map((ring) => ring.map(([lng, lat]) => [lat, lng])));
  }

  // Curvilinear frame along a polyline (local metres). Position (s, t) is
  // P(s) + t * N(s). N is the segment normal; within a zone around each bend
  // (up to maxBendR either side) it turns gradually from one segment to the
  // next, so a line of hunters swings round the corner.
  function makePathFrame(pts, maxBendR = 50) {
    const segs = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.5) continue;
      const T = [(bx - ax) / len, (by - ay) / len];
      segs.push({ a: pts[i], T, N: [-T[1], T[0]], s0: total, len });
      total += len;
    }
    if (!segs.length) throw new Error('path too short');
    const norm = ([x, y]) => {
      const l = Math.hypot(x, y) || 1;
      return [x / l, y / l];
    };
    // Turning zone half-width at each bend k (between segs k-1 and k).
    const bendR = segs.map((sg, k) => (k === 0 ? 0 : Math.min(maxBendR, 0.45 * segs[k - 1].len, 0.45 * sg.len)));

    function at(s) {
      if (s <= 0) {
        const { a, T, N } = segs[0];
        return { P: [a[0] + T[0] * s, a[1] + T[1] * s], N };
      }
      if (s >= total) {
        const { a, T, N, len } = segs[segs.length - 1];
        const d = s - total + len;
        return { P: [a[0] + T[0] * d, a[1] + T[1] * d], N };
      }
      let i = segs.length - 1;
      while (segs[i].s0 > s) i--;
      const { a, T, s0 } = segs[i];
      const P = [a[0] + T[0] * (s - s0), a[1] + T[1] * (s - s0)];
      // Inside a turning zone? Bend i is at the start of segment i, bend i+1 at its end.
      for (const k of [i, i + 1]) {
        const R = bendR[k];
        if (!R) continue;
        const u = (s - (segs[k].s0 - R)) / (2 * R);
        if (u < 0 || u > 1) continue;
        const A = segs[k - 1].N, B = segs[k].N;
        return { P, N: norm([A[0] * (1 - u) + B[0] * u, A[1] * (1 - u) + B[1] * u]) };
      }
      return { P, N: segs[i].N };
    }

    const toXY = (s, t) => {
      const { P, N } = at(s);
      return [P[0] + N[0] * t, P[1] + N[1] * t];
    };

    // Inverse: find s where point v lies on the cross-line through P(s) along
    // N(s); among several candidates (near bends) take the smallest |t|.
    function sampler(maxDist) {
      const step = 2;
      const samples = [];
      for (let s = -maxDist; s <= total + maxDist; s += step) samples.push({ s, ...at(s) });
      return function toST([x, y]) {
        let best = null;
        let prev = null;
        for (const smp of samples) {
          const dx = x - smp.P[0], dy = y - smp.P[1];
          const f = smp.N[0] * dy - smp.N[1] * dx; // along-path component of (v - P)
          if (prev && prev.f <= 0 !== f <= 0) {
            const u = prev.f / (prev.f - f);
            const s = prev.smp.s + u * (smp.s - prev.smp.s);
            const q = at(s);
            const t = (x - q.P[0]) * q.N[0] + (y - q.P[1]) * q.N[1];
            if (!best || Math.abs(t) < Math.abs(best[1])) best = [s, t];
          }
          prev = { f, smp };
        }
        if (best) return best;
        // Fallback (should not happen): nearest sample.
        let n = samples[0], nd = Infinity;
        for (const smp of samples) {
          const d = Math.hypot(x - smp.P[0], y - smp.P[1]);
          if (d < nd) (nd = d), (n = smp);
        }
        return [n.s, (x - n.P[0]) * n.N[0] + (y - n.P[1]) * n.N[1]];
      };
    }

    return { length: total, toXY, sampler };
  }

  // Subdivide ring edges so they stay (nearly) straight after mapping to (s, t).
  function densify(ring, maxLen) {
    const out = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / maxLen));
      for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
    out.push(ring[ring.length - 1]);
    return out;
  }

  // speed: driving pace of the line; maxSpeed: nobody walks faster than this (m/s).
  // standerSpeed: the standers (often the older hunters) close in slowly.
  const DEFAULTS = { drivers: 12, standers: 4, speed: 0.8, maxSpeed: 5 / 3.6, standerSpeed: 1.5 / 3.6, flank: 40, meetDistance: 300 };
  const STEP = 2; // s, simulation time step
  const START_ZONE = 100; // m: lanes starting within this depth line up at the field edge

  // Piecewise-linear interpolation over points sorted by x, clamped at the ends.
  function interp(xs, ys, x) {
    if (!xs.length) return NaN;
    if (x <= xs[0]) return ys[0];
    for (let i = 1; i < xs.length; i++) {
      if (x <= xs[i]) {
        const u = xs[i] === xs[i - 1] ? 1 : (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
        return ys[i - 1] + u * (ys[i] - ys[i - 1]);
      }
    }
    return ys[ys.length - 1];
  }

  // Smallest time in [lo, hi] where pred holds (pred must be monotone).
  function firstTime(pred, lo, hi) {
    if (pred(lo)) return lo;
    if (!pred(hi)) return hi;
    for (let k = 0; k < 50; k++) {
      const mid = (lo + hi) / 2;
      pred(mid) ? (hi = mid) : (lo = mid);
    }
    return hi;
  }

  /**
   * @param arrow      [[lat,lng], ...] drive path, 2+ points
   * @param geometries GeoJSON geometries of the drive area (one per field)
   * @param params     { drivers, standers, speed, maxSpeed, standerSpeed (m/s), flank (m), meetDistance (m) }
   * @param setup      optional { drivers: [[lat,lng]...], standers: [[lat,lng]...] } start positions
   */
  function createSimulation(arrow, geometries, params = {}, setup = null) {
    const p = { ...DEFAULTS, ...params };
    const v = p.speed;
    const proj = makeProjection(arrow[0][0], arrow[0][1]);
    const pathPts = arrow.map(proj.toXY);
    // One entry per field: its rings in local metres (raw for inside tests,
    // densified where a bent path maps straight edges to curves).
    const fieldRaw = geometries.map((g) => ringsOf(g).map((ring) => ring.map(proj.toXY)));
    const fieldXY = fieldRaw.map((rs) => rs.map((r) => (pathPts.length > 2 ? densify(r, 5) : r)));
    const setupXY = setup ? [...(setup.drivers || []), ...(setup.standers || [])].map(proj.toXY) : [];
    let reach = 0;
    for (const v2 of [...fieldXY.flat(2), ...setupXY]) reach = Math.max(reach, Math.hypot(v2[0], v2[1]));

    function build(bendR) {
      const path = makePathFrame(pathPts, bendR);
      const toST = path.sampler(Math.min(5000, reach + 200));
      return { path, toST, fields: fieldXY.map((rs) => rs.map((r) => r.map(toST))) };
    }
    const extentOf = (rings, k) => {
      let a = Infinity, b = -Infinity;
      for (const r of rings) for (const q of r) (a = Math.min(a, q[k])), (b = Math.max(b, q[k]));
      return [a, b];
    };

    // Pass 1 with the default turning zone; if the line is wider, rebuild with a
    // zone at least half the line width, otherwise hunters on the inside of a
    // bend would walk backwards while the line turns.
    let frame = build(50);
    if (pathPts.length > 2) {
      let half = 0;
      for (const rs of frame.fields) for (const r of rs) for (const [, t] of r) half = Math.max(half, Math.abs(t));
      for (const q of setupXY) half = Math.max(half, Math.abs(frame.toST(q)[1]));
      if (half * 1.1 > 50) frame = build(Math.min(half * 1.1, 300));
    }
    const { path, toST } = frame;
    const toLatLng = (s, t) => proj.toLatLng(path.toXY(s, t));

    // ---- stages: fields crossed one after another along the path. Fields lying
    // side by side (overlapping mostly in s) are driven together as one stage.
    const parts = frame.fields
      .map((rings, i) => ({ rings, raw: fieldRaw[i], range: extentOf(rings, 0) }))
      .sort((a, b) => a.range[0] - b.range[0]);
    const stages = [];
    for (const f of parts) {
      const cur = stages[stages.length - 1];
      if (cur) {
        const [A, B] = cur.range, [a, b] = f.range;
        const overlap = Math.min(B, b) - Math.max(A, a);
        if (overlap > 0.5 * Math.min(b - a, B - A)) {
          cur.rings.push(...f.rings);
          cur.fields.push(f.rings);
          cur.raw.push(f.raw);
          cur.range = [Math.min(A, a), Math.max(B, b)];
          continue;
        }
      }
      stages.push({ rings: [...f.rings], fields: [f.rings], raw: [f.raw], range: f.range.slice() });
    }
    for (const st of stages) {
      [st.sA, st.sB] = st.range;
      const [lo, hi] = extentOf(st.rings, 1);
      const inset = Math.min(3, (hi - lo) / 4);
      (st.tLo = lo + inset), (st.tHi = hi - inset);
    }
    const sMin = stages[0].sA, sMax = stages[stages.length - 1].sB;

    // Parts of the cross-line at s that lie inside the stage's fields, as
    // sorted [tFrom, tTo] intervals (gaps between fields, notches and holes
    // are left out), each inset a little from the border.
    function intervalsAt(st, s) {
      const out = [];
      for (const rings of st.fields) {
        const ts = [];
        for (const r of rings) {
          for (let i = 0; i < r.length - 1; i++) {
            const [s1, t1] = r[i], [s2, t2] = r[i + 1];
            if (s1 === s2 || (s1 - s) * (s2 - s) > 0 || Math.max(s1, s2) === s) continue; // half-open: count each vertex once
            ts.push(t1 + ((s - s1) / (s2 - s1)) * (t2 - t1));
          }
        }
        ts.sort((a, b) => a - b);
        for (let i = 0; i + 1 < ts.length; i += 2) out.push([ts[i], ts[i + 1]]);
      }
      out.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const iv of out) {
        const lastIv = merged[merged.length - 1];
        if (lastIv && iv[0] <= lastIv[1] + 1) lastIv[1] = Math.max(lastIv[1], iv[1]);
        else merged.push(iv.slice());
      }
      return merged
        .filter(([a, b]) => b - a > 0.5)
        .map(([a, b]) => {
          const inset = Math.min(2, (b - a) / 4);
          return [a + inset, b - inset];
        });
    }
    // Extent of a stage along the path in the lane at offset t: [rear edge, far edge].
    function laneOf(st, t) {
      let lo = Infinity, hi = -Infinity;
      for (const r of st.rings) {
        for (let i = 0; i < r.length - 1; i++) {
          const [s1, t1] = r[i], [s2, t2] = r[i + 1];
          if ((t1 - t) * (t2 - t) > 0 || t1 === t2) continue;
          const s = s1 + ((t - t1) / (t2 - t1)) * (s2 - s1);
          (lo = Math.min(lo, s)), (hi = Math.max(hi, s));
        }
      }
      return lo <= hi && hi - lo > 6 ? [lo + 3, hi - 3] : [st.sA, st.sB];
    }

    // ---- drivers: fraction f across the width (0 = left) and lead (flanks ahead).
    const edgeOf = (f) => Math.abs(f - 0.5) * 2; // 0 centre .. 1 outermost
    let custom = null;
    let roster;
    if (setup?.drivers?.length) {
      const pts = setup.drivers.map((ll) => toST(proj.toXY(ll))).sort((a, b) => b[1] - a[1]);
      const sLine0 = Math.min(...pts.map((x) => x[0]));
      roster = pts.map(([s0], i) => {
        const f = pts.length === 1 ? 0.5 : i / (pts.length - 1);
        // Starts as placed, then forms the standard line (lead0 -> lead within 80 m).
        return { f, lead: p.flank * edgeOf(f) ** 2, lead0: s0 - sLine0, flank: edgeOf(f) > 0.75 };
      });
      custom = { sLine0, pts };
    } else {
      roster = Array.from({ length: p.drivers }, (_, i) => {
        const f = p.drivers === 1 ? 0.5 : i / (p.drivers - 1);
        const lead = p.flank * edgeOf(f) ** 2;
        return { f, lead, lead0: lead, flank: edgeOf(f) > 0.75 };
      });
    }
    const centreIdx = roster.reduce((best, r, i) => (r.lead < roster[best].lead ? i : best), 0);
    const FORM_UP = 80; // m walked until a placed line has formed the standard shape

    // Line-up of every driver at the start of each stage: lane t across the
    // full width of the stage, standing at that lane's rear edge. Lanes whose
    // area only starts much further ahead (the field widens later) line up level
    // with the line, squeezed into the width available there.
    // Position across the stage's width at s for width fraction f (0 = left border).
    // Distributed over the inside parts only, so nobody ends up in a gap.
    function propT(st, s, f, fallback) {
      const ivs = intervalsAt(st, s);
      if (!ivs.length) return fallback;
      const total = ivs.reduce((sum, [a, b]) => sum + (b - a), 0);
      let d = f * total;
      for (let i = ivs.length - 1; i >= 0; i--) {
        const [a, b] = ivs[i];
        if (d <= b - a) return b - d;
        d -= b - a;
      }
      return ivs[0][0];
    }
    // Nearest inside position across the line at s.
    function clampInside(st, s, t) {
      const ivs = intervalsAt(st, s);
      if (!ivs.length || ivs.some(([a, b]) => t >= a && t <= b)) return t;
      let best = t, bestD = Infinity;
      for (const [a, b] of ivs) for (const e of [a, b]) if (Math.abs(e - t) < bestD) (bestD = Math.abs(e - t)), (best = e);
      return best;
    }

    // Lane for width fraction f at the line-up: spread over the ground the stage
    // covers across its whole depth (gaps between side-by-side fields left out).
    function coverOf(st) {
      if (st.cover) return st.cover;
      const all = [];
      for (let s = st.sA + 2; s < st.sB; s += 10) all.push(...intervalsAt(st, s));
      all.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const iv of all) {
        const l = merged[merged.length - 1];
        if (l && iv[0] <= l[1] + 1) l[1] = Math.max(l[1], iv[1]);
        else merged.push(iv.slice());
      }
      return (st.cover = merged.length ? merged : [[st.tLo, st.tHi]]);
    }
    function laneT(st, f) {
      const ivs = coverOf(st);
      const total = ivs.reduce((sum, [a, b]) => sum + (b - a), 0);
      let d = f * total;
      for (let i = ivs.length - 1; i >= 0; i--) {
        const [a, b] = ivs[i];
        if (d <= b - a) return b - d;
        d -= b - a;
      }
      return ivs[0][0];
    }

    // Where a driver with width fraction f reaches the far boundary of the stage
    // (follows the proportional path, so flanks run along a narrowing border
    // instead of stopping where their lane leaves the field).
    function farOf(st, f, tLane) {
      let far = st.sB - 3;
      for (let k = 0; k < 3; k++) far = laneOf(st, propT(st, far - 2, f, tLane))[1];
      return far;
    }
    // Where the far boundary of a stage begins: the first point where one of the
    // central lanes ends. From there on everyone keeps their place across the
    // field and walks straight to the boundary in their own lane (a slanted
    // boundary is reached staggered) instead of squeezing into its last corner.
    // Side borders don't count, so a field narrowing at the sides still squeezes the line.
    function freezeOf(st) {
      let sF = st.sB - 3;
      for (let f = 0.2; f <= 0.801; f += 0.05) sF = Math.min(sF, laneOf(st, laneT(st, f))[1]);
      return Math.max(st.sA + 3, sF);
    }
    const realLast = stages[stages.length - 1];
    stages.forEach((st, k) => (st.fieldNo = k + 1));
    const fieldCount = stages.length;
    // ---- standers wait at the far end of the last stage.
    let standers;
    if (setup?.standers?.length) {
      standers = setup.standers.map((ll) => toST(proj.toXY(ll))).map(([s0, t]) => ({ t, s0 }));
    } else if (custom) {
      standers = [];
    } else {
      standers = Array.from({ length: p.standers }, (_, j) => {
        return { t: laneT(realLast, 1 - (j + 1) / (p.standers + 1)), s0: 0 };
      });
    }
    for (const x of standers) if (!x.s0) x.s0 = laneOf(realLast, x.t)[1];
    standers.sort((a, b) => a.t - b.t);

    // The 300 m mark: once the drivers are meetDistance from the nearest
    // stander, the line stops and straightens (like at a field boundary); then
    // the standers set off. Modelled by splitting the last field into two
    // stages at the mark.
    if (standers.length) {
      const sMark = Math.min(...standers.map((x) => x.s0)) - p.meetDistance;
      if (sMark > realLast.sA + 30 && sMark < realLast.sB - 10) {
        const before = { ...realLast, sB: sMark, range: [realLast.sA, sMark], cap: sMark, mark: true };
        const after = { ...realLast, sA: sMark, range: [sMark, realLast.sB], afterMark: true };
        delete before.cover;
        delete after.cover;
        stages.splice(stages.length - 1, 1, before, after);
      }
    }

    for (const [k, st] of stages.entries()) {
      st.k = k;
      st.sFreeze = st.cap ? st.cap : freezeOf(st);
      st.sLine0 = k === 0 && custom ? custom.sLine0 : st.sA;
      st.drivers = roster.map((d, i) => {
        let tLane, s0, t0;
        if (st.afterMark) {
          // Continuing after the 300 m mark: same place across the field, no re-forming.
          tLane = t0 = stages[k - 1].drivers[i].tEnd;
          s0 = st.sA + d.lead;
        } else if (k === 0 && custom) {
          [s0, tLane] = custom.pts[i];
          // Placed outside the field (e.g. on the track): head straight into it.
          t0 = intervalsAt(st, s0).some(([a, b]) => tLane >= a && tLane <= b) ? tLane : null;
        } else {
          tLane = laneT(st, d.f);
          const [near] = laneOf(st, tLane);
          if (near <= st.sA + START_ZONE) {
            s0 = Math.max(st.sA + d.lead, near);
            t0 = tLane;
          } else {
            s0 = st.sA + d.lead;
            t0 = propT(st, Math.max(s0, st.sA + 3), d.f, tLane);
          }
        }
        const tEnd = propT(st, st.sFreeze, d.f, tLane);
        let far = Math.max(laneOf(st, tEnd)[1], Math.min(st.sFreeze, farOf(st, d.f, tLane)));
        if (st.cap) far = Math.min(far, st.cap + d.lead); // stop at the 300 m mark, flanks ahead
        return { tLane, t0, s0, tEnd, far: Math.max(far, s0) };
      });
    }

    // Driver i in stage k, `tau` seconds after the stage started: (s, t, raw).
    // raw = position ignoring the standers (used for the drivers' front line).
    function driverIn(st, i, tau, stopFn) {
      const d = st.drivers[i], r = roster[i];
      const progress = v * tau;
      const lead = st.k === 0 ? r.lead + (r.lead0 - r.lead) * Math.max(0, 1 - progress / FORM_UP) : r.lead;
      const raw = Math.min(Math.max(d.s0, st.sLine0 + progress + lead), d.far);
      const s = stopFn ? Math.min(raw, stopFn(d.tLane)) : raw;
      // Spread proportionally over the local width, so the line always reaches
      // the side borders (wider or narrower field); blend in over the first
      // 60 m from the line-up position.
      const target = s >= st.sFreeze ? d.tEnd : propT(st, s, r.f, d.tLane);
      const k = d.t0 == null ? 1 : Math.min(1, Math.max(0, (s - d.s0) / 60));
      const t = k === 1 ? target : d.t0 + (target - d.t0) * k;
      return { s, t, raw };
    }

    // ---- timeline: stage k runs until the whole line has reached the far
    // boundary, then everyone walks over and lines up in stage k+1.
    let clock = 0;
    for (const [k, st] of stages.entries()) {
      st.begin = clock;
      if (k === stages.length - 1) break;
      st.active = firstTime((tau) => st.drivers.every((d, i) => driverIn(st, i, tau).raw >= d.far - 0.01), 0, (st.sB - st.sLine0 + 500) / v);
      const next = stages[k + 1];
      let maxDist = 0;
      for (let i = 0; i < roster.length; i++) {
        const a = driverIn(st, i, st.active), b = driverIn(next, i, 0);
        const pa = path.toXY(a.s, a.t), pb = path.toXY(b.s, b.t);
        maxDist = Math.max(maxDist, Math.hypot(pa[0] - pb[0], pa[1] - pb[1]));
      }
      // Walking over to the next field isn't through cover: faster, but never above maxSpeed.
      st.move = Math.max(30, maxDist / Math.min(1.5 * v, p.maxSpeed));
      clock = st.begin + st.active + st.move;
    }
    const last = stages[stages.length - 1];

    // Stage index and local time at a global time.
    function locate(time) {
      for (let k = 0; k < stages.length - 1; k++) {
        const st = stages[k];
        if (time < st.begin + st.active) return { k, tau: time - st.begin, moving: false };
        if (time < st.begin + st.active + st.move) return { k, tau: st.active, moving: (time - st.begin - st.active) / st.move };
      }
      return { k: stages.length - 1, tau: time - last.begin, moving: false };
    }

    // Raw drivers (s, t) at a global time, ignoring the standers.
    function rawDrivers(time) {
      const { k, tau, moving } = locate(time);
      const st = stages[k];
      return roster.map((_, i) => {
        const a = driverIn(st, i, tau);
        if (moving === false) return { s: a.raw, t: a.t };
        const b = driverIn(stages[k + 1], i, 0);
        return { s: a.s + (b.s - a.s) * moving, t: a.t + (b.t - a.t) * moving };
      });
    }
    // Front of the drivers' line at lane t (interpolated between drivers).
    function front(t, time) {
      const ds = rawDrivers(time).sort((a, b) => a.t - b.t);
      return interp(ds.map((d) => d.t), ds.map((d) => d.s), t);
    }

    const standerFloor = realLast.sA + 3; // standers don't walk out of the last field
    const vS = Math.min(p.standerSpeed, p.maxSpeed);
    const lastEnd = last.begin + firstTime((tau) => last.drivers.every((d, i) => driverIn(last, i, tau).raw >= d.far - 0.01), 0, (last.sB - last.sLine0 + 500) / v);
    const horizon = lastEnd + (sMax - sMin) / Math.min(v, vS) + 60;
    // The standers form one straight line across the direction of travel. It
    // sets off when the drivers have straightened at the 300 m mark (or, if the
    // last field is shorter, when they enter it): it starts at the furthest
    // stander and walks slowly towards the drivers; everyone else waits until
    // the line reaches them and then walks along.
    const markStage = stages.find((x) => x.mark);
    const realLastBegin = (markStage || last).begin;
    let tLineStart = Infinity, sTop = 0;
    if (standers.length) {
      sTop = Math.max(...standers.map((x) => x.s0));
      const near = standers.reduce((a, b) => (b.s0 < a.s0 ? b : a));
      const tEvent = markStage
        ? last.begin
        : firstTime((time) => time >= last.begin && near.s0 - front(near.t, time) <= p.meetDistance, 0, horizon);
      tLineStart = Math.max(realLastBegin, tEvent);
    }
    const lineS = (time) => sTop - vS * Math.max(0, time - tLineStart);
    const walked = (st, time) => Math.max(Math.min(st.s0, standerFloor), Math.min(st.s0, lineS(time)));
    for (const st of standers) {
      st.tStart = tLineStart + (sTop - st.s0) / vS;
      st.tMeet = firstTime((time) => walked(st, time) <= front(st.t, time), 0, horizon);
    }
    const standerS = (st, time) => walked(st, Math.min(time, st.tMeet));
    const standersLine = (t, time) => interp(standers.map((x) => x.t), standers.map((x) => standerS(x, time)), t);

    let idealDuration;
    if (standers.length) {
      const meet = Math.max(...standers.map((x) => x.tMeet));
      // ...and until every driver has reached the standers' line.
      const allIn = (time) => {
        const { k, tau } = locate(time);
        if (k < stages.length - 1) return false;
        return roster.every((_, i) => {
          const d = driverIn(last, i, tau);
          return d.raw >= standersLine(last.drivers[i].tLane, time) - 0.5 || d.raw >= last.drivers[i].far - 0.5;
        });
      };
      idealDuration = firstTime(allIn, meet, horizon);
    } else {
      idealDuration = lastEnd;
    }
    const firstStart = tLineStart;

    // The formation's ideal positions (local metres) at a time; `area` is the
    // stage index a person has to stay inside of (null while walking over).
    function idealAt(time) {
      time = Math.max(0, Math.min(idealDuration, time));
      const { k, tau, moving } = locate(time);
      const st = stages[k];
      const isLast = k === stages.length - 1;
      const stop = isLast && standers.length ? (t) => standersLine(t, time) : null;
      let waiting = false;
      const drivers = roster.map((r, i) => {
        let q = driverIn(st, i, tau, stop);
        if (moving !== false) {
          const b = driverIn(stages[k + 1], i, 0);
          q = { s: q.s + (b.s - q.s) * moving, t: q.t + (b.t - q.t) * moving };
        } else if (!isLast && q.s >= st.drivers[i].far - 0.01) {
          waiting = true;
        }
        // Walking over to another field: no field to stay in. Straightening at
        // the 300 m mark happens inside the same field, though.
        const area = moving === false ? k : stages[k + 1].afterMark ? k + 1 : null;
        return { xy: path.toXY(q.s, q.t), s: q.s, area };
      });
      const outS = standers.map((x) => {
        const sNow = standerS(x, time);
        // Waiting: exactly where placed. Walking in: along the inside of the field.
        return { xy: path.toXY(sNow, time > x.tStart ? clampInside(last, sNow, x.t) : x.t), s: time > x.tStart ? Infinity : -Infinity, area: stages.length - 1 };
      });
      // Distance between the lines, measured from the middle of the drivers' line
      // (the flanks are ahead of it) to the nearest stander.
      const centre = rawDrivers(time)[centreIdx].s;
      const gap = standers.length
        ? Math.max(0, Math.min(...standers.map((x) => standerS(x, time))) - centre)
        : Math.max(0, sMax - centre);
      const phase =
        time >= idealDuration ? 'done'
        : st.mark && (moving !== false || waiting) ? 'mark'
        : moving !== false ? 'reposition'
        : waiting ? 'gather'
        : time >= firstStart ? 'closing'
        : 'approach';
      return { phase, gap, stage: st.fieldNo, drivers, standers: outS };
    }

    // ---- walking: every person follows their ideal position, but never faster
    // than maxSpeed and never outside the field they are driving. Whoever has
    // further to go (outer side of a bend, sideways shifts, walking over to the
    // next field) falls behind and catches up. The drive is over when the
    // slowest person has arrived.
    // Index of the field (within stage k) containing pt, or -1.
    const fieldAt = (k, pt) => stages[k].raw.findIndex((rings) => insideRings(rings, pt));
    const maxStep = p.maxSpeed * STEP;
    const init = idealAt(0);
    const people = [
      ...init.drivers.map((d, i) => ({ kind: 'driver', n: i + 1, flank: roster[i].flank })),
      ...init.standers.map((d, j) => ({ kind: 'stander', n: j + 1 })),
    ];
    let pos = [...init.drivers, ...init.standers].map((d) => d.xy.slice());
    const track = pos.map((q) => [q[0], q[1]]); // flattened x,y per step
    const walkedDist = pos.map(() => 0);
    const stuck = pos.map(() => 0); // steps without progress; > 5 lifts the stay-inside rule briefly
    const finish = pos.map(() => 0);
    const cap = idealDuration * 3 + 3600;
    let time = 0;
    for (;;) {
      time += STEP;
      const ideal = idealAt(time);
      const targets = [...ideal.drivers, ...ideal.standers];
      const before = pos.map((q) => q.slice());
      let settled = time >= idealDuration;
      targets.forEach((tg, i) => {
        const q = pos[i];
        // While driving a field nobody aims outside it (e.g. the outer side of a
        // sharp bend sweeping past a corner): aim at the nearest inside point.
        // Exception: drivers still walking up to the field from behind it.
        if (tg.area != null && tg.s >= stages[tg.area].sA + 5 && fieldAt(tg.area, tg.xy) < 0) {
          tg = targets[i] = { ...tg, xy: pushInside(stages[tg.area].raw, tg.xy) };
        }
        let dx = tg.xy[0] - q[0], dy = tg.xy[1] - q[1];
        const d = Math.hypot(dx, dy);
        let next = d <= maxStep ? tg.xy.slice() : [q[0] + (dx / d) * maxStep, q[1] + (dy / d) * maxStep];
        // Stay inside the field while driving it: only within the field the person
        // is in and the target is in too (crossing a hedge to a neighbouring
        // field of the same stage is fine), and never faster than maxSpeed.
        if (tg.area != null && stuck[i] <= 5) {
          const fi = fieldAt(tg.area, tg.xy);
          if (fi >= 0 && fieldAt(tg.area, q) === fi && !insideRings(stages[tg.area].raw[fi], next)) {
            const pushed = pushInside([stages[tg.area].raw[fi]], next);
            const pd = Math.hypot(pushed[0] - q[0], pushed[1] - q[1]);
            next = pd <= maxStep ? pushed : [q[0] + ((pushed[0] - q[0]) / pd) * maxStep, q[1] + ((pushed[1] - q[1]) / pd) * maxStep];
          }
        }
        if (stuck[i] > 10) stuck[i] = 0;
        const step = Math.hypot(next[0] - q[0], next[1] - q[1]);
        const remaining = Math.hypot(tg.xy[0] - next[0], tg.xy[1] - next[1]);
        stuck[i] = step < 0.3 * maxStep && remaining > 1 ? stuck[i] + 1 : stuck[i] > 5 ? stuck[i] + 1 : 0;
        pos[i] = next;
        if (Math.hypot(tg.xy[0] - next[0], tg.xy[1] - next[1]) > 0.5) settled = false;
      });
      // People in a line keep their order: neighbours never swap sides (their
      // paths don't cross). The line's direction comes from the ideal positions.
      keepOrder(pos, targets, 0, roster.length);
      keepOrder(pos, targets, roster.length, targets.length);
      // The speed limit holds for the final movement, corrections included.
      pos.forEach((q, i) => {
        const b = before[i];
        let d = Math.hypot(q[0] - b[0], q[1] - b[1]);
        if (d > maxStep) {
          pos[i] = [b[0] + ((q[0] - b[0]) / d) * maxStep, b[1] + ((q[1] - b[1]) / d) * maxStep];
          d = maxStep;
        }
        walkedDist[i] += d;
        if (d > 0.05) finish[i] = time;
        track[i].push(pos[i][0], pos[i][1]);
      });
      if (settled || time > cap) break;
    }
    // Neighbours a..b-1 (in line order): if one would pass the other, both
    // are nudged apart (at most 1 m per step) so they stay side by side.
    function keepOrder(ps, tgs, a, b) {
      for (let pass = 0; pass < 2; pass++) {
        for (let i = a; i < b - 1; i++) {
          const ta = tgs[i].xy, tb = tgs[i + 1].xy;
          const dx = tb[0] - ta[0], dy = tb[1] - ta[1], dl = Math.hypot(dx, dy);
          if (dl < 1) continue;
          const ux = dx / dl, uy = dy / dl;
          const pa = ps[i], pb = ps[i + 1];
          // Only neighbours close enough to actually cross paths.
          if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) > 10) continue;
          const sep = (pb[0] - pa[0]) * ux + (pb[1] - pa[1]) * uy;
          if (sep >= 0.5) continue;
          const shift = Math.min(1, (0.5 - sep) / 2);
          ps[i] = [pa[0] - ux * shift, pa[1] - uy * shift];
          ps[i + 1] = [pb[0] + ux * shift, pb[1] + uy * shift];
        }
      }
    }
    const duration = time;
    const slowest = finish.indexOf(Math.max(...finish));

    function stateAt(t) {
      t = Math.max(0, Math.min(duration, t));
      const f = t / STEP, i0 = Math.floor(f), u = f - i0;
      const at = (i) => {
        const tr = track[i], n = tr.length / 2 - 1, a = Math.min(i0, n), b = Math.min(i0 + 1, n);
        return proj.toLatLng([tr[2 * a] + (tr[2 * b] - tr[2 * a]) * u, tr[2 * a + 1] + (tr[2 * b + 1] - tr[2 * a + 1]) * u]);
      };
      const ideal = idealAt(t);
      const nd = roster.length;
      const phase = t >= duration ? 'done' : ideal.phase === 'done' ? 'catchup' : ideal.phase;
      return {
        time: t,
        phase,
        gap: ideal.gap,
        stage: ideal.stage,
        stages: fieldCount,
        drivers: roster.map((r, i) => ({ pos: at(i), flank: r.flank })),
        standers: standers.map((_, j) => ({ pos: at(nd + j) })),
      };
    }

    const stats = {
      people: people.map((pp, i) => ({ ...pp, distance: walkedDist[i], finish: finish[i] })),
      slowest: { ...people[slowest], distance: walkedDist[slowest], finish: finish[slowest] },
    };

    // Path walked by person i (drivers first, then standers) up to time t, as [[lat,lng], ...].
    function trackUntil(i, t) {
      const tr = track[i], n = Math.min(tr.length / 2, Math.floor(Math.max(0, t) / STEP) + 1);
      const out = [];
      for (let k = 0; k < n; k++) out.push(proj.toLatLng([tr[2 * k], tr[2 * k + 1]]));
      out.push(stateAtPerson(i, t));
      return out;
    }
    const stateAtPerson = (i, t) => {
      const st = stateAt(t);
      return i < roster.length ? st.drivers[i].pos : st.standers[i - roster.length].pos;
    };

    return { duration, depth: sMax - sMin, stages: fieldCount, params: p, custom: !!custom, stats, stateAt, trackUntil };
  }

  // Even-odd point in polygon over all rings of one field (outer rings + holes).
  function insideRings(rings, [x, y]) {
    let inside = false;
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i], [xj, yj] = r[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  // Move a point that left the area back onto the nearest border, 1 m inside.
  function pushInside(fields, p) {
    let best = null, bestD = Infinity;
    for (const rings of fields) {
      for (const r of rings) {
        for (let i = 0; i < r.length - 1; i++) {
          const [ax, ay] = r[i], [bx, by] = r[i + 1];
          const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
          const u = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
          const q = [ax + u * dx, ay + u * dy];
          const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (d < bestD) (bestD = d), (best = q);
        }
      }
    }
    if (!best || bestD < 1e-6) return best || p;
    const ux = (best[0] - p[0]) / bestD, uy = (best[1] - p[1]) / bestD;
    return [best[0] + ux, best[1] + uy];
  }

  // Distribute n points evenly along a polyline ([[lat,lng], ...]).
  function distributeAlong(line, n) {
    if (!n) return [];
    if (line.length === 1 || n === 1) return Array.from({ length: n }, () => line[Math.floor(line.length / 2)]);
    const proj = makeProjection(line[0][0], line[0][1]);
    const pts = line.map(proj.toXY);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[cum.length - 1];
    const out = [];
    for (let k = 0; k < n; k++) {
      const d = (k / (n - 1)) * total;
      let i = 1;
      while (i < pts.length - 1 && cum[i] < d) i++;
      const u = cum[i] === cum[i - 1] ? 0 : (d - cum[i - 1]) / (cum[i] - cum[i - 1]);
      out.push(proj.toLatLng([pts[i - 1][0] + u * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + u * (pts[i][1] - pts[i - 1][1])]));
    }
    return out;
  }

  global.DriveSim = { createSimulation, distributeAlong, makeProjection, makePathFrame, ringsOf, DEFAULTS };
})(typeof window !== 'undefined' ? window : globalThis);
