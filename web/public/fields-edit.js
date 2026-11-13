'use strict';
// Field editing (editors only): draw new fields, split, reshape, merge, delete,
// rename / change type (field, forest, scrub, water).
// Drawing uses Sketch (sketch.js), reshaping Leaflet-Geoman; split/merge use FieldGeometry (geometry.js).
// Every change is one POST /api/fields/replace { remove: [ids], add: [{geometry}] }.

(function () {
  const FieldEdit = {
    selected: new Set(),
    tool: null, // null | 'draw' | 'split' | 'edit' (while a tool runs, taps belong to it)
    editLayer: null,
  };
  window.FieldEdit = FieldEdit;

  function initGeoman() {
    if (FieldEdit.geomanReady) return;
    FieldEdit.geomanReady = true;
    map.pm.setLang('de');
    map.pm.setGlobalOptions({ snappable: true, snapDistance: 15 });
  }

  // ------------------------------------------------------------ view

  $('edit-fields').addEventListener('click', () => {
    window.Lock?.release(); // field editing needs field taps
    initGeoman();
    stopSim();
    FieldEdit.selected.clear();
    setView('fields');
    update();
    render();
  });
  $('fields-back').addEventListener('click', () => {
    cancelTool();
    FieldEdit.selected.clear();
    showList();
  });
  $('fsel-clear').addEventListener('click', () => {
    FieldEdit.selected.clear();
    update();
    renderFields();
  });

  FieldEdit.onFieldClick = (id) => {
    if (FieldEdit.tool) return; // clicks belong to the drawing tool
    FieldEdit.selected.has(id) ? FieldEdit.selected.delete(id) : FieldEdit.selected.add(id);
    $('fields-error').textContent = '';
    update();
    renderFields();
  };

  FieldEdit.onFieldsReloaded = () => {
    for (const id of FieldEdit.selected) if (!state.fieldLayers.has(id)) FieldEdit.selected.delete(id);
    if (state.view === 'fields') update();
  };

  function update() {
    const sel = [...FieldEdit.selected];
    const n = sel.length;
    $('fsel-count').textContent = n;
    const busy = !!FieldEdit.tool;
    $('ftool-draw').disabled = busy;
    $('ftool-split').disabled = busy || n !== 1;
    $('ftool-edit').disabled = busy || n !== 1;
    $('ftool-merge').disabled = busy || n < 2;
    $('ftool-delete').disabled = busy || n < 1;

    $('fsel-name-row').classList.toggle('hidden', n !== 1 || busy);
    if (n === 1) {
      const p = state.fieldLayers.get(sel[0]).feature.properties;
      $('fsel-name').value = p.name || '';
      $('fsel-type').value = ['grass', 'grassland'].includes(p.landuse) ? 'meadow' : p.landuse === 'custom' ? 'other' : p.landuse;
      $('fsel-info').innerHTML =
        `${esc(LANDUSE_DE[p.landuse] || p.landuse)} · ${areaHa(state.fieldGeom.get(sel[0])).toFixed(2)} ha` +
        (p.flik ? ` · ${esc(p.flik)}` : '') +
        (p.custom ? ' · bearbeitet' : '');
    } else {
      $('fsel-info').textContent = n ? `${sel.reduce((s, id) => s + areaHa(state.fieldGeom.get(id)), 0).toFixed(2)} ha gesamt` : '';
    }
  }

  // ------------------------------------------------------------ server

  async function replace(remove, add) {
    $('fields-error').textContent = '';
    try {
      const { added } = await api('POST', '/api/fields/replace', { remove, add: add.map((geometry) => ({ geometry })) });
      FieldEdit.selected = new Set(added);
      await reloadFields();
      // Drives may have changed too (fields replaced inside them).
      state.hunts = await api('GET', '/api/hunts');
      update();
      render();
    } catch (err) {
      $('fields-error').textContent = err.message;
    }
  }

  $('fsel-name-save').addEventListener('click', async () => {
    const [id] = FieldEdit.selected;
    try {
      await api('POST', '/api/fields/props', { id, name: $('fsel-name').value, landuse: $('fsel-type').value });
      await reloadFields();
    } catch (err) {
      $('fields-error').textContent = err.message;
    }
  });

  // ------------------------------------------------------------ tools

  function endTool() {
    FieldEdit.tool = null;
    document.body.classList.remove('picking');
    update();
  }

  function cancelTool() {
    if (!FieldEdit.tool) return;
    Sketch.cancel(true);
    if (FieldEdit.editLayer) {
      FieldEdit.editLayer.pm.disable();
      FieldEdit.editLayer = null;
      ActionBar.hide();
      reloadFields(); // restore the original shape
    }
    endTool();
  }
  FieldEdit.cancelTool = cancelTool;

  function sketch(tool, opts) {
    $('fields-error').textContent = '';
    FieldEdit.tool = tool;
    update();
    Sketch.start({ ...opts, snap: true, onCancel: endTool, onDone: (points) => (endTool(), opts.onDone(points)) });
  }

  $('ftool-draw').addEventListener('click', () =>
    sketch('draw', {
      kind: 'polygon', color: '#ffeb3b', min: 3,
      texts: ['Ecken des neuen Feldes nacheinander antippen (rastet an vorhandenen Ecken ein).', 'Weitere Ecken antippen.'],
      onDone: (points) => {
        try {
          replace([], [FieldGeometry.polygonFromPoints(points)]);
        } catch (err) {
          $('fields-error').textContent = err.message;
        }
      },
    })
  );

  $('ftool-split').addEventListener('click', () => {
    const [id] = FieldEdit.selected;
    sketch('split', {
      kind: 'line', color: '#ffeb3b', min: 2,
      texts: ['Schnittlinie: ersten Punkt <b>außerhalb</b> des Feldes antippen.', 'Weitere Punkte – die Linie muss das Feld von Rand zu Rand durchqueren.'],
      onDone: (line) => {
        try {
          replace([id], FieldGeometry.splitGeometry(state.fieldGeom.get(id), line));
        } catch (err) {
          $('fields-error').textContent = err.message;
        }
      },
    });
  });

  // Reshape an existing field: Geoman vertex editing, confirmed via the action bar.
  $('ftool-edit').addEventListener('click', () => {
    const [id] = FieldEdit.selected;
    const layer = state.fieldLayers.get(id);
    $('fields-error').textContent = '';
    FieldEdit.tool = 'edit';
    FieldEdit.editLayer = layer;
    document.body.classList.add('picking');
    update();
    layer.pm.enable({ allowSelfIntersection: false, snappable: true });
    ActionBar.show({
      text: 'Eckpunkte ziehen. Punkte auf den Kanten ziehen fügt Ecken hinzu, Rechtsklick / langes Drücken auf eine Ecke löscht sie.',
      onCancel: cancelTool,
      onDone: () => {
        layer.pm.disable();
        FieldEdit.editLayer = null;
        ActionBar.hide();
        endTool();
        replace([id], [layer.toGeoJSON(8).geometry]);
      },
    });
  });

  $('ftool-merge').addEventListener('click', () => {
    const ids = [...FieldEdit.selected];
    const { geometry, touching } = FieldGeometry.mergeGeometries(ids.map((id) => state.fieldGeom.get(id)));
    if (!touching && !confirm('Die Felder berühren sich nicht. Trotzdem zu einem (mehrteiligen) Feld zusammenfassen?')) return;
    replace(ids, [geometry]);
  });

  $('ftool-delete').addEventListener('click', () => {
    const ids = [...FieldEdit.selected];
    if (!confirm(`${ids.length} Feld(er) löschen? Sie werden auch aus allen Treiben entfernt.`)) return;
    replace(ids, []);
  });
})();
