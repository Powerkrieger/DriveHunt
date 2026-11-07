// Field geometry operations: split a field along a drawn line, merge fields.
// Depends on polygon-clipping (global `polygonClipping`) and DriveSim.makeProjection.

(function (global) {
  const pc = global.polygonClipping || (typeof require !== 'undefined' && require('polygon-clipping'));
  const MIN_PIECE_M2 = 20; // drop slivers created by a sloppy cut

  const asMulti = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
  const fromMulti = (m) => (m.length === 1 ? { type: 'Polygon', coordinates: m[0] } : { type: 'MultiPolygon', coordinates: m });
  const round = (m) => m.map((poly) => poly.map((ring) => ring.map(([x, y]) => [+x.toFixed(8), +y.toFixed(8)])));

  // Thin rectangles (half-width w metres) along a line given in local metres.
  function strip(pts, w, proj) {
    const quads = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.001) continue;
      const nx = (-(by - ay) / len) * w, ny = ((bx - ax) / len) * w;
      const ring = [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny], [ax + nx, ay + ny]]
        .map(proj.toLatLng)
        .map(([lat, lng]) => [lng, lat]);
      quads.push([ring]);
    }
    return quads;
  }

  function polygonAreaM2(poly) {
    const [lng0, lat0] = poly[0][0];
    const proj = global.DriveSim.makeProjection(lat0, lng0);
    let total = 0;
    poly.forEach((ring, i) => {
      const r = ring.map(([lng, lat]) => proj.toXY([lat, lng]));
      let a = 0;
      for (let k = 0; k < r.length - 1; k++) a += r[k][0] * r[k + 1][1] - r[k + 1][0] * r[k][1];
      total += (i === 0 ? 1 : -1) * Math.abs(a / 2);
    });
    return total;
  }

  // Cut `geometry` along `line` ([[lat,lng], ...]). The line is turned into a
  // 2 cm wide "blade" polygon that is subtracted from the field; every
  // remaining part becomes its own field. Returns an array of geometries.
  function splitGeometry(geometry, line) {
    if (line.length < 2) throw new Error('Die Schnittlinie braucht mindestens zwei Punkte.');
    const proj = global.DriveSim.makeProjection(line[0][0], line[0][1]);
    const pts = line.map(proj.toXY);
    // Extend both ends a little so a cut ending exactly on the border still goes through.
    const ext = (p, q) => {
      const len = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
      return [p[0] + ((p[0] - q[0]) / len) * 3, p[1] + ((p[1] - q[1]) / len) * 3];
    };
    pts[0] = ext(pts[0], pts[1]);
    pts[pts.length - 1] = ext(pts[pts.length - 1], pts[pts.length - 2]);

    // 1 cm half-width: pieces end up 2 cm apart, invisible but topologically separate.
    const quads = strip(pts, 0.01, proj);
    if (!quads.length) throw new Error('Die Schnittlinie ist zu kurz.');
    const blade = pc.union(...quads);
    const pieces = pc.difference(asMulti(geometry), blade).filter((poly) => polygonAreaM2(poly) >= MIN_PIECE_M2);
    if (pieces.length < 2) throw new Error('Die Linie muss das Feld komplett durchqueren (von Rand zu Rand).');
    return round(pieces).map((poly) => ({ type: 'Polygon', coordinates: poly }));
  }

  // Union of several fields. `touching` is false when the result has separate parts.
  // Fields that were split before are 2 cm apart; if a plain union leaves several
  // parts, retry with every outline widened by 5 cm to bridge such hairline gaps.
  function mergeGeometries(geometries) {
    let merged = pc.union(...geometries.map(asMulti));
    if (merged.length > 1) {
      const [lng0, lat0] = asMulti(geometries[0])[0][0][0];
      const proj = global.DriveSim.makeProjection(lat0, lng0);
      const edges = geometries.flatMap((g) =>
        asMulti(g).flatMap((poly) => poly.flatMap((ring) => strip(ring.map(([lng, lat]) => proj.toXY([lat, lng])), 0.05, proj)))
      );
      const bridged = pc.union(...geometries.map(asMulti), ...edges);
      if (bridged.length < merged.length) merged = bridged;
    }
    return { geometry: fromMulti(round(merged)), touching: merged.length === 1 };
  }

  // Hand-drawn outline ([[lat,lng], ...]) -> valid (Multi)Polygon; self-intersections are resolved.
  function polygonFromPoints(points) {
    const ring = points.map(([lat, lng]) => [lng, lat]);
    ring.push(ring[0]);
    const clean = pc.union([[ring]]).filter((poly) => polygonAreaM2(poly) >= MIN_PIECE_M2);
    if (!clean.length) throw new Error('Die Fläche ist zu klein.');
    return fromMulti(round(clean));
  }

  global.FieldGeometry = { splitGeometry, mergeGeometries, polygonFromPoints, polygonAreaM2 };
})(typeof window !== 'undefined' ? window : globalThis);
