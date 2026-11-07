'use strict';
// Point-by-point drawing on the map (direction path, hunters' lines, new
// fields, cut lines) plus the action bar at the bottom centre of the map.
//
// Every point is a handle: drag to move (handles grow on hover), right-click /
// long press to remove. Taps near a field corner snap to it.

(function () {
  // ------------------------------------------------------------ action bar

  const bar = document.createElement('div');
  bar.id = 'action-bar';
  bar.className = 'hidden';
  bar.innerHTML = `
    <div class="ab-text"></div>
    <div class="ab-buttons">
      <button class="ab-undo" title="Letzten Punkt entfernen">↶ Zurück</button>
      <button class="ab-done primary">✓ Fertig</button>
      <button class="ab-cancel">✕ Abbrechen</button>
    </div>`;
  document.getElementById('app').appendChild(bar);
  L.DomEvent.disableClickPropagation(bar);

  let current = null; // { onDone, onCancel, onUndo }
  const ActionBar = {
    show(opts) {
      current = opts;
      bar.classList.remove('hidden');
      ActionBar.update(opts);
      // Small screens: fold the side panel away so the map is usable.
      if (window.innerWidth <= 700) document.getElementById('panel').classList.add('collapsed');
    },
    update({ text, canDone = true, canUndo = false, undo = !!current?.onUndo }) {
      bar.querySelector('.ab-text').innerHTML = text;
      bar.querySelector('.ab-done').disabled = !canDone;
      bar.querySelector('.ab-undo').classList.toggle('hidden', !undo);
      bar.querySelector('.ab-undo').disabled = !canUndo;
    },
    hide() {
      current = null;
      bar.classList.add('hidden');
      if (window.innerWidth <= 700) document.getElementById('panel').classList.remove('collapsed');
    },
    get visible() {
      return !!current;
    },
  };
  bar.querySelector('.ab-done').addEventListener('click', () => current?.onDone());
  bar.querySelector('.ab-cancel').addEventListener('click', () => current?.onCancel());
  bar.querySelector('.ab-undo').addEventListener('click', () => current?.onUndo?.());
  document.addEventListener('keydown', (e) => {
    if (!current || e.target.matches('input, textarea, select')) return;
    if (e.key === 'Enter' && !bar.querySelector('.ab-done').disabled) current.onDone();
    if (e.key === 'Escape') current.onCancel();
  });
  window.ActionBar = ActionBar;

  // ------------------------------------------------------------ sketch

  let layer;
  const Sketch = { active: null };
  window.Sketch = Sketch;

  // Draggable point handle. onMove(latlng) while dragging, onRemove() on
  // right-click / long press.
  function handle(pos, { onMove, onEnd, onRemove, className = '' }) {
    const m = L.marker(pos, {
      draggable: true,
      autoPan: true,
      icon: L.divIcon({ className: `point-handle ${className}`, iconSize: [16, 16] }),
      zIndexOffset: 1000,
    });
    m.on('drag', () => onMove?.(m.getLatLng()));
    m.on('dragend', () => onEnd?.(m.getLatLng()));
    if (onRemove) m.on('contextmenu', (e) => (L.DomEvent.stop(e), onRemove()));
    return m;
  }
  Sketch.handle = handle;

  // Snap a tap to the nearest field corner within 12 px.
  function snap(latlng) {
    const p = map.latLngToContainerPoint(latlng);
    let best = null, bestD = 12;
    const near = L.latLngBounds(map.containerPointToLatLng([p.x - 12, p.y + 12]), map.containerPointToLatLng([p.x + 12, p.y - 12]));
    for (const lyr of state.fieldLayers.values()) {
      if (!lyr.getBounds().pad(0.01).intersects(near)) continue;
      for (const ring of DriveSim.ringsOf(lyr.feature.geometry)) {
        for (const ll of ring) {
          if (!near.contains(ll)) continue;
          const q = map.latLngToContainerPoint(ll);
          const d = Math.hypot(q.x - p.x, q.y - p.y);
          if (d < bestD) (bestD = d), (best = ll);
        }
      }
    }
    return best ? [best[0], best[1]] : [latlng.lat, latlng.lng];
  }

  /**
   * Start drawing.
   * opts: { kind: 'line'|'polygon', color, arrow, min, texts: [first, more], snap, onDone(points), onCancel() }
   */
  Sketch.start = function (opts) {
    Sketch.cancel(true);
    layer ||= L.layerGroup().addTo(map);
    Sketch.active = { ...opts, points: opts.points ? opts.points.slice() : [] };
    document.body.classList.add('picking');
    map.doubleClickZoom.disable();
    ActionBar.show({
      onDone: () => {
        const { points, onDone } = Sketch.active;
        Sketch.cancel(true);
        onDone(points);
      },
      onCancel: () => {
        const cb = Sketch.active.onCancel;
        Sketch.cancel(true);
        cb?.();
      },
      onUndo: () => {
        Sketch.active.points.pop();
        redraw();
      },
    });
    redraw();
  };

  Sketch.cancel = function (silent) {
    if (!Sketch.active) return;
    const cb = Sketch.active.onCancel;
    Sketch.active = null;
    layer?.clearLayers();
    document.body.classList.remove('picking');
    map.doubleClickZoom.enable();
    ActionBar.hide();
    if (!silent) cb?.();
  };

  function preview(points) {
    const a = Sketch.active;
    const out = [];
    if (a.kind === 'polygon' && points.length >= 3) {
      out.push(L.polygon(points, { color: a.color, weight: 3, fillOpacity: 0.25, interactive: false }));
    } else if (points.length >= 2) {
      const shaft = a.arrow ? arrowLayers(points, a.color) : [];
      out.push(...(shaft.length ? shaft : [L.polyline(points, { color: a.color, weight: 4, dashArray: a.arrow ? null : '8 6', interactive: false })]));
    }
    return out;
  }

  let previewLayers = [];
  function redrawPreview() {
    previewLayers.forEach((l) => l.remove());
    previewLayers = preview(Sketch.active.points);
    previewLayers.forEach((l) => l.addTo(layer));
  }

  function redraw() {
    const a = Sketch.active;
    layer.clearLayers();
    previewLayers = [];
    redrawPreview();
    a.points.forEach((pt, i) => {
      handle(pt, {
        className: i === 0 ? 'first' : '',
        onMove: (ll) => {
          a.points[i] = [ll.lat, ll.lng];
          redrawPreview();
        },
        onEnd: (ll) => {
          a.points[i] = a.snap ? snap(ll) : [ll.lat, ll.lng];
          redraw();
        },
        onRemove: () => {
          a.points.splice(i, 1);
          redraw();
        },
      }).addTo(layer);
    });
    const n = a.points.length;
    ActionBar.update({
      text: a.texts[n ? 1 : 0] + (n ? ' <span class="muted">Punkte lassen sich verschieben.</span>' : ''),
      canDone: n >= a.min,
      canUndo: n > 0,
    });
  }

  // Map taps add points while sketching (registered once the map exists).
  const wait = setInterval(() => {
    if (typeof map === 'undefined' || !map) return;
    clearInterval(wait);
    map.on('click', (e) => {
      if (!Sketch.active || window.Measure?.active) return;
      if (Sketch.active.points.length >= 100) return;
      Sketch.active.points.push(Sketch.active.snap ? snap(e.latlng) : [e.latlng.lat, e.latlng.lng]);
      redraw();
    });
  }, 100);
})();
