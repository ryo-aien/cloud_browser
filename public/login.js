document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: document.querySelector('#password').value }),
    });
    if (response.ok) location.assign('/');
    else document.querySelector('#error').textContent =
      (await response.json()).error || 'ログインに失敗しました';
  } catch {
    document.querySelector('#error').textContent = '接続できませんでした';
  }
});
