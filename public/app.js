const image = document.querySelector('#screen');
const address = document.querySelector('#address');
const status = document.querySelector('#status');
let ws;
let viewport = { width: 1280, height: 800 };
let attempts = 0;
let reconnectTimer;
let connected = false;
let lastError = '';

function message(text) { status.textContent = text; }
function send(payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function connect() {
  lastError = '';
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(protocol + '//' + location.host + '/ws');
  message('Cloud Runのブラウザに接続中…');
  ws.addEventListener('open', () => { connected = true; attempts = 0; message('接続しました。URLを入力してください。'); });
  ws.addEventListener('message', (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (data.type === 'ready') {
      viewport = data.viewport;
      message('接続しました。URLを入力してください。');
    } else if (data.type === 'frame') {
      image.src = 'data:image/jpeg;base64,' + data.jpg;
    } else if (data.type === 'location') {
      address.value = data.url === 'about:blank' ? '' : data.url;
    } else if (data.type === 'error') {
      lastError = data.message;
      message(data.message);
    }
  });
  ws.addEventListener('close', (e) => {
    connected = false;
    if (e.code === 1008 || e.code === 1013) {
      message('接続できません。ログイン状態または接続数を確認してください。');
      return;
    }
    attempts += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5));
    message('接続が切れました（code ' + e.code + (lastError ? ': ' + lastError : '') + '）。' +
      Math.round(delay / 1000) + '秒後に再接続します。');
    reconnectTimer = setTimeout(connect, delay);
  });
  ws.addEventListener('error', () => message('WebSocket接続でエラーが発生しました'));
}
document.querySelector('#nav-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!connected) return;
  send({ type: 'navigate', url: address.value.trim() });
  address.blur();
  image.focus();
});
for (const type of ['back', 'forward', 'reload']) {
  document.querySelector('#' + type).addEventListener('click', () => send({ type }));
}
document.querySelector('#logout').addEventListener('click', async () => {
  clearTimeout(reconnectTimer);
  ws?.close(1000);
  await fetch('/api/logout', { method: 'POST' });
  location.assign('/login');
});
function coords(e) {
  const rect = image.getBoundingClientRect();
  if (!rect.width || !rect.height) return { x: 0, y: 0 };
  const imageAspect = viewport.width / viewport.height;
  const boxAspect = rect.width / rect.height;
  let width = rect.width, height = rect.height, left = rect.left, top = rect.top;
  if (boxAspect > imageAspect) {
    width = height * imageAspect;
    left += (rect.width - width) / 2;
  } else {
    height = width / imageAspect;
    top += (rect.height - height) / 2;
  }
  return {
    x: Math.round((e.clientX - left) * viewport.width / width),
    y: Math.round((e.clientY - top) * viewport.height / height),
  };
}
image.addEventListener('click', (e) => {
  image.focus();
  const p = coords(e);
  send({ type: 'click', ...p, double: e.detail > 1 });
});
image.addEventListener('contextmenu', (e) => e.preventDefault());
image.addEventListener('wheel', (e) => {
  e.preventDefault();
  send({ type: 'scroll', dx: e.deltaX, dy: e.deltaY });
}, { passive: false });
image.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length === 1) send({ type: 'text', text: e.key });
  else if (e.key !== 'Process' && e.key !== 'Unidentified') send({ type: 'key', key: e.key });
  e.preventDefault();
});
image.addEventListener('compositionend', (e) => {
  if (e.data) send({ type: 'text', text: e.data });
});
connect();
