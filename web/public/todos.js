'use strict';
// Shared to-do checklist (Aufgaben) for all users. Each task has a "done" flag,
// a column for Bernd and one for "Ich" (me), and a free-text note. Opened from a
// map control (📋); changes sync live to every open app via SSE.

(function () {
  const Todos = { list: [] };
  window.Todos = Todos;
  let button;

  Todos.init = async function () {
    // Editor-only feature: viewers never see the control or load the list.
    if (state.me.role !== 'editor') return;
    new (L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const bar = L.DomUtil.create('div', 'leaflet-bar todo-control');
        button = L.DomUtil.create('a', '', bar);
        button.href = '#';
        button.title = 'Aufgaben';
        button.textContent = '📋';
        L.DomEvent.disableClickPropagation(bar);
        L.DomEvent.on(button, 'click', (e) => {
          L.DomEvent.preventDefault(e);
          open();
        });
        return bar;
      },
    }))().addTo(map);

    $('todos-close').addEventListener('click', close);
    $('todos').addEventListener('click', (e) => {
      if (e.target.id === 'todos') close(); // click on the backdrop
    });
    $('todo-add').addEventListener('click', addTodo);
    await Todos.reload();
  };

  Todos.reload = async function () {
    if (state.me.role !== 'editor') return; // viewers have no access
    Todos.list = await api('GET', '/api/todos');
    // Don't rebuild the list while someone is typing in it — redraw on blur.
    if (isHidden() || editingText()) {
      Todos.pending = !isHidden();
      return;
    }
    render();
  };

  const isHidden = () => $('todos').classList.contains('hidden');
  const editingText = () => $('todo-list').contains(document.activeElement) && document.activeElement.matches('input[type=text]');

  function open() {
    // Only one tool / modal at a time.
    window.Markers?.stop?.();
    window.Measure?.stop?.();
    window.Sketch?.cancel?.(true);
    $('todos-error').textContent = '';
    $('todos').classList.remove('hidden');
    render();
  }
  function close() {
    $('todos').classList.add('hidden');
  }

  function render() {
    Todos.pending = false;
    const box = $('todo-list');
    box.textContent = '';
    $('todo-empty').classList.toggle('hidden', Todos.list.length > 0);

    for (const t of Todos.list) {
      const row = document.createElement('div');
      row.className = 'todo-row' + (t.done ? ' done' : '');
      row.innerHTML = `
        <label class="todo-done" title="Erledigt"><input type="checkbox" data-k="done" ${t.done ? 'checked' : ''} /></label>
        <input class="todo-text" type="text" maxlength="1000" placeholder="Aufgabe…" />
        <label class="todo-check"><span>Bernd</span><input type="checkbox" data-k="bernd" ${t.bernd ? 'checked' : ''} /></label>
        <label class="todo-check"><span>Ich</span><input type="checkbox" data-k="me" ${t.me ? 'checked' : ''} /></label>
        <button class="icon danger todo-del" title="Löschen">🗑</button>`;

      const text = row.querySelector('.todo-text');
      text.value = t.text;
      // Save text when the field loses focus or on Enter.
      text.addEventListener('change', () => save(t, { text: text.value }));
      text.addEventListener('keydown', (e) => e.key === 'Enter' && text.blur());

      row.querySelectorAll('input[type=checkbox]').forEach((cb) =>
        cb.addEventListener('change', () => save(t, { [cb.dataset.k]: cb.checked }))
      );
      row.querySelector('.todo-del').addEventListener('click', () => remove(t));
      box.appendChild(row);
    }
  }

  async function addTodo() {
    try {
      await api('POST', '/api/todos', { text: '', done: false, bernd: false, me: false });
      await Todos.reload();
      // Focus the new (last) task's text field right away.
      const last = $('todo-list').querySelector('.todo-row:last-child .todo-text');
      last?.focus();
    } catch (err) {
      $('todos-error').textContent = err.message;
    }
  }

  async function save(t, patch) {
    Object.assign(t, patch);
    try {
      await api('PUT', `/api/todos/${t.id}`, { text: t.text, done: t.done, bernd: t.bernd, me: t.me });
      $('todos-error').textContent = '';
      await Todos.reload();
    } catch (err) {
      $('todos-error').textContent = err.message;
    }
  }

  async function remove(t) {
    if (!confirm('Aufgabe löschen?')) return;
    try {
      await api('DELETE', `/api/todos/${t.id}`);
      await Todos.reload();
    } catch (err) {
      $('todos-error').textContent = err.message;
    }
  }

  // Redraw once the user finishes editing a text field, if updates arrived meanwhile.
  document.addEventListener('focusout', (e) => {
    if (Todos.pending && e.target.matches?.('.todo-text')) setTimeout(() => Todos.pending && !editingText() && render());
  });
})();
