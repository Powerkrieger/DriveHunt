'use strict';
// Measuring tool (all users): tap points to measure distances; with 3+ points
// the enclosed area is shown too. Ruler button in the top-left map controls.

(function () {
  const Measure = { active: false, points: [] };
  window.Measure = Measure;
  let layer, panel, button;

  const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2).replace('.', ',')} km`);
  const fmtArea = (m2) => (m2 < 10000 ? `${Math.round(m2)} m²` : `${(m2 / 10000).toFixed(2).replace('.', ',')} ha`);

  function areaM2(points) {
    const proj = DriveSim.makeProjection(points[0][0], points[0][1]);
    const r = points.map(proj.toXY);
    let a = 0;
    for (let i = 0; i < r.length; i++) {
      const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a / 2);
  }

  function draw() {
    layer.clearLayers();
    const pts = Measure.points;
    let total = 0;
    if (pts.length >= 3) {
      L.polygon(pts, { stroke: false, fillColor: '#ffeb3b', fillOpacity: 0.2, interactive: false }).addTo(layer);
    }
    if (pts.length >= 2) {
      L.polyline(pts, { color: '#000', weight: 5, opacity: 0.5, interactive: false }).addTo(layer);
      L.polyline(pts, { color: '#ffeb3b', weight: 3, dashArray: '8 6', interactive: false }).addTo(layer);
    }
    for (let i = 1; i < pts.length; i++) {
      const d = map.distance(pts[i - 1], pts[i]);
      total += d;
      const mid = [(pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2];
      L.tooltip({ permanent: true, direction: 'center', className: 'measure-label', interactive: false })
        .setLatLng(mid)
        .setContent(fmtDist(d))
        .addTo(layer);
    }
    for (const p of pts) L.circleMarker(p, { radius: 5, color: '#000', weight: 2, fillColor: '#ffeb3b', fillOpacity: 1, interactive: false }).addTo(layer);

    panel.innerHTML = `
      <div><b>Strecke:</b> ${pts.length > 1 ? fmtDist(total) : '–'}</div>
      ${pts.length >= 3 ? `<div><b>Fläche:</b> ${fmtArea(areaM2(pts))}</div>` : ''}
      <div class="muted">${pts.length ? 'Weitere Punkte antippen' : 'Punkte auf der Karte antippen'}</div>
      <div class="row">
        <button data-act="undo" ${pts.length ? '' : 'disabled'}>↶</button>
        <button data-act="clear" ${pts.length ? '' : 'disabled'}>Neu</button>
        <button data-act="close">Beenden</button>
      </div>`;
  }

  Measure.stop = () => Measure.active && setActive(false);

  function setActive(on) {
    if (on) {
      // Only one tool / modal at a time.
      window.Markers?.stop?.();
      window.Sketch?.cancel?.(true);
      map.closePopup();
    }
    Measure.active = on;
    Measure.points = [];
    button.classList.toggle('active', on);
    panel.classList.toggle('hidden', !on);
    document.body.classList.toggle('picking', on || !!window.Sketch?.active || !!window.FieldEdit?.tool);
    on ? map.doubleClickZoom.disable() : map.doubleClickZoom.enable();
    if (on) draw();
    else layer.clearLayers();
  }

  const MeasureControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const box = L.DomUtil.create('div', 'measure-control');
      const bar = L.DomUtil.create('div', 'leaflet-bar', box);
      button = L.DomUtil.create('a', '', bar);
      button.href = '#';
      button.title = 'Messen (Strecke / Fläche)';
      button.textContent = '📏';
      panel = L.DomUtil.create('div', 'measure-panel hidden', box);
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.on(button, 'click', (e) => {
        L.DomEvent.preventDefault(e);
        setActive(!Measure.active);
      });
      L.DomEvent.on(panel, 'click', (e) => {
        const act = e.target.dataset?.act;
        if (act === 'undo') Measure.points.pop();
        if (act === 'clear') Measure.points = [];
        if (act === 'close') return setActive(false);
        draw();
      });
      return box;
    },
  });

  // The map is created in app.js after login; hook in once it exists.
  const wait = setInterval(() => {
    if (typeof map === 'undefined' || !map) return;
    clearInterval(wait);
    layer = L.layerGroup().addTo(map);
    new MeasureControl().addTo(map);
    map.on('click', (e) => {
      if (!Measure.active) return;
      Measure.points.push([e.latlng.lat, e.latlng.lng]);
      draw();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && Measure.active) setActive(false);
    });
  }, 200);
})();
