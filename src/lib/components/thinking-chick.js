// @ts-nocheck — framework-free animation core shared with a plain HTML prototype; its untyped
// parameters became errors under TypeScript 6's checkJs. Behaviour is covered through ThinkingChick.svelte.
// thinking-chick.js — "defter okuyan kuş" bekleme animasyonu (çerçeveden bağımsız çekirdek).
// ThinkingChick.svelte ve prototipler/bekleme-animasyonu.html bunu kullanır.
//
// const chick = createChick(el, { config, onExited, onState });
// chick.setPhase('idle' | 'thinking' | 'done');
//   idle     kilit elde, defter kapalı
//   thinking kilit yere iner, defter kuşa doğru açılır, beklerken sayfalar çevrilir
//   done     defter kapanır, kilit alınır (exitMs, 500 ms), bitince onExited çağrılır
// chick.setConfig(partial) · chick.getConfig() · chick.setSpeed(n) · chick.destroy()

export var VAULT_CHICK_DEFAULTS = {
  bodyWidth: 1,
  bookW: 85, bookH: 117, pitch: 0.47, pageThick: 11,
  idleX: 420, idleY: 249, idleTilt: 16,
  readX: 414, readY: 232, readTilt: 17,
  closedAngle: 168, holdAngle: 130, spread: 123,
  lockLift: 40,
  lockDrop: 420, bookTurn: 300, coverOpen: 360,
  flip: 570, gapMin: 350, gapMax: 800, exitMs: 500
};

export function createChick(root, opts) {
  opts = opts || {};
  var cfg = Object.assign({}, VAULT_CHICK_DEFAULTS, opts.config || {});
  var uid = 'vc' + Math.random().toString(36).slice(2, 8);
  var D2R = Math.PI / 180;
  // Aynı mantık src/lib/motion.ts prefersReducedMotion(): uygulama ayarı (<html data-motion>) varsa o, yoksa işletim sistemi tercihi.
  var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  function reduced() {
    var m = document.documentElement.dataset.motion;
    return m ? m === 'reduce' : mq.matches;
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function f(n) { return Math.round(n * 10) / 10; }

  var C = {
    yel: '#FFD22E', yelSh: '#F2B408', yelHi: '#FFF1A8', belly: '#FCE6A6', bellySh: '#F5D688',
    wing: '#F7BC16', wingLine: '#E09C08', beak: '#F28A2E', beakD: '#D8661C',
    navy: '#1B2350', cheek: '#F36FA3', foot: '#F0852D',
    cap: '#3D2196', capD: '#28136B', capTop: '#4E2DB2', gold: '#F5A623', goldD: '#D9861A',
    lock: '#A9AEC4', lockD: '#8A8FA8', lockHi: '#C9CDDD', lockKey: '#2B2F4A',
    cover: '#5B2FC7', coverD: '#3F1F9B', coverIn: '#47249E', label: '#7D57E0',
    page: '#FBF6EA', pageEdge: '#EADFC2', pageEdge2: '#E0D3B0', line: '#D3C7A9', ribbon: '#E5483F',
    shadow: '#3A2A00'
  };

  // Animasyon durumu (hepsi 0..1 arası, flip -1 = çevrilen sayfa yok)
  var st = { lockT: 0, wingDown: 0, wingRest: 0, turn: 0, open: 0, flip: -1, pup: 0 };
  var refs = {};

  // ---------- Sabit çizim ----------
  function build() {
    var c = cfg, bw = c.bodyWidth, cx = 243;
    function X(lx) { return f(cx + bw * lx); }
    var L = cx - 106 * bw, R = cx + 106 * bw;
    var lx = f(L + 14);
    var px = lx, py = 272;
    var gTop = 376;
    var s = '';
    s += '<svg class="' + uid + '" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;width:100%;height:auto;overflow:visible">';
    s += '<style>' +
      '.' + uid + ' .breathe{animation:' + uid + 'b 3.4s ease-in-out infinite}' +
      '.' + uid + ' .tassel{transform-origin:356px 117px;animation:' + uid + 't 2.6s ease-in-out infinite}' +
      '@keyframes ' + uid + 'b{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}' +
      '@keyframes ' + uid + 't{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(5deg)}}' +
      ':root[data-motion="reduce"] .' + uid + ' .breathe,:root[data-motion="reduce"] .' + uid + ' .tassel{animation:none}' +
      '</style>';
    s += '<defs><clipPath id="' + uid + 'body"><path d="' + bodyPath() + '"/></clipPath></defs>';

    s += '<ellipse cx="' + X(0) + '" cy="420" rx="' + f(118 * bw) + '" ry="14" fill="' + C.shadow + '" fill-opacity="0.13"/>';
    s += '<ellipse data-k="lockShadow" cx="' + lx + '" cy="429" rx="30" ry="5" fill="' + C.shadow + '" fill-opacity="0.2"/>';

    // ayaklar
    s += '<g fill="none" stroke="' + C.foot + '" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">';
    [-34, 30].forEach(function (o) {
      var x = cx + bw * o;
      s += '<path d="M' + f(x) + ' 384 V408 M' + f(x) + ' 408 L' + f(x - 12) + ' 419 M' + f(x) + ' 408 V420 M' + f(x) + ' 408 L' + f(x + 12) + ' 418"/>';
    });
    s += '</g>';

    // sağ kol (defteri tutan), gövdenin arkasından çıkar
    s += '<line data-k="arm" stroke="' + C.wing + '" stroke-width="22" stroke-linecap="round"/>';

    // gövde + yüz + şapka
    s += '<g class="breathe">';
    s += '<path d="' + bodyPath() + '" fill="' + C.yel + '"/>';
    s += '<g clip-path="url(#' + uid + 'body)">';
    s += '<ellipse cx="' + X(78) + '" cy="300" rx="' + f(70 * bw) + '" ry="140" fill="' + C.yelSh + '" fill-opacity="0.45"/>';
    s += '<ellipse cx="' + X(0) + '" cy="408" rx="' + f(130 * bw) + '" ry="34" fill="' + C.yelSh + '" fill-opacity="0.4"/>';
    s += '</g>';
    s += '<ellipse cx="' + X(-62) + '" cy="196" rx="11" ry="24" transform="rotate(24 ' + X(-62) + ' 196)" fill="' + C.yelHi + '" fill-opacity="0.75"/>';
    s += '<ellipse cx="' + X(8) + '" cy="338" rx="' + f(72 * bw) + '" ry="50" fill="' + C.belly + '"/>';
    s += '<path d="M' + X(-56) + ' 362 Q' + X(8) + ' 398 ' + X(72) + ' 360 Q' + X(8) + ' 392 ' + X(-56) + ' 362 Z" fill="' + C.bellySh + '" fill-opacity="0.7"/>';
    // tüy kıvrımları
    s += '<path d="M' + X(-30) + ' 300 q6 6 12 0 M' + X(30) + ' 306 q6 6 12 0" stroke="' + C.wingLine + '" stroke-width="2.5" fill="none" stroke-linecap="round" opacity="0.5"/>';

    s += '<ellipse cx="204" cy="252" rx="14" ry="9" fill="' + C.cheek + '" fill-opacity="0.85"/>';
    s += '<ellipse cx="326" cy="245" rx="14" ry="9" fill="' + C.cheek + '" fill-opacity="0.85"/>';
    // gaga: öne çıkan, üstten ışık alan küçük koni
    s += '<ellipse cx="270" cy="259" rx="9" ry="3.2" fill="' + C.yelSh + '" fill-opacity="0.7"/>';
    s += '<path d="M255 238 Q268 230 282 236 Q281 247 269 257 Q259 249 255 238 Z" fill="' + C.beak + '"/>';
    s += '<path d="M269 257 Q281 247 282 236 Q276 243 268 245 Z" fill="' + C.beakD + '"/>';
    s += '<path d="M255 238 Q268 230 282 236 Q270 236 263 241 Z" fill="#FFB067" opacity="0.9"/>';
    s += '<ellipse cx="262" cy="243" rx="2.6" ry="4" transform="rotate(-30 262 243)" fill="#FFD3A0" opacity="0.85"/>';

    s += '<ellipse cx="222" cy="227" rx="31" ry="25" fill="#FFF6CC" fill-opacity="0.7"/>';
    s += '<ellipse cx="307" cy="221" rx="31" ry="25" fill="#FFF6CC" fill-opacity="0.7"/>';
    s += '<g data-k="pupils">';
    s += '<g data-k="eye" data-cx="229" data-cy="228"><circle cx="229" cy="228" r="10" fill="' + C.navy + '"/><circle cx="232.5" cy="224" r="3.4" fill="#fff"/><circle cx="226" cy="232" r="1.4" fill="#fff"/></g>';
    s += '<g data-k="eye" data-cx="314" data-cy="223"><circle cx="314" cy="223" r="10" fill="' + C.navy + '"/><circle cx="317.5" cy="219" r="3.4" fill="#fff"/><circle cx="311" cy="227" r="1.4" fill="#fff"/></g>';
    s += '</g>';
    s += '<g fill="none" stroke="' + C.navy + '" stroke-linecap="round">';
    s += '<ellipse cx="222" cy="227" rx="31" ry="25" stroke-width="6.5"/>';
    s += '<ellipse cx="307" cy="221" rx="31" ry="25" stroke-width="6.5"/>';
    s += '<path d="M253 224 Q265 218 276 222" stroke-width="5"/>';
    s += '<path d="M191 222 L' + X(-92) + ' 214" stroke-width="5.5"/>';
    s += '<path d="M338 216 L' + X(92) + ' 211" stroke-width="5.5"/>';
    s += '</g>';
    s += '<path d="M206 213 Q214 207 222 208" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.8"/>';
    s += '<path d="M291 207 Q299 201 307 202" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.8"/>';

    // kep
    s += '<path d="M190 128 V160 C222 178 276 178 306 159 V128 Z" fill="' + C.capD + '"/>';
    s += '<path d="M190 146 C222 160 276 160 306 145 V159 C276 178 222 178 190 160 Z" fill="#1E0E52" opacity="0.6"/>';
    s += '<path d="M124 117 L250 144 L360 112 L360 119 L250 152 L124 125 Z" fill="' + C.capD + '"/>';
    s += '<path d="M124 117 L242 81 L360 112 L250 144 Z" fill="' + C.cap + '"/>';
    s += '<path d="M150 112 L242 86 L334 110 L242 92 Z" fill="' + C.capTop + '" opacity="0.8"/>';
    s += '<path d="M242 103 Q310 100 356 117" fill="none" stroke="' + C.gold + '" stroke-width="3" stroke-linecap="round"/>';
    s += '<ellipse cx="242" cy="103" rx="7" ry="4.5" fill="#1F0F57"/>';
    s += '<g class="tassel">';
    s += '<path d="M356 117 V146" stroke="' + C.gold + '" stroke-width="3" stroke-linecap="round"/>';
    s += '<rect x="351" y="143" width="10" height="6" rx="2" fill="' + C.goldD + '"/>';
    s += '<path d="M350 149 H362 L366 178 H346 Z" fill="' + C.gold + '"/>';
    s += '<path d="M351 156 L349 176 M356 156 V177 M361 156 L363 176" stroke="' + C.goldD + '" stroke-width="1.6" stroke-linecap="round"/>';
    s += '</g>';
    s += '</g>'; // breathe

    // kilit (kanadın altında)
    s += '<g data-k="lock">';
    s += '<path d="M' + f(lx - 15) + ' ' + (gTop + 4) + ' V' + (gTop - 12) + ' C' + f(lx - 15) + ' ' + (gTop - 30) + ' ' + f(lx - 7) + ' ' + (gTop - 27) + ' ' + lx + ' ' + (gTop - 27) +
      ' C' + f(lx + 7) + ' ' + (gTop - 27) + ' ' + f(lx + 15) + ' ' + (gTop - 30) + ' ' + f(lx + 15) + ' ' + (gTop - 12) + ' V' + (gTop + 4) + '" fill="none" stroke="' + C.lockD + '" stroke-width="8" stroke-linecap="round"/>';
    s += '<rect x="' + f(lx - 28) + '" y="' + gTop + '" width="56" height="52" rx="8" fill="' + C.lock + '"/>';
    s += '<path d="M' + f(lx - 28) + ' ' + (gTop + 38) + ' H' + f(lx + 28) + ' V' + (gTop + 44) + ' A8 8 0 0 1 ' + f(lx + 20) + ' ' + (gTop + 52) + ' H' + f(lx - 20) + ' A8 8 0 0 1 ' + f(lx - 28) + ' ' + (gTop + 44) + ' Z" fill="' + C.lockD + '"/>';
    s += '<rect x="' + f(lx - 22) + '" y="' + (gTop + 6) + '" width="6" height="28" rx="3" fill="' + C.lockHi + '"/>';
    s += '<circle cx="' + lx + '" cy="' + (gTop + 20) + '" r="6.5" fill="' + C.lockKey + '"/>';
    s += '<path d="M' + f(lx - 3) + ' ' + (gTop + 23) + ' H' + f(lx + 3) + ' L' + f(lx + 4) + ' ' + (gTop + 36) + ' H' + f(lx - 4) + ' Z" fill="' + C.lockKey + '"/>';
    s += '</g>';

    // sol kanat (kilidi tutar)
    s += '<g data-k="wing">';
    s += '<path d="M' + f(px + 8) + ' ' + (py - 8) + ' C' + f(px + 24) + ' ' + (py + 14) + ' ' + f(px + 18) + ' ' + (py + 46) + ' ' + f(px + 2) + ' ' + (py + 60) +
      ' C' + f(px - 10) + ' ' + (py + 66) + ' ' + f(px - 24) + ' ' + (py + 54) + ' ' + f(px - 22) + ' ' + (py + 36) +
      ' C' + f(px - 20) + ' ' + (py + 16) + ' ' + f(px - 10) + ' ' + (py - 4) + ' ' + f(px + 8) + ' ' + (py - 8) + ' Z" fill="' + C.wing + '"/>';
    s += '<path d="M' + f(px - 12) + ' ' + (py + 30) + ' q4 10 10 14 M' + f(px - 4) + ' ' + (py + 22) + ' q4 10 10 14" stroke="' + C.wingLine + '" stroke-width="2.5" fill="none" stroke-linecap="round"/>';
    s += '</g>';

    // defter ve el
    s += '<g data-k="book"></g>';
    s += '<g data-k="hand"><ellipse cx="0" cy="0" rx="13" ry="11" fill="#FFC72C"/><path d="M-7 -3 Q0 -8 7 -3" stroke="' + C.wingLine + '" stroke-width="2.2" fill="none" stroke-linecap="round"/></g>';
    s += '</svg>';

    root.innerHTML = s;
    function q(k) { return root.querySelector('[data-k="' + k + '"]'); }
    refs = {
      lock: q('lock'), lockShadow: q('lockShadow'), wing: q('wing'), pupils: q('pupils'),
      arm: q('arm'), book: q('book'), hand: q('hand'),
      eyes: Array.prototype.slice.call(root.querySelectorAll('[data-k="eye"]')),
      wingPivot: [px, py], shoulder: [R - 16, 298]
    };
    lastBook = '';

    function bodyPath() {
      return 'M' + X(0) + ' 146 C' + X(-68) + ' 146 ' + X(-106) + ' 196 ' + X(-108) + ' 262 C' + X(-110) + ' 334 ' + X(-64) + ' 396 ' + X(0) + ' 396' +
        ' C' + X(64) + ' 396 ' + X(110) + ' 334 ' + X(108) + ' 262 C' + X(106) + ' 196 ' + X(68) + ' 146 ' + X(0) + ' 146 Z';
    }
  }

  // ---------- Defter (her karede hesaplanır) ----------
  var lastBook = '';
  function poly(pts, fill, extra) {
    return '<path d="M' + pts.map(function (p) { return f(p[0]) + ' ' + f(p[1]); }).join(' L') + ' Z" fill="' + fill + '"' + (extra || '') + '/>';
  }
  function bookGeom() {
    var c = cfg, T = st.turn;
    var Sx = lerp(c.idleX, c.readX, T), Sy = lerp(c.idleY, c.readY, T);
    var tilt = lerp(c.idleTilt, c.readTilt, T);
    var aN = lerp(c.closedAngle, c.holdAngle, T) * D2R;
    var aF = aN + c.spread * st.open * D2R;
    return { Sx: Sx, Sy: Sy, tilt: tilt, aN: aN, aF: aF };
  }
  function drawBook(g) {
    var c = cfg, W = c.bookW, H = c.bookH, p = c.pitch, th = c.pageThick;
    // side +1: yakın yarı (içi +90°), side -1: uzak yarı (içi -90°)
    function P(a, side, u, y, off) {
      var nx = -Math.sin(a) * side, nz = Math.cos(a) * side;
      var x = u * Math.cos(a) + off * nx, z = u * Math.sin(a) + off * nz;
      return [g.Sx + x, g.Sy + y + z * p];
    }
    function lines(a, side, off, alpha) {
      if (alpha < 0.05) return '';
      var d = '';
      for (var i = 0; i < 7; i++) {
        var y = H * (0.16 + i * 0.1);
        var u0 = W * 0.16, u1 = W * (i === 6 ? 0.6 : 0.84);
        var A = P(a, side, u0, y, off), B = P(a, side, u1, y, off);
        d += 'M' + f(A[0]) + ' ' + f(A[1]) + ' L' + f(B[0]) + ' ' + f(B[1]) + ' ';
      }
      return '<path d="' + d + '" stroke="' + C.line + '" stroke-width="1.8" stroke-linecap="round" fill="none" opacity="' + f(alpha) + '"/>';
    }
    function rect(a, side, u0, u1, y0, y1, off) {
      return [P(a, side, u0, y0, off), P(a, side, u1, y0, off), P(a, side, u1, y1, off), P(a, side, u0, y1, off)];
    }
    function half(a, side, isNear) {
      var seesInside = Math.cos(a) * side > 0;
      var u0 = 1.5, u1 = W - 3, y0 = 1.5, y1 = H - 1.5, o0 = 1.5, o1 = th;
      var top = poly([P(a, side, u0, y0, o0), P(a, side, u1, y0, o0), P(a, side, u1, y0, o1), P(a, side, u0, y0, o1)], C.pageEdge);
      var fore = poly([P(a, side, u1, y0, o0), P(a, side, u1, y1, o0), P(a, side, u1, y1, o1), P(a, side, u1, y0, o1)], C.pageEdge2);
      var face = poly(rect(a, side, u0, u1, y0, y1, o1), C.page);
      var cover = rect(a, side, 0, W, -1.5, H + 1.5, 0);
      var out = '';
      if (seesInside) {
        out += poly(cover, C.coverIn) + fore + top + face + lines(a, side, o1, Math.min(1, Math.abs(Math.cos(a)) * 1.6));
      } else {
        out += fore + top + poly(cover, C.cover);
        if (isNear) {
          out += poly(rect(a, side, 0, 9, -1.5, H + 1.5, 0), C.coverD);
          out += poly(rect(a, side, W * 0.3, W * 0.78, H * 0.15, H * 0.29, 0), C.label);
          out += poly(rect(a, side, W * 0.3, W * 0.66, H * 0.34, H * 0.37, 0), C.label);
        }
      }
      return out;
    }
    function leaf(a, k) {
      var off = th * (1 - 2 * k);
      var pts = rect(a, 1, 1.5, W - 3, 1.5, H - 1.5, off);
      var face = Math.abs(Math.cos(a));
      return poly(pts, C.page) +
        poly(pts, '#2A1A5A', ' opacity="' + f((1 - face) * 0.3) + '"') +
        lines(a, 1, off, face);
    }
    var items = [
      { z: Math.sin(g.aF), i: 0, s: half(g.aF, -1, false) },
      { z: Math.sin(g.aN), i: 2, s: half(g.aN, 1, true) }
    ];
    if (st.flip >= 0) {
      var aL = lerp(g.aN, g.aF, st.flip);
      items.push({ z: Math.sin(aL), i: 1, s: leaf(aL, st.flip) });
    }
    items.sort(function (A, B) { return (A.z - B.z) || (A.i - B.i); });
    var rb = P(g.aN, 1, 4, H - 2, th / 2);
    var ribbon = '<path d="M' + f(rb[0]) + ' ' + f(rb[1]) + ' q2 10 -2 18 l5 -3 l3 5 q3 -10 0 -20 Z" fill="' + C.ribbon + '"/>';
    var hand = P(g.aN, 1, 8, H * 0.8, -4);
    return {
      svg: '<g transform="rotate(' + f(g.tilt) + ' ' + f(g.Sx) + ' ' + f(g.Sy) + ')">' + ribbon + items.map(function (x) { return x.s; }).join('') + '</g>',
      hand: rot(hand, [g.Sx, g.Sy], g.tilt)
    };
  }
  function rot(pt, o, deg) {
    var a = deg * D2R, dx = pt[0] - o[0], dy = pt[1] - o[1];
    return [o[0] + dx * Math.cos(a) - dy * Math.sin(a), o[1] + dx * Math.sin(a) + dy * Math.cos(a)];
  }

  // ---------- Kare çizimi ----------
  var blinkAt = -1, nextBlink = 1800;
  function render() {
    var c = cfg;
    refs.lock.setAttribute('transform', 'translate(0 ' + f(-c.lockLift * (1 - st.lockT)) + ')');
    var sc = 0.6 + 0.4 * st.lockT;
    refs.lockShadow.setAttribute('rx', f(30 * sc));
    refs.lockShadow.setAttribute('fill-opacity', f(0.1 + 0.12 * st.lockT));
    var pv = refs.wingPivot;
    refs.wing.setAttribute('transform',
      'translate(0 ' + f(c.lockLift * st.wingDown - 6 * st.wingRest) + ') rotate(' + f(-26 * st.wingRest) + ' ' + pv[0] + ' ' + pv[1] + ')');
    refs.pupils.setAttribute('transform', 'translate(' + f(lerp(-3, 5, st.pup)) + ' ' + f(lerp(1, 3, st.pup)) + ')');
    var bs = 1;
    if (blinkAt >= 0) {
      var k = (clock - blinkAt) / 150;
      if (k >= 1) blinkAt = -1; else bs = 1 - 0.9 * Math.sin(Math.PI * k);
    }
    refs.eyes.forEach(function (e) {
      var ex = e.getAttribute('data-cx'), ey = e.getAttribute('data-cy');
      e.setAttribute('transform', 'translate(' + ex + ' ' + ey + ') scale(1 ' + f(bs) + ') translate(' + -ex + ' ' + -ey + ')');
    });
    var g = bookGeom();
    var b = drawBook(g);
    if (b.svg !== lastBook) { refs.book.innerHTML = b.svg; lastBook = b.svg; }
    var sh = refs.shoulder;
    refs.arm.setAttribute('x1', sh[0]); refs.arm.setAttribute('y1', sh[1]);
    refs.arm.setAttribute('x2', f(b.hand[0])); refs.arm.setAttribute('y2', f(b.hand[1]));
    refs.hand.setAttribute('transform', 'translate(' + f(b.hand[0]) + ' ' + f(b.hand[1]) + ') rotate(' + f(g.tilt - 20) + ')');
  }

  // ---------- Zaman çizelgesi ----------
  var EASE = {
    lin: function (t) { return t; },
    io: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    out: function (t) { return 1 - Math.pow(1 - t, 3); },
    in: function (t) { return t * t * t; },
    drop: function (t) { return t < 0.72 ? Math.pow(t / 0.72, 2) : 1 - 0.14 * Math.sin(Math.PI * (t - 0.72) / 0.28); }
  };
  var clock = 0, last = null, speed = 1, tweens = [], raf = 0, alive = true;
  function tween(key, to, dur, ease, delay) {
    return new Promise(function (res) {
      if (key && reduced()) { st[key] = to; res(); return; }
      tweens.push({ key: key, to: to, from: null, start: clock + (delay || 0), dur: Math.max(1, dur), ease: ease || EASE.io, res: res });
    });
  }
  function wait(ms) { return tween(null, 0, ms); }
  function tick(ts) {
    if (!alive) return;
    if (last === null) last = ts;
    var dt = Math.min(64, ts - last); last = ts;
    clock += dt * speed;
    var keep = [];
    tweens.forEach(function (tw) {
      if (clock < tw.start) { keep.push(tw); return; }
      if (tw.from === null) tw.from = tw.key ? st[tw.key] : 0;
      var k = Math.min(1, (clock - tw.start) / tw.dur);
      if (tw.key) st[tw.key] = tw.from + (tw.to - tw.from) * tw.ease(k);
      if (k >= 1) { if (tw.key) st[tw.key] = tw.to; tw.res(); } else keep.push(tw);
    });
    tweens = keep;
    if (!reduced() && clock > nextBlink) { blinkAt = clock; nextBlink = clock + 2200 + Math.random() * 3200; }
    render();
    raf = requestAnimationFrame(tick);
  }
  // Bekleyen her şeyi kısa sürede bitir
  function rush(ms) {
    tweens.forEach(function (tw) {
      if (tw.key) tw.from = st[tw.key];
      tw.start = clock; tw.dur = tw.key ? ms : 1; tw.ease = EASE.out;
    });
  }
  // Çevrilen sayfayı hızla bitir, beklemeyi kes
  function hurry() {
    tweens.forEach(function (tw) {
      if (tw.key === 'flip') { tw.from = st.flip; tw.start = clock; tw.dur = 20 + 110 * (1 - st.flip); tw.ease = EASE.lin; }
      else if (!tw.key) { tw.start = clock; tw.dur = 1; }
    });
  }

  function enter() {
    var c = cfg, Ld = c.lockDrop, Tn = c.bookTurn, Op = c.coverOpen;
    var tTurn = Ld * 0.7, tOpen = tTurn + Tn * 0.8;
    return Promise.all([
      tween('lockT', 1, Ld, EASE.drop),
      tween('wingDown', 1, Ld, EASE.drop),
      tween('wingDown', 0.3, 240, EASE.out, Ld + 10),
      tween('wingRest', 1, 240, EASE.out, Ld + 10),
      tween('pup', 1, 300, EASE.out, Ld * 0.5),
      tween('turn', 1, Tn, EASE.io, tTurn),
      tween('open', 1, Op, EASE.io, tOpen)
    ]);
  }
  function exit() {
    var E = cfg.exitMs;
    return Promise.all([
      tween('open', 0, E * 0.42, EASE.in),
      tween('turn', 0, E * 0.55, EASE.io, E * 0.38),
      tween('pup', 0, E * 0.4, EASE.out, E * 0.3),
      tween('wingRest', 0, E * 0.32, EASE.out, E * 0.1),
      tween('wingDown', 1, E * 0.32, EASE.out, E * 0.1),
      tween('wingDown', 0, E * 0.5, EASE.io, E * 0.5),
      tween('lockT', 0, E * 0.5, EASE.io, E * 0.5)
    ]);
  }
  function readOnce() {
    var c = cfg;
    if (reduced()) return wait(1000);
    st.flip = 0;
    return tween('flip', 1, c.flip, EASE.io).then(function () {
      st.flip = -1;
      if (want === 'thinking') return wait(c.gapMin + Math.random() * Math.max(0, c.gapMax - c.gapMin));
    });
  }

  // ---------- Faz makinesi ----------
  var want = 'idle', state = 'idle', running = false;
  function setState(s) { state = s; if (opts.onState) opts.onState(s); }
  function pump() {
    if (running) return;
    running = true;
    (function step() {
      if (!alive) { running = false; return; }
      if (want === 'thinking' && state === 'idle') {
        setState('entering');
        enter().then(function () { setState('reading'); step(); });
      } else if (want === 'thinking' && state === 'reading') {
        readOnce().then(step);
      } else if (want !== 'thinking' && state === 'reading') {
        var why = want;
        setState('exiting');
        exit().then(function () {
          st.flip = -1; setState('idle');
          if (why === 'done' && want === 'done' && opts.onExited) opts.onExited();
          step();
        });
      } else running = false;
    })();
  }

  build();
  render();
  raf = requestAnimationFrame(tick);

  return {
    // 'idle' | 'thinking' | 'done'
    setPhase: function (p) {
      want = p;
      if (p !== 'thinking') {
        if (state === 'entering') rush(160);
        else if (state === 'reading') hurry();
        if (p === 'done' && state === 'idle' && !running) { if (opts.onExited) opts.onExited(); return; }
      }
      pump();
    },
    setConfig: function (partial) { Object.assign(cfg, partial); build(); render(); },
    getConfig: function () { return Object.assign({}, cfg); },
    setSpeed: function (s) { speed = s; },
    destroy: function () { alive = false; cancelAnimationFrame(raf); tweens = []; }
  };
}
