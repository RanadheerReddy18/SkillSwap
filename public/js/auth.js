'use strict';

// Login + sign-up pages
(function () {
  const $ = (id) => document.getElementById(id);
  const form = $('loginForm') || $('registerForm');
  const isRegister = form.id === 'registerForm';
  const emailRe = /^\S+@\S+\.\S+$/;

  // Already logged in? Go straight to the dashboard.
  if (API.token()) {
    API.req('/api/me').then(() => location.replace('dashboard.html')).catch(() => {});
  }

  const eye = document.querySelector('.eye');
  if (eye) {
    eye.addEventListener('click', () => {
      const input = $('password');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.setAttribute('aria-pressed', String(show));
      eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  }

  function fail(msg) {
    const box = $('err');
    box.textContent = msg;
    box.classList.remove('show');
    void box.offsetWidth; // restart the shake animation
    box.classList.add('show');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('err').classList.remove('show');
    const email = $('email').value.trim().toLowerCase();
    const password = $('password').value;
    let body;

    if (isRegister) {
      const name = $('name').value.trim();
      if (name.length < 2) return fail('Please enter your name');
      if (!emailRe.test(email)) return fail('Enter a valid email');
      if (password.length < 6) return fail('Password must be at least 6 characters');
      if (password !== $('confirm').value) return fail('Passwords do not match');
      body = { name, email, password };
    } else {
      if (!emailRe.test(email)) return fail('Enter a valid email');
      if (!password) return fail('Enter your password');
      body = { email, password };
    }

    const btn = form.querySelector('button[type="submit"]');
    btn.classList.add('loading');
    btn.disabled = true;
    try {
      const data = await API.req(isRegister ? '/api/register' : '/api/login', 'POST', body);
      API.setToken(data.token);
      toast(isRegister ? 'Account created!' : 'Welcome back!', 'success');
      setTimeout(() => location.replace('dashboard.html'), 600);
    } catch (err) {
      fail(err.message);
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  });
})();
