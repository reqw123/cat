/* ====================================================================
   card-fx：稀有度切換 / 技能演出 / 卡背資訊 / WebAudio 合成音效
   由 card-fx/apply_fx.py 注入每張卡片（連同 fx.css、#card-meta）；不要直接改卡片裡的副本。
   對外介面 window.cardFx：
     cast(opts)         技能演出（蓄力 → 爆發）
     cycleRarity(opts)  稀有度往下一階 SR → SSR → UR → LR → SR
     setRarity(r, opts) 直接指定
     toggleMute() / setMuted(bool) / isMuted()
   opts.sound === false 時該次不發聲（多卡合一時只讓一張卡發聲，避免十張疊在一起）。
   桌面掛件外殼（main.js）的全域快捷鍵、系統匣選單就是呼叫這幾個函式。
   單獨用瀏覽器打開時的按鍵：R 稀有度、S 技能、M 靜音；點一下卡片也會施放技能（雙擊＝翻面，不會誤觸）。
   ==================================================================== */
(function () {
  'use strict';
  if (window.cardFx) return;
  var card = document.getElementById('card');
  if (!card) return;
  var stage = document.querySelector('.stage') || document.body;
  var root = document.documentElement;
  var meta = {};
  try { meta = JSON.parse(document.getElementById('card-meta').textContent) || {}; } catch (e) { meta = {}; }

  var TIERS = ['SR', 'SSR', 'UR', 'LR'];
  var PREFIX = 'phantomCardFx:';
  var id = String(meta.id || document.title || 'card');
  function lsGet(k) { try { return localStorage.getItem(PREFIX + k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(PREFIX + k, v); } catch (e) { /* 無痕/被擋：只是不記住 */ } }
  var colors = (meta.colors && meta.colors.length >= 3) ? meta.colors : ['#8be9fd', '#bd93f9', '#ffffff'];
  root.style.setProperty('--fx-c1', colors[0]);
  root.style.setProperty('--fx-c2', colors[1]);
  root.style.setProperty('--fx-c3', colors[2]);

  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function mulberry(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  var reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ------------------------------------------------------------------ 特效層 */
  var faces = [];
  function makeFace(host) {
    if (!host) return;
    var L = document.createElement('div');
    L.className = 'fx-layer';
    L.innerHTML = '<div class="fx-stars"></div><div class="fx-prism"></div><div class="fx-shine"></div>' +
      '<canvas class="fx-canvas"></canvas><div class="fx-flash"></div><div class="fx-ring"></div><div class="fx-toast"></div>';
    host.appendChild(L);
    var f = {
      host: host, layer: L, cv: L.querySelector('canvas'), stars: L.querySelector('.fx-stars'),
      flash: L.querySelector('.fx-flash'), ring: L.querySelector('.fx-ring'),
      shine: L.querySelector('.fx-shine'), toast: L.querySelector('.fx-toast')
    };
    f.ctx = f.cv.getContext('2d');
    var rnd = mulberry(hash(id) + faces.length * 977);
    for (var i = 0; i < 72; i++) {
      var s = document.createElement('i');
      s.textContent = '✦';
      s.style.left = (rnd() * 96 + 1).toFixed(1) + '%';
      s.style.top = (rnd() * 94 + 2).toFixed(1) + '%';
      s.style.fontSize = (5 + rnd() * 9).toFixed(1) + 'px';
      s.style.setProperty('--d', (2.2 + rnd() * 3.2).toFixed(2) + 's');
      s.style.setProperty('--dl', (-rnd() * 5).toFixed(2) + 's');
      if (rnd() < 0.35) s.style.color = colors[2];
      f.stars.appendChild(s);
    }
    faces.push(f);
  }
  makeFace(card.querySelector('.card__inner'));
  makeFace(card.querySelector('.back__inner'));

  function toast(text) {
    faces.forEach(function (f) {
      f.toast.textContent = text;
      if (f.toast.animate) {
        f.toast.animate([{ opacity: 0, transform: 'translate(-50%,-6px)' }, { opacity: 1, transform: 'translate(-50%,0)', offset: 0.14 },
          { opacity: 1, transform: 'translate(-50%,0)', offset: 0.78 }, { opacity: 0, transform: 'translate(-50%,-4px)' }],
          { duration: 1500, easing: 'ease-out' });
      }
    });
  }

  /* ------------------------------------------------------------------ 音效（WebAudio 合成，不需要任何外部檔案） */
  var AC = window.AudioContext || window.webkitAudioContext;
  var actx = null, master = null, nbuf = null;
  function isMuted() { return lsGet('muted') === '1'; }
  function audio() {
    if (isMuted() || !AC) return null;
    if (!actx) {
      try {
        actx = new AC();
        master = actx.createGain(); master.gain.value = 0.34;
        var comp = actx.createDynamicsCompressor();
        master.connect(comp); comp.connect(actx.destination);
      } catch (e) { actx = null; return null; }
    }
    if (actx.state === 'suspended') { try { actx.resume(); } catch (e) { /* 需要使用者手勢 */ } }
    return actx;
  }
  function noiseBuffer() {
    if (nbuf) return nbuf;
    nbuf = actx.createBuffer(1, actx.sampleRate * 1.2, actx.sampleRate);
    var d = nbuf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return nbuf;
  }
  function tone(freq, t, dur, type, peak, slideTo) {
    var o = actx.createOscillator(), g = actx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.02, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(t, dur, ftype, f0, f1, peak, attack) {
    var s = actx.createBufferSource(); s.buffer = noiseBuffer();
    var f = actx.createBiquadFilter(); f.type = ftype;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    f.Q.value = ftype === 'bandpass' ? 1.4 : 0.7;
    var g = actx.createGain(); var a = attack || 0.02;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  }
  var SFX = {
    flip: function (t) { noise(t, 0.3, 'bandpass', 500, 2800, 0.55); tone(190, t, 0.2, 'sine', 0.22, 90); },
    rarity: function (t) {
      var n = { SR: 2, SSR: 3, UR: 4, LR: 5 }[rarity] || 3;
      var sc = [523.25, 659.25, 783.99, 1046.5, 1318.5];
      for (var i = 0; i < n; i++) { tone(sc[i], t + i * 0.075, 0.55, 'triangle', 0.2); tone(sc[i] * 2, t + i * 0.075, 0.4, 'sine', 0.06); }
      noise(t, 0.55, 'highpass', 6000, 9500, 0.05);
    },
    charge: function (t) {
      var o = actx.createOscillator(), f = actx.createBiquadFilter(), g = actx.createGain(), lfo = actx.createOscillator(), lg = actx.createGain();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(440, t + 0.75);
      f.type = 'lowpass'; f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(3200, t + 0.75);
      lfo.frequency.value = 14; lg.gain.value = 0.04; lfo.connect(lg); lg.connect(g.gain);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
      o.connect(f); f.connect(g); g.connect(master);
      o.start(t); lfo.start(t); o.stop(t + 0.85); lfo.stop(t + 0.85);
      noise(t, 0.75, 'lowpass', 200, 4200, 0.16, 0.5);
    },
    burst: function (t) {
      tone(170, t, 0.6, 'sine', 0.7, 36);
      tone(95, t, 0.9, 'sawtooth', 0.16, 48);
      noise(t, 0.5, 'lowpass', 5200, 260, 0.62, 0.008);
      for (var i = 0; i < 9; i++) tone(1800 + Math.random() * 4200, t + 0.03 + Math.random() * 0.4, 0.14, 'sine', 0.07);
    }
  };
  function sfx(name, opts) {
    if (opts && opts.sound === false) return;
    var c = audio(); if (!c) return;
    try { SFX[name](c.currentTime + 0.01); } catch (e) { /* 音效壞了不該影響卡片 */ }
  }

  /* ------------------------------------------------------------------ 稀有度 */
  var rarity = 'SSR';
  function applyRarity(r, opts) {
    if (TIERS.indexOf(r) < 0) r = 'SSR';
    rarity = r;
    document.body.setAttribute('data-rarity', r);
    var chips = document.querySelectorAll('.chip--ssr');
    for (var i = 0; i < chips.length; i++) chips[i].textContent = r;
    var slots = document.querySelectorAll('[data-fx-rarity]');
    for (var j = 0; j < slots.length; j++) slots[j].textContent = r;
    if (opts && opts.save !== false) lsSet(id + ':rarity', r);
    if (opts && opts.fx) {
      faces.forEach(function (f) {
        if (f.shine.animate) f.shine.animate([{ opacity: 0.9, transform: 'translateX(-130%)' }, { opacity: 0.9, transform: 'translateX(130%)' }], { duration: 750, easing: 'ease-in-out' });
      });
      toast('✦ ' + r);
      sfx('rarity', opts);
    }
  }
  function cycleRarity(opts) {
    var o = opts || {};
    applyRarity(TIERS[(TIERS.indexOf(rarity) + 1) % TIERS.length], { fx: true, sound: o.sound });
  }
  var saved = lsGet(id + ':rarity');
  applyRarity(TIERS.indexOf(saved) >= 0 ? saved : (TIERS.indexOf(meta.rarity) >= 0 ? meta.rarity : 'SSR'), { save: false });

  /* ------------------------------------------------------------------ 靜音 */
  function setMuted(m) {
    lsSet('muted', m ? '1' : '0');
    toast(m ? '🔇 音效靜音' : '🔊 音效開啟');
    if (!m) sfx('rarity');
  }
  function toggleMute() { setMuted(!isMuted()); }

  /* ------------------------------------------------------------------ 卡背資訊 */
  (function buildInfo() {
    var back = card.querySelector('.back__inner');
    if (!back || !meta.stats) return;
    var info = document.createElement('div');
    info.className = 'back__info';
    var head = '<div class="bi-head"><span>NO. <b>' + (meta.no || '000') + '</b></span>' +
      '<span>收藏 <b>' + (meta.date || '') + '</b></span></div>';
    var stats = '<div class="bi-stats">';
    ['ATK', 'DEF', 'SPD', 'LUK'].concat(Object.keys(meta.stats)).filter(function (k, i, a) { return a.indexOf(k) === i && meta.stats[k] != null; }).forEach(function (k) {
      var v = clamp(+meta.stats[k] || 0, 0, 100);
      stats += '<div class="bi-stat"><span>' + k + '</span><div class="bi-bar"><i style="width:' + v + '%"></i></div><em>' + v + '</em></div>';
    });
    stats += '</div>';
    var date = '';
    info.innerHTML = head + stats + date;
    var anchor = back.querySelector('.back__id');
    // 六狗系列原本的卡背編號「NO. 03 / 06」是系列內編號，會跟這裡的全系列編號打架 → 改成只顯示名稱
    if (anchor && /NO\.\s*\d+\s*\/\s*\d+/.test(anchor.textContent) && meta.name) anchor.textContent = meta.name;
    if (anchor) back.insertBefore(info, anchor); else back.appendChild(info);
    back.classList.add('has-fx-info');
  })();

  /* ------------------------------------------------------------------ 技能演出 */
  var casting = false;
  var CHARGE = 750, BURST_DUR = 950;
  function cast(opts) {
    if (casting) return;
    casting = true;
    var o = opts || {};
    var sizeBase = faces[0] ? faces[0] : null;
    var W = sizeBase ? sizeBase.host.clientWidth : card.clientWidth;
    var H = sizeBase ? sizeBase.host.clientHeight : card.clientHeight;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    faces.forEach(function (f) {
      f.cv.width = Math.round(W * dpr); f.cv.height = Math.round(H * dpr);
      f.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    var cx = W / 2, cy = H * 0.46;
    var parts = [];
    var cols = [colors[0], colors[1], colors[2], '#ffffff'];
    var t0 = performance.now(), last = t0, burst = false, spawnAcc = 0;
    document.body.classList.add('fx-charging');
    sfx('charge', o);
    toast('⚡ ' + (meta.skillName || 'SKILL'));

    function doBurst() {
      burst = true;
      sfx('burst', o);
      document.body.classList.remove('fx-charging');
      document.body.classList.add('fx-burst');
      parts.length = 0;
      for (var i = 0; i < 130; i++) {
        var a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 9;
        parts.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, decay: 0.012 + Math.random() * 0.02,
          size: 1.2 + Math.random() * 3, color: cols[i % cols.length], fr: 0.965, mode: 'out' });
      }
      faces.forEach(function (f) {
        if (f.flash.animate) f.flash.animate([{ opacity: 0 }, { opacity: 1, offset: 0.16 }, { opacity: 0 }], { duration: 560, easing: 'ease-out' });
        if (f.ring.animate) {
          f.ring.animate([{ transform: 'translate(-50%,-50%) scale(0)', opacity: 0.95 }, { transform: 'translate(-50%,-50%) scale(30)', opacity: 0 }], { duration: 850, easing: 'cubic-bezier(.1,.7,.2,1)' });
          f.ring.animate([{ transform: 'translate(-50%,-50%) scale(0)', opacity: 0.7 }, { transform: 'translate(-50%,-50%) scale(20)', opacity: 0 }], { duration: 700, delay: 130, easing: 'cubic-bezier(.1,.7,.2,1)', fill: 'backwards' });
        }
      });
      // 殘影加倍：把場景裡的殘影層各複製一份，往兩側飄開再淡出
      var srcs = document.querySelectorAll('.ghost--warn, .ghost--past, .echo');
      Array.prototype.forEach.call(srcs, function (el, k) {
        if (!el.animate || !el.parentNode || el.classList.contains('fx-clone')) return;
        var cl = el.cloneNode(true);
        cl.removeAttribute('id');
        cl.classList.add('fx-clone');
        var base = getComputedStyle(el).transform; if (base === 'none') base = '';
        var dir = k % 2 ? 1 : -1;
        el.parentNode.insertBefore(cl, el.nextSibling);
        var an = cl.animate([
          { transform: base + ' translate(0%,0%) scale(1)', opacity: 0 },
          { transform: base + ' translate(' + (dir * 9) + '%,' + (-4 * dir) + '%) scale(1.06)', opacity: 0.85, offset: 0.25 },
          { transform: base + ' translate(' + (dir * 30) + '%,' + (10 * dir) + '%) scale(1.16)', opacity: 0 }
        ], { duration: 1150, easing: 'ease-out' });
        an.onfinish = function () { if (cl.parentNode) cl.parentNode.removeChild(cl); };
      });
    }

    function frame(now) {
      var dt = Math.min(48, now - last); last = now;
      var t = now - t0, shx = 0, shy = 0, aura = 0, scale = 1;
      if (t < CHARGE) {
        var k = t / CHARGE, e = k * k;
        aura = e; scale = 1 - 0.035 * e;
        var amp = 0.3 + 1.7 * e; shx = (Math.random() - 0.5) * amp; shy = (Math.random() - 0.5) * amp;
        spawnAcc += dt * (0.09 + 0.16 * k);
        while (spawnAcc >= 1) {
          spawnAcc -= 1;
          var a = Math.random() * Math.PI * 2, r = Math.max(W, H) * (0.55 + Math.random() * 0.2);
          parts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * 0.85, life: 1, decay: 0.006, size: 1 + Math.random() * 2.4,
            color: cols[(Math.random() * cols.length) | 0], mode: 'in', sw: (Math.random() - 0.5) * 0.06 });
        }
      } else {
        if (!burst) doBurst();
        var b = clamp((t - CHARGE) / BURST_DUR, 0, 1);
        aura = 1 - b;
        var amp2 = 10 * Math.pow(1 - b, 2); shx = (Math.random() - 0.5) * amp2; shy = (Math.random() - 0.5) * amp2;
        scale = 1 + 0.07 * Math.pow(1 - b, 2) * Math.cos(b * 13);
      }
      root.style.setProperty('--fx-aura', aura.toFixed(3));
      root.style.setProperty('--fx-scale', scale.toFixed(4));
      root.style.setProperty('--fx-shx', shx.toFixed(2) + 'px');
      root.style.setProperty('--fx-shy', shy.toFixed(2) + 'px');

      // 粒子
      for (var i = parts.length - 1; i >= 0; i--) {
        var p = parts[i];
        if (p.mode === 'in') {
          var dx = cx - p.x, dy = cy - p.y;
          p.x += dx * 0.075 - dy * p.sw; p.y += dy * 0.075 + dx * p.sw;
          if (dx * dx + dy * dy < 100) { parts.splice(i, 1); continue; }
        } else {
          p.x += p.vx; p.y += p.vy; p.vx *= p.fr; p.vy *= p.fr; p.life -= p.decay;
          if (p.life <= 0) { parts.splice(i, 1); continue; }
        }
      }
      faces.forEach(function (f) {
        var c = f.ctx;
        c.clearRect(0, 0, W, H);
        c.globalCompositeOperation = 'lighter';
        if (!burst) {                      // 中央能量核心
          var kk = clamp(t / CHARGE, 0, 1), rr = 6 + 46 * kk * kk;
          var gr = c.createRadialGradient(cx, cy, 0, cx, cy, rr);
          gr.addColorStop(0, 'rgba(255,255,255,' + (0.35 + 0.6 * kk) + ')'); gr.addColorStop(0.4, colors[1]); gr.addColorStop(1, 'rgba(0,0,0,0)');
          c.globalAlpha = 0.25 + 0.6 * kk; c.fillStyle = gr; c.beginPath(); c.arc(cx, cy, rr, 0, 6.2832); c.fill();
        }
        for (var j = 0; j < parts.length; j++) {
          var q = parts[j];
          c.globalAlpha = q.mode === 'in' ? 0.85 : clamp(q.life, 0, 1);
          c.fillStyle = q.color;
          c.beginPath(); c.arc(q.x, q.y, q.size * (q.mode === 'in' ? 1 : (0.5 + q.life * 0.7)), 0, 6.2832); c.fill();
        }
        c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
      });

      if (t < CHARGE + BURST_DUR + 250) { requestAnimationFrame(frame); return; }
      // 收尾
      root.style.removeProperty('--fx-aura'); root.style.removeProperty('--fx-scale');
      root.style.removeProperty('--fx-shx'); root.style.removeProperty('--fx-shy');
      document.body.classList.remove('fx-charging', 'fx-burst');
      faces.forEach(function (f) { f.ctx.clearRect(0, 0, W, H); });
      casting = false;
    }
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------ 觸發：點擊 / 按鍵 */
  var down = null, clickTimer = null;
  card.addEventListener('pointerdown', function (e) { if (e.button === 0) down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  window.addEventListener('pointerup', function (e) {
    if (!down) return;
    var d = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t;
    down = null;
    if (e.button !== 0 || d > 5 || dt > 350) return;          // 拖曳旋轉不算點擊
    clearTimeout(clickTimer);
    clickTimer = setTimeout(function () { cast(); }, 260);    // 等一下：如果是雙擊（翻面）就取消
  });
  card.addEventListener('dblclick', function () { clearTimeout(clickTimer); sfx('flip'); });
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'r') cycleRarity(); else if (k === 's') cast(); else if (k === 'm') toggleMute();
  });

  window.cardFx = {
    cast: cast, cycleRarity: cycleRarity, setRarity: function (r, o) { applyRarity(r, { fx: true, sound: o && o.sound }); },
    rarity: function () { return rarity; }, toggleMute: toggleMute, setMuted: setMuted, isMuted: isMuted, sfx: sfx, meta: meta,
    audioState: function () { return actx ? actx.state : 'none'; }
  };
})();
