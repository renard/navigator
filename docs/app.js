// The converter's page.
//
// Nothing here parses a GPX file or packs a route. That is done by
// navigator.wasm, which is the same Go source the command line tool is
// built from, compiled for the browser. The packing rules are exactly
// the kind of thing that drifts when there are two copies of them, and
// a rule changing on one side only would produce a string that builds
// and then misleads a pilot.
//
// The file never leaves the machine. There is no server to send it to:
// the page is static and the conversion happens in the tab.
//
// What comes back describes a file the visitor chose, which means it is
// their own text coming back at them. It is still put on the page
// through textContent and never through innerHTML or a template
// string, so a waypoint called <script> stays a waypoint called
// <script>. The Go side cleans those names too, and neither relies on
// the other having done it.

'use strict';

const el = (id) => document.getElementById(id);

// The last answer, kept only so the download button has something to
// write. Nothing is stored.
let packed = '';
let ready = false;

function show(id, on) {
  el(id).hidden = !on;
}

function clear(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function cell(row, text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) {
    td.className = className;
  }
  row.appendChild(td);
  return td;
}

function render(answer) {
  packed = answer.packed || '';

  const body = el('routes');
  clear(body);
  (answer.routes || []).forEach((route) => {
    const row = document.createElement('tr');
    cell(row, route.name);
    cell(row, (route.lengthM / 1852).toFixed(1) + ' NM', 'num');
    cell(row, route.waypoints.join(', '));
    cell(row, String(route.bytes), 'num');
    body.appendChild(row);
  });

  const notes = el('notes');
  clear(notes);
  (answer.notes || []).forEach((text) => {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = text;
    notes.appendChild(p);
  });

  const refused = el('refused');
  clear(refused);
  (answer.refused || []).forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    refused.appendChild(li);
  });
  show('problem', (answer.refused || []).length > 0);

  el('packed').value = packed;
  const over = answer.bytes > answer.slot;
  el('size').textContent = answer.bytes + ' characters of the ' +
    answer.slot + ' the slot holds' + (over ? ', which is too many' : '');
  el('size').className = over ? 'note' : '';

  show('result', (answer.routes || []).length > 0);
}

// The converter itself, fetched once and kept.
//
// It is about a megabyte over the wire, so the page says so while it
// comes rather than looking broken, and nothing is accepted until it
// is here.
async function load() {
  const go = new Go();
  try {
    let source;
    try {
      source = await WebAssembly.instantiateStreaming(
        fetch('navigator.wasm'), go.importObject);
    } catch (streamingFailed) {
      // instantiateStreaming insists on being served
      // application/wasm, and a plain file server does not always say
      // so. Reading the bytes first works wherever fetch does, at the
      // cost of holding three megabytes for a moment.
      const bytes = await (await fetch('navigator.wasm')).arrayBuffer();
      source = await WebAssembly.instantiate(bytes, go.importObject);
    }
    go.run(source.instance);
    ready = true;
    show('loading', false);
  } catch (err) {
    el('loadingText').textContent = 'the converter could not be ' +
      'loaded, so nothing on this page will work';
  }
}

async function convert(files) {
  if (!ready || !files || files.length === 0) {
    return;
  }
  show('busy', true);
  show('result', false);
  show('problem', false);

  // Reading a file is asynchronous and packing is not, so the whole
  // set is read first and converted in one call. That is also what
  // makes the warning about two routes of the same name possible.
  try {
    const carried = await Promise.all(Array.from(files).map(
      (file) => file.text().then((text) => ({
        name: file.name,
        text: text,
      }))));
    render(JSON.parse(navigatorPack(carried)));
  } catch (err) {
    render({ refused: ['that file could not be read'] });
  } finally {
    show('busy', false);
  }
}

// A drop is the ordinary way in, so the page has to refuse the
// browser's own default of navigating to the dropped file.
const drop = el('drop');
['dragenter', 'dragover'].forEach((name) => {
  drop.addEventListener(name, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
});
['dragleave', 'drop'].forEach((name) => {
  drop.addEventListener(name, (e) => {
    e.preventDefault();
    drop.classList.remove('over');
  });
});
drop.addEventListener('drop', (e) => convert(e.dataTransfer.files));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

el('pick').addEventListener('change', (e) => convert(e.target.files));

el('copy').addEventListener('click', async () => {
  const field = el('packed');
  field.select();
  try {
    await navigator.clipboard.writeText(field.value);
    el('copy').textContent = 'Copied';
    setTimeout(() => { el('copy').textContent = 'Copy'; }, 1500);
  } catch (err) {
    // A browser that refuses the clipboard leaves the text selected,
    // which is one keystroke away from the same result.
  }
});

// The data file is built here rather than asked for, since there is
// nobody to ask.
el('download').addEventListener('click', () => {
  const slot = 2048;
  const padded = packed.length >= slot
    ? packed
    : packed + ' '.repeat(slot - packed.length);
  const blob = new Blob([JSON.stringify({ route: padded }) + '\n'],
    { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'data.json';
  link.click();
  URL.revokeObjectURL(url);
});

load();
