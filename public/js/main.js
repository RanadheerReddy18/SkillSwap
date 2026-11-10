'use strict';

// Landing page
(function () {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Loader (hideLoader comes from api.js) ----------
  window.addEventListener('load', () => setTimeout(hideLoader, 500));
  setTimeout(hideLoader, 3000); // safety: never stay stuck on the loader

  // ---------- Mobile menu ----------
  const toggle = document.getElementById('navToggle');
  const links = document.getElementById('navLinks');
  if (toggle && links) {
    const setOpen = (open) => {
      links.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => setOpen(!links.classList.contains('open')));
    links.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => setOpen(false)));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  }

  // ---------- If already logged in, show a Dashboard button ----------
  (async () => {
    if (!API.token()) return;
    try {
      const me = await API.req('/api/me');
      const box = document.getElementById('nav-auth');
      const a = document.createElement('a');
      a.href = 'dashboard.html';
      a.className = 'btn';
      a.textContent = 'Hi ' + me.name.split(' ')[0] + ' - Dashboard';
      box.replaceChildren(a);
      document.querySelectorAll('.cta-start').forEach((el) => { el.href = 'dashboard.html'; el.textContent = 'Go to Dashboard'; });
    } catch { API.clear(); }
  })();

  // ---------- Typing effect ----------
  const words = ['Java', 'UI/UX Design', 'Photography', 'Guitar', 'Python', 'Video Editing'];
  const typedEl = document.querySelector('.typed');
  if (typedEl && reduceMotion) {
    typedEl.textContent = words[0];
  } else if (typedEl) {
    let wi = 0, ci = 0, deleting = false;
    const type = () => {
      const w = words[wi];
      ci += deleting ? -1 : 1;
      typedEl.textContent = w.slice(0, ci);
      let delay = deleting ? 50 : 110;
      if (!deleting && ci === w.length) { deleting = true; delay = 1400; }
      else if (deleting && ci === 0) { deleting = false; wi = (wi + 1) % words.length; delay = 400; }
      setTimeout(type, delay);
    };
    type();
  }

  // ---------- Scroll reveal ----------
  const revealEls = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealEls.forEach((el) => el.classList.add('show'));
  } else {
    const revealIO = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('show'); revealIO.unobserve(e.target); } });
    }, { threshold: 0.15 });
    revealEls.forEach((el, i) => { el.style.transitionDelay = (i % 6) * 0.08 + 's'; revealIO.observe(el); });
  }

  // ---------- Live numbers (real data from the server) ----------
  const statsBox = document.getElementById('stats');
  const statEls = document.querySelectorAll('[data-stat]');
  if (statsBox) {
    const statsReady = API.req('/api/stats')
      .then((s) => { statEls.forEach((el) => { el.dataset.count = s[el.dataset.stat] || 0; }); return true; })
      .catch(() => { statsBox.hidden = true; return false; });

    const countUp = (el) => {
      const target = Number(el.dataset.count) || 0;
      if (reduceMotion || target === 0) { el.textContent = target.toLocaleString(); return; }
      let n = 0;
      const step = Math.ceil(target / 60);
      const t = setInterval(() => {
        n = Math.min(n + step, target);
        el.textContent = n.toLocaleString();
        if (n >= target) clearInterval(t);
      }, 25);
    };
    const run = (el) => statsReady.then((ok) => { if (ok) countUp(el); });

    if ('IntersectionObserver' in window) {
      const counterIO = new IntersectionObserver((entries) => {
        entries.forEach((e) => { if (e.isIntersecting) { run(e.target); counterIO.unobserve(e.target); } });
      }, { threshold: 0.5 });
      statEls.forEach((el) => counterIO.observe(el));
    } else {
      statEls.forEach(run);
    }
  }

  // ---------- Slider ----------
  (function () {
    const track = document.querySelector('.slides');
    if (!track) return;
    const slides = [...track.children];
    const total = slides.length;
    const dotsBox = document.querySelector('.dots');
    const slider = document.querySelector('.slider');
    let idx = 0, timer = null, paused = false;

    slides.forEach((_, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', 'Show swap ' + (i + 1) + ' of ' + total);
      b.addEventListener('click', () => go(i));
      dotsBox.appendChild(b);
    });

    function restart() {
      clearInterval(timer);
      if (!reduceMotion && !paused) timer = setInterval(() => go(idx + 1), 4500);
    }
    function go(i) {
      idx = (i + total) % total;
      track.style.transform = 'translateX(-' + idx * 100 + '%)';
      slides.forEach((s, k) => s.setAttribute('aria-hidden', String(k !== idx)));
      [...dotsBox.children].forEach((d, k) => {
        d.classList.toggle('active', k === idx);
        d.setAttribute('aria-current', String(k === idx));
      });
      restart();
    }
    document.querySelector('.slider-btn.prev').addEventListener('click', () => go(idx - 1));
    document.querySelector('.slider-btn.next').addEventListener('click', () => go(idx + 1));
    // do not rotate while someone is reading or using the controls
    const pause = (p) => { paused = p; restart(); };
    slider.addEventListener('mouseenter', () => pause(true));
    slider.addEventListener('mouseleave', () => pause(false));
    slider.addEventListener('focusin', () => pause(true));
    slider.addEventListener('focusout', () => pause(false));
    go(0);
  })();
})();
