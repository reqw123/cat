// GIF 量化＋編碼（encoder.js 在隱藏視窗裡用；也能在 Node 直接 require 做離線比對，見檔尾 module.exports）。
//
// 舊做法（一份全域 255 色＋4×4 Bayer 抖動）的問題：卡片有大片紫／青漸層與暗部，一份色盤要同時服務正面、背面與所有角度，
// 色不夠用就出現一圈一圈的色帶（banding），Bayer 抖動再把它打成格紋雜訊；量化前的畫面又是 JPEG q92（有區塊雜訊，量化後還會逐格閃）。
// 新做法（實測同一組 75 格，對無損原圖：SSIM 0.84→0.93～0.96、PSNR 32.5→36 dB，漸層從色帶變平滑）：
//   1. 每一格用自己的 255 色本機色盤（另 1 個索引留給透明）。色盤用 6 位元直方圖＋加權 RGB（R3:G4:B2）中位切割＋k-means 修正；
//      第二格起以「上一格的色盤」暖開機再跑幾輪 k-means（死掉的群心改放到誤差最大的顏色），色盤逐格平滑演變，不會忽然跳色。
//   2. 蛇形 Floyd–Steinberg 誤差擴散（強度 0.7）：漸層平滑、細節保留；最近色用 6 位元格子快取（需要時才算）。
//   3. 只重畫「跟上一格已顯示的內容相比有變化」的像素（每個像素記住它上次顯示的原色，差 ≤ 2 階視為沒變）：沒變的設成透明索引，
//      只存變動的最小矩形——多卡版面／時鐘轉圈的靜止背景幾乎不佔容量，也不會逐格閃色。
'use strict';

(function (root) {
  var HB = 6, HS = 8 - HB, HN = 1 << (HB * 3), HM = (1 << HB) - 1;
  var WR = 3, WG = 4, WB = 2;
  var NCOLORS = 255; // 索引 255 保留給「透明（沿用上一格）」
  var TRANS = 255;

  /* ------------------------------------------------------------ 色盤 */
  // frames：RGBA 陣列（Uint8ClampedArray）的清單；opts.init＝上一格的群心（{r,g,b} Float64Array），有的話跳過中位切割、直接暖開機。
  function buildPalette(frames, opts) {
    opts = opts || {};
    var cnt = new Uint32Array(HN);
    var sr = new Float64Array(HN), sg = new Float64Array(HN), sb = new Float64Array(HN);
    var f, p, d, k, i, j, c;
    for (f = 0; f < frames.length; f++) {
      d = frames[f];
      for (p = 0; p < d.length; p += 4) {
        k = ((d[p] >> HS) << (2 * HB)) | ((d[p + 1] >> HS) << HB) | (d[p + 2] >> HS);
        cnt[k]++; sr[k] += d[p]; sg[k] += d[p + 1]; sb[k] += d[p + 2];
      }
    }
    var m = 0;
    for (i = 0; i < HN; i++) if (cnt[i]) m++;
    var C = new Float64Array(m), R = new Float32Array(m), G = new Float32Array(m), B = new Float32Array(m), K = new Int32Array(m);
    m = 0;
    for (i = 0; i < HN; i++) {
      if (!cnt[i]) continue;
      C[m] = cnt[i]; R[m] = sr[i] / cnt[i]; G[m] = sg[i] / cnt[i]; B[m] = sb[i] / cnt[i]; K[m] = i; m++;
    }

    var cr, cg, cb, used, iters;
    var init = opts.init;
    // 只有「上一格是完整 255 色」才暖開機：上一格如果只有少數顏色（例如只有一小塊變動），拿它當起點會把下一格卡在很少的色數上
    if (init && init.r && init.r.length === NCOLORS) {
      used = init.r.length; iters = opts.warmIters == null ? 3 : opts.warmIters;
      cr = Float64Array.from(init.r); cg = Float64Array.from(init.g); cb = Float64Array.from(init.b);
    } else {
      iters = opts.kmeansIters == null ? 4 : opts.kmeansIters;
      // ---- 中位切割（挑加權誤差平方和最大的盒子）
      var boxStats = function (idx) {
        var n = 0, mr = 0, mg = 0, mb = 0, jj, w;
        for (jj = 0; jj < idx.length; jj++) { w = C[idx[jj]]; n += w; mr += R[idx[jj]] * w; mg += G[idx[jj]] * w; mb += B[idx[jj]] * w; }
        mr /= n; mg /= n; mb /= n;
        var vr = 0, vg = 0, vb = 0, dr, dg, db;
        for (jj = 0; jj < idx.length; jj++) {
          w = C[idx[jj]]; dr = R[idx[jj]] - mr; dg = G[idx[jj]] - mg; db = B[idx[jj]] - mb;
          vr += w * dr * dr; vg += w * dg * dg; vb += w * db * db;
        }
        vr *= WR; vg *= WG; vb *= WB;
        var axis = 0, top = vr;
        if (vg > top) { axis = 1; top = vg; }
        if (vb > top) { axis = 2; top = vb; }
        return { idx: idx, n: n, axis: axis, sse: idx.length > 1 ? vr + vg + vb : -1 };
      };
      var all = new Int32Array(m);
      for (i = 0; i < m; i++) all[i] = i;
      var boxes = [boxStats(all)];
      while (boxes.length < NCOLORS) {
        var bi = -1, best = 0;
        for (i = 0; i < boxes.length; i++) if (boxes[i].sse > best) { best = boxes[i].sse; bi = i; }
        if (bi < 0) break;
        var b = boxes[bi], ch = b.axis === 0 ? R : (b.axis === 1 ? G : B);
        var sorted = Array.prototype.slice.call(b.idx).sort(function (x, y) { return ch[x] - ch[y]; });
        var acc = 0, cut = 1;
        for (i = 0; i < sorted.length - 1; i++) { acc += C[sorted[i]]; cut = i + 1; if (acc * 2 >= b.n) break; }
        boxes.splice(bi, 1, boxStats(Int32Array.from(sorted.slice(0, cut))), boxStats(Int32Array.from(sorted.slice(cut))));
      }
      used = boxes.length;
      cr = new Float64Array(used); cg = new Float64Array(used); cb = new Float64Array(used);
      boxes.forEach(function (bx, cc) {
        var n = 0, a = 0, g = 0, l = 0, jj, w;
        for (jj = 0; jj < bx.idx.length; jj++) { w = C[bx.idx[jj]]; n += w; a += R[bx.idx[jj]] * w; g += G[bx.idx[jj]] * w; l += B[bx.idx[jj]] * w; }
        cr[cc] = a / n; cg[cc] = g / n; cb[cc] = l / n;
      });
    }

    // ---- k-means（Lloyd）。asg[j]＝第 j 個顏色格最後被分到的群
    var it, bestC, bestD, dr, dg, db, dd;
    var nr = new Float64Array(used), ng = new Float64Array(used), nb = new Float64Array(used), nn = new Float64Array(used);
    var asg = new Int16Array(m), err = new Float64Array(m);
    var total = iters + 1; // 多一輪只分配、不移動群心（讓 asg 對應最終色盤）
    for (it = 0; it < total; it++) {
      nr.fill(0); ng.fill(0); nb.fill(0); nn.fill(0);
      for (j = 0; j < m; j++) {
        bestD = 1e18; bestC = 0;
        for (c = 0; c < used; c++) {
          dr = R[j] - cr[c]; dg = G[j] - cg[c]; db = B[j] - cb[c];
          dd = WR * dr * dr + WG * dg * dg + WB * db * db;
          if (dd < bestD) { bestD = dd; bestC = c; }
        }
        asg[j] = bestC; err[j] = bestD * C[j];
        nr[bestC] += R[j] * C[j]; ng[bestC] += G[j] * C[j]; nb[bestC] += B[j] * C[j]; nn[bestC] += C[j];
      }
      if (it === total - 1) break;
      for (c = 0; c < used; c++) {
        if (nn[c] > 0) { cr[c] = nr[c] / nn[c]; cg[c] = ng[c] / nn[c]; cb[c] = nb[c] / nn[c]; }
        else { // 死群：改放到目前誤差最大的顏色上
          var wj = 0, we = -1;
          for (j = 0; j < m; j++) if (err[j] > we) { we = err[j]; wj = j; }
          cr[c] = R[wj]; cg[c] = G[wj]; cb[c] = B[wj]; err[wj] = 0;
        }
      }
    }

    var pal = new Uint8Array(256 * 3);
    var pr = new Int16Array(used), pg = new Int16Array(used), pb = new Int16Array(used);
    for (c = 0; c < used; c++) {
      pr[c] = Math.max(0, Math.min(255, Math.round(cr[c]))); pg[c] = Math.max(0, Math.min(255, Math.round(cg[c]))); pb[c] = Math.max(0, Math.min(255, Math.round(cb[c])));
      pal[c * 3] = pr[c]; pal[c * 3 + 1] = pg[c]; pal[c * 3 + 2] = pb[c];
    }
    // 6 位元格子 → 最近色：已出現的顏色格直接用 k-means 的分配，其餘格子第一次被問到才算（誤差擴散會把顏色推到沒出現過的格子）
    var lut = new Int16Array(HN).fill(-1);
    for (j = 0; j < m; j++) lut[K[j]] = asg[j];
    var half = (1 << HS) / 2 - 0.5;
    function lookup(kk) {
      var qr = ((kk >> (2 * HB)) << HS) + half, qg = (((kk >> HB) & HM) << HS) + half, qb = ((kk & HM) << HS) + half;
      var bd = 1e18, bc = 0, ddx, x, y, z, cc;
      for (cc = 0; cc < used; cc++) {
        x = qr - pr[cc]; y = qg - pg[cc]; z = qb - pb[cc];
        ddx = WR * x * x + WG * y * y + WB * z * z;
        if (ddx < bd) { bd = ddx; bc = cc; }
      }
      lut[kk] = bc;
      return bc;
    }
    return { pal: pal, used: used, lut: lut, lookup: lookup, cents: { r: cr, g: cg, b: cb } };
  }

  /* ------------------------------------------------------------ 蛇形 Floyd–Steinberg（只處理 mask 為 1 的像素） */
  // d：整張 RGBA；(x0,y0,sw,sh)：處理矩形；mask：整張 w×h（1＝這格要畫）；回傳 sw×sh 的索引（不畫的像素＝TRANS）。
  function diffuse(d, w, x0, y0, sw, sh, mask, q, strength) {
    var out = new Uint8Array(sw * sh).fill(TRANS);
    var pal = q.pal, lut = q.lut, lookup = q.lookup;
    var W3 = (sw + 2) * 3;
    var ce = new Float32Array(W3), ne = new Float32Array(W3), tmp;
    var y, xi, x, p, e, r, g, b, kk, c, er, eg, eb, dir, f1, fl, fm;
    for (y = 0; y < sh; y++) {
      var ltr = (y & 1) === 0;
      ne.fill(0);
      for (xi = 0; xi < sw; xi++) {
        x = ltr ? xi : sw - 1 - xi;
        if (!mask[(y0 + y) * w + x0 + x]) continue;
        p = ((y0 + y) * w + x0 + x) * 4; e = (x + 1) * 3;
        r = d[p] + ce[e]; g = d[p + 1] + ce[e + 1]; b = d[p + 2] + ce[e + 2];
        r = r < 0 ? 0 : (r > 255 ? 255 : r); g = g < 0 ? 0 : (g > 255 ? 255 : g); b = b < 0 ? 0 : (b > 255 ? 255 : b);
        kk = (((r | 0) >> HS) << (2 * HB)) | (((g | 0) >> HS) << HB) | ((b | 0) >> HS);
        c = lut[kk]; if (c < 0) c = lookup(kk);
        out[y * sw + x] = c;
        er = (r - pal[c * 3]) * strength; eg = (g - pal[c * 3 + 1]) * strength; eb = (b - pal[c * 3 + 2]) * strength;
        dir = ltr ? 1 : -1;
        f1 = (x + 1 + dir) * 3; fl = (x + 1 - dir) * 3; fm = (x + 1) * 3;
        ce[f1] += er * 0.4375; ce[f1 + 1] += eg * 0.4375; ce[f1 + 2] += eb * 0.4375;
        ne[fl] += er * 0.1875; ne[fl + 1] += eg * 0.1875; ne[fl + 2] += eb * 0.1875;
        ne[fm] += er * 0.3125; ne[fm + 1] += eg * 0.3125; ne[fm + 2] += eb * 0.3125;
        ne[f1] += er * 0.0625; ne[f1 + 1] += eg * 0.0625; ne[f1 + 2] += eb * 0.0625;
      }
      tmp = ce; ce = ne; ne = tmp;
    }
    return out;
  }

  /* ------------------------------------------------------------ LZW＋GIF 寫入 */
  function Sink(cap) { this.buf = new Uint8Array(cap || 65536); this.len = 0; }
  Sink.prototype.push = function (v) {
    if (this.len === this.buf.length) { var nb2 = new Uint8Array(this.buf.length * 2); nb2.set(this.buf); this.buf = nb2; }
    this.buf[this.len++] = v;
  };
  Sink.prototype.pushAll = function (arr) { for (var i = 0; i < arr.length; i++) this.push(arr[i]); };
  Sink.prototype.bytes = function () { return this.buf.subarray(0, this.len); };

  var LZW_TABLE = new Uint32Array(1 << 20);
  var lzwGen = 1;
  function lzw(pix, minCode, out) { // 寫法對照 omggif（MIT）的 GifWriterOutputLZWCodeStream
    var clear = 1 << minCode, eoi = clear + 1;
    var next = eoi + 1, size = minCode + 1, cur = 0, shift = 0, gen = ++lzwGen;
    function emit(code) {
      cur |= code << shift; shift += size;
      while (shift >= 8) { out.push(cur & 255); cur >>>= 8; shift -= 8; }
    }
    emit(clear);
    var ib = pix[0];
    for (var i = 1; i < pix.length; i++) {
      var k = pix[i], key = (ib << 8) | k, e = LZW_TABLE[key];
      if ((e >>> 12) === (gen & 0xFFFFF) && e !== 0) {
        ib = e & 4095;
      } else {
        emit(ib);
        if (next === 4096) {
          emit(clear); next = eoi + 1; size = minCode + 1; gen = ++lzwGen;
        } else {
          if (next >= (1 << size)) size++;
          LZW_TABLE[key] = (((gen & 0xFFFFF) << 12) | next) >>> 0; next++;
        }
        ib = k;
      }
    }
    emit(ib); emit(eoi);
    if (shift > 0) out.push(cur & 255);
  }

  /**
   * 逐格寫入的 GIF 編碼器。addFrame(rgba) 依序丟 w×h 的 RGBA 畫面；finish() 回 Uint8Array。
   * opts: { delayCs, strength（誤差擴散強度，預設 0.7）, eps（視為沒變的色差，預設 2）, onFrame(n) }
   */
  function createEncoder(w, h, opts) {
    opts = opts || {};
    var strength = opts.strength == null ? 0.7 : opts.strength;
    var eps = opts.eps == null ? 2 : opts.eps;
    var delay = Math.max(2, opts.delayCs || 4);
    var out = new Sink(1 << 20);
    function u16(v) { out.push(v & 255); out.push((v >> 8) & 255); }
    function str(s) { for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); }
    var headerDone = false;
    var shown = null, mask = new Uint8Array(w * h), prevCents = null, lastPal = null, count = 0;

    function header(pal) {
      str('GIF89a'); u16(w); u16(h); out.push(0xF7); out.push(0); out.push(0);
      out.pushAll(pal.subarray(0, 768)); // 全域色盤放第一格的（每格另有本機色盤）
      out.push(0x21); out.push(0xFF); out.push(0x0B); str('NETSCAPE2.0'); out.push(0x03); out.push(0x01); out.push(0); out.push(0); out.push(0);
      headerDone = true;
    }
    function writeFrame(x0, y0, sw, sh, idx, pal) {
      out.push(0x21); out.push(0xF9); out.push(0x04); out.push((1 << 2) | 1); u16(delay); out.push(TRANS); out.push(0x00);
      out.push(0x2C); u16(x0); u16(y0); u16(sw); u16(sh); out.push(0x87); // 本機色盤、256 色
      out.pushAll(pal.subarray(0, 768));
      out.push(8);
      var data = new Sink(Math.max(1024, (sw * sh) >> 1));
      lzw(idx, 8, data);
      var db = data.bytes();
      for (var p = 0; p < db.length; p += 255) {
        var len = Math.min(255, db.length - p);
        out.push(len);
        for (var k = 0; k < len; k++) out.push(db[p + k]);
      }
      out.push(0x00);
    }

    return {
      addFrame: function (d) {
        var first = shown === null, minx = w, miny = h, maxx = -1, maxy = -1, x, y, p, o, n = 0;
        if (first) shown = new Uint8ClampedArray(w * h * 4);
        for (y = 0; y < h; y++) {
          for (x = 0, o = y * w, p = o * 4; x < w; x++, o++, p += 4) {
            var ch = first ||
              Math.abs(d[p] - shown[p]) > eps || Math.abs(d[p + 1] - shown[p + 1]) > eps || Math.abs(d[p + 2] - shown[p + 2]) > eps;
            mask[o] = ch ? 1 : 0;
            if (ch) { n++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
          }
        }
        count++;
        if (opts.onFrame) opts.onFrame(count);
        if (n === 0) { // 這一格跟上一格一樣：寫一個 1×1 的透明像素撐住時間
          var dummy = new Uint8Array(768);
          if (!headerDone) header(dummy);
          writeFrame(0, 0, 1, 1, Uint8Array.of(TRANS), lastPal || dummy);
          return;
        }
        var sw = maxx - minx + 1, sh = maxy - miny + 1;
        var compact = new Uint8ClampedArray(n * 4), ci = 0;
        for (y = miny; y <= maxy; y++) {
          for (x = minx, o = y * w + minx; x <= maxx; x++, o++) {
            if (!mask[o]) continue;
            p = o * 4; compact[ci++] = d[p]; compact[ci++] = d[p + 1]; compact[ci++] = d[p + 2]; compact[ci++] = 255;
          }
        }
        var q = buildPalette([compact], { init: prevCents ? prevCents.cents : null, warmIters: opts.warmIters });
        if (q.used === NCOLORS) prevCents = { cents: q.cents, pal: q.pal }; // 不足 255 色的色盤不留作下一格的起點（見 buildPalette）
        lastPal = q.pal;
        var idx = diffuse(d, w, minx, miny, sw, sh, mask, q, strength);
        if (!headerDone) header(q.pal);
        writeFrame(minx, miny, sw, sh, idx, q.pal);
        for (y = miny; y <= maxy; y++) {
          for (x = minx, o = y * w + minx; x <= maxx; x++, o++) {
            if (!mask[o]) continue;
            p = o * 4; shown[p] = d[p]; shown[p + 1] = d[p + 1]; shown[p + 2] = d[p + 2]; shown[p + 3] = 255;
          }
        }
      },
      finish: function () { out.push(0x3B); return out.bytes(); },
    };
  }

  var api = { buildPalette: buildPalette, createEncoder: createEncoder, NCOLORS: NCOLORS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GifQuant = api;
})(typeof window !== 'undefined' ? window : this);
