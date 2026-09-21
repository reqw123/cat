// 匯出編碼器（跑在隱藏的渲染程序裡，見 encoder.html）。
// 收 main process 的三種訊息：cx-init（格式與尺寸）→ cx-frame × N（JPEG／PNG 位元組，依序）→ cx-finish，
// 最後回 cx-done：{ ok:true, bytes } 或 { ok:false, error }。
//   webm：WebCodecs VideoEncoder（VP9，不支援就退到 VP8）＋自己寫的最小 WebM（EBML）封裝。
//         不用 MediaRecorder：它只能即時錄、時間戳是牆上時鐘、產出的檔案沒有長度資訊；
//         這裡每格時間戳精準（固定 fps）、編碼比即時快、檔案有長度與 Cues 可拖曳。
//   gif ：gifquant.js——每格 255 色本機色盤（k-means，逐格暖開機）＋蛇形 Floyd–Steinberg 誤差擴散＋只重畫變動的像素＋ LZW；收一格編一格。
'use strict';

(function () {
  var api = window.cardExportEnc;
  var cfg = null;
  var state = null;
  var queue = Promise.resolve();

  function fail(e) {
    try { if (state && state.encoder && state.encoder.state !== 'closed') state.encoder.close(); } catch (x) { /* 已關閉 */ }
    api.done({ ok: false, error: String((e && e.stack) || e) });
  }

  api.onInit(function (c) {
    cfg = c;
    state = { chunks: [] }; // webm：編碼好的區塊；gif：state.gif（串流編碼器，見 frameGif）
    queue = queue.then(function () { return cfg.format === 'webm' ? initWebm() : null; }).catch(fail);
  });
  api.onFrame(function (index, bytes) {
    queue = queue.then(function () { return cfg.format === 'webm' ? frameWebm(index, bytes) : frameGif(index, bytes); }).catch(fail);
  });
  api.onFinish(function () {
    queue = queue.then(function () { return cfg.format === 'webm' ? finishWebm() : finishGif(); }).catch(fail);
  });
  api.ready();

  function decode(bytes) { // PNG（GIF 用，無損）或 JPEG（影片用）：看檔頭判斷
    var png = bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
    return createImageBitmap(new Blob([bytes], { type: png ? 'image/png' : 'image/jpeg' }));
  }

  /* ==================================================================== WebM */
  var KEY_EVERY = 30;

  function initWebm() {
    var codecs = [['vp09.00.41.08', 'V_VP9'], ['vp8', 'V_VP8']];
    var w = cfg.width, h = cfg.height;
    return codecs.reduce(function (p, c) {
      return p.then(function (found) {
        if (found) return found;
        return VideoEncoder.isConfigSupported({ codec: c[0], width: w, height: h, bitrate: cfg.bitrate, framerate: cfg.fps })
          .then(function (r) { return r && r.supported ? c : null; }).catch(function () { return null; });
      });
    }, Promise.resolve(null)).then(function (c) {
      if (!c) throw new Error('這台電腦的 Chromium 沒有可用的 VP9/VP8 編碼器');
      state.codecId = c[1];
      state.encoder = new VideoEncoder({
        output: function (chunk) {
          var d = new Uint8Array(chunk.byteLength);
          chunk.copyTo(d);
          state.chunks.push({ data: d, key: chunk.type === 'key', ms: Math.round(chunk.timestamp / 1000) });
        },
        error: fail,
      });
      state.encoder.configure({ codec: c[0], width: w, height: h, bitrate: cfg.bitrate, framerate: cfg.fps, latencyMode: 'quality' });
    });
  }

  function frameWebm(index, bytes) {
    return decode(bytes).then(function (bmp) {
      var vf = new VideoFrame(bmp, { timestamp: Math.round(index * 1e6 / cfg.fps), duration: Math.round(1e6 / cfg.fps) });
      state.encoder.encode(vf, { keyFrame: index % KEY_EVERY === 0 });
      vf.close();
      bmp.close();
      if (state.encoder.encodeQueueSize > 6) {
        return new Promise(function (r) { state.encoder.addEventListener('dequeue', function () { r(); }, { once: true }); });
      }
    });
  }

  function finishWebm() {
    return state.encoder.flush().then(function () {
      state.encoder.close();
      var bytes = muxWebm(state.chunks, state.codecId, cfg.width, cfg.height, cfg.fps, cfg.frames);
      api.done({ ok: true, bytes: bytes });
    });
  }

  // ---- 最小 EBML/WebM 寫入器（大小一律用 8 位元組 vint，簡單、合法）
  function concat(parts) {
    var n = 0, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
    return out;
  }
  function vsize(n) {
    var b = new Uint8Array(8);
    b[0] = 0x01;
    for (var i = 7; i >= 1; i--) { b[i] = n % 256; n = Math.floor(n / 256); }
    return b;
  }
  function el(id, payload) { // id: 位元組陣列；payload: Uint8Array 或其陣列
    var p = Array.isArray(payload) ? concat(payload) : payload;
    return concat([Uint8Array.from(id), vsize(p.length), p]);
  }
  function uintBytes(n) {
    var bytes = [];
    do { bytes.unshift(n % 256); n = Math.floor(n / 256); } while (n > 0);
    return Uint8Array.from(bytes);
  }
  function uintEl(id, n) { return el(id, uintBytes(n)); }
  function strEl(id, s) { return el(id, Uint8Array.from(Array.prototype.map.call(s, function (c) { return c.charCodeAt(0) & 255; }))); }
  function f64El(id, v) {
    var b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, false);
    return el(id, b);
  }

  function muxWebm(chunks, codecId, w, h, fps, frames) {
    var header = el([0x1A, 0x45, 0xDF, 0xA3], [
      uintEl([0x42, 0x86], 1), uintEl([0x42, 0xF7], 1), uintEl([0x42, 0xF2], 4), uintEl([0x42, 0xF3], 8),
      strEl([0x42, 0x82], 'webm'), uintEl([0x42, 0x87], 4), uintEl([0x42, 0x85], 2),
    ]);
    var durationMs = frames * 1000 / fps;
    var info = el([0x15, 0x49, 0xA9, 0x66], [
      uintEl([0x2A, 0xD7, 0xB1], 1000000),
      strEl([0x4D, 0x80], 'card-export'), strEl([0x57, 0x41], 'card-export'),
      f64El([0x44, 0x89], durationMs),
    ]);
    var tracks = el([0x16, 0x54, 0xAE, 0x6B], [
      el([0xAE], [
        uintEl([0xD7], 1), uintEl([0x73, 0xC5], 1), uintEl([0x83], 1), uintEl([0x9C], 0),
        strEl([0x86], codecId), uintEl([0x23, 0xE3, 0x83], Math.round(1e9 / fps)),
        el([0xE0], [uintEl([0xB0], w), uintEl([0xBA], h)]),
      ]),
    ]);

    // 每個關鍵格開一個 Cluster
    var clusters = [], cur = null, i;
    for (i = 0; i < chunks.length; i++) {
      var c = chunks[i];
      if (!cur || c.key) { cur = { ms: c.ms, blocks: [] }; clusters.push(cur); }
      var rel = c.ms - cur.ms;
      var head = Uint8Array.from([0x81, (rel >> 8) & 255, rel & 255, c.key ? 0x80 : 0x00]);
      cur.blocks.push(el([0xA3], [head, c.data]));
    }
    var segParts = [info, tracks];
    var pos = info.length + tracks.length;
    var cues = [];
    for (i = 0; i < clusters.length; i++) {
      var cl = el([0x1F, 0x43, 0xB6, 0x75], [uintEl([0xE7], clusters[i].ms)].concat(clusters[i].blocks));
      cues.push(el([0xBB], [uintEl([0xB3], clusters[i].ms), el([0xB7], [uintEl([0xF7], 1), uintEl([0xF1], pos)])]));
      segParts.push(cl);
      pos += cl.length;
    }
    segParts.push(el([0x1C, 0x53, 0xBB, 0x6B], cues));
    return concat([header, el([0x18, 0x53, 0x80, 0x67], segParts)]);
  }

  /* ==================================================================== GIF */
  // 串流編碼：每收到一格就量化＋寫入（不再等所有格到齊，也不用把整段畫面存在記憶體裡）。細節見 gifquant.js。
  function frameGif(index, bytes) {
    return decode(bytes).then(function (bmp) {
      var cv = new OffscreenCanvas(bmp.width, bmp.height);
      var ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      var w = bmp.width, h = bmp.height;
      bmp.close();
      if (!state.gif) {
        state.gif = window.GifQuant.createEncoder(w, h, {
          delayCs: Math.max(2, Math.round(100 / cfg.fps)),
          strength: 0.7, eps: 1, warmIters: 5,
          onFrame: function (n) { api.progress(n); },
        });
      }
      state.gif.addFrame(ctx.getImageData(0, 0, w, h).data);
    });
  }

  function finishGif() {
    if (!state.gif) throw new Error('沒有收到任何畫面');
    api.done({ ok: true, bytes: state.gif.finish() });
  }
})();
