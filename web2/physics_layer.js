/* 物理の層: 音の物理の各項が「どこまで効き、どこまでしか効かないか」を、web2 の 3D の街に重ねて見せる。
 * web2 本体（ビルド済み）は変更しない。three.js のクラスは、既存オブジェクトの constructor から取り出す。
 * 数値はすべて ../physics/*.json（モデルの計算値）から読む。実測との比較は無い。
 * 窓口: window.__phys（README を参照）。アニメーションは performance.now / rAF の時刻だけで進める（仮想時計に従う）。
 */
(function () {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 0) => (n == null || Number.isNaN(n)) ? '—' : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // ------------------------------------------------------------ 定数（表示用の名前。数値はデータから）
  const KIND = {
    direct_los: { c: '#37d67a', ja: '見通しの直接音', short: '直接', dash: false },
    direct_blocked_line: { c: '#b4bec9', ja: '遮られた直線（合計に入らない）', short: '遮られた直線', dash: true },
    diff_roof: { c: '#ff9a2e', ja: '屋根越えの回折', short: '屋根越え', dash: false },
    diff_edge_left: { c: '#4aa3ff', ja: '左エッジ回りの回折', short: '左エッジ', dash: false },
    diff_edge_right: { c: '#2ad4e6', ja: '右エッジ回りの回折', short: '右エッジ', dash: false },
    reflect1: { c: '#ff5fb0', ja: '1 次反射', short: '1次反射', dash: false },
    reflect2: { c: '#b57bff', ja: '2 次反射', short: '2次反射', dash: false },
    ground: { c: '#d2a060', ja: '地面反射（合計に入らない）', short: '地面反射', dash: true },
  };
  const TERMS = [
    { k: 'los', ja: '見通し' }, { k: 'roof', ja: '屋根越え' }, { k: 'left', ja: '左エッジ' }, { k: 'right', ja: '右エッジ' },
    { k: 'wall1', ja: '1次反射' }, { k: 'wall2', ja: '2次反射' }, { k: 'ground', ja: '地面（足す）' },
    { k: 'reflections_all', ja: '反射の全部' }, { k: 'diffraction_all', ja: '回折の全部' },
    { k: 'nearest_spk', ja: '最寄りSP' }, { k: 'strongest_spk', ja: '最強SP' },
    { k: 'sti', ja: '聞き取りΔSTI' }, { k: 'cov', ja: '聞こえる/否' },
  ];
  const STI_VARS = [
    { k: 'wo_reflections_all', ja: '反射を取り除く' }, { k: 'strongest_only', ja: '最強の1本のみ' }, { k: 'no_delay', ja: '遅れを無視' },
  ];
  const STEPS = [
    { k: 'L1_single_direct', n: '1本ごと・直接（旧定義）', cmp: null },
    { k: 'L2_combined_direct', n: '合成・直接', cmp: 'L1_single_direct' },
    { k: 'L3_single_direct_1st', n: '1本ごと・直接+1次', cmp: 'L1_single_direct' },
    { k: 'L4_combined_1st', n: '合成・直接+1次', cmp: 'L2_combined_direct' },
    { k: 'L4b_single_direct_1st_2nd', n: '1本ごと・直接+1次+2次', cmp: 'L3_single_direct_1st' },
    { k: 'L5_combined_2nd', n: '合成・直接+1次+2次（音圧のみ）', cmp: 'L4_combined_1st' },
    { k: 'L6_ground', n: '＋地面反射（音圧のみ）', cmp: 'L5_combined_2nd' },
    { k: 'L7_sti', n: '＋STI風 判定（最終）', cmp: 'L5_combined_2nd' },
    { k: 'L7d_sti_direct_only', n: '直接のみ＋STI風', cmp: 'L7_sti' },
    { k: 'L7g_sti_with_ground', n: '地面あり・最終', cmp: 'L7_sti' },
  ];
  const stepIdx = (k) => STEPS.findIndex((s) => s.k === k);
  const CODE_TITLE = {
    '1_los': '見通し', '2_roof': '屋根越え', '2_left': '左エッジ回り', '2_right': '右エッジ回り', '3_reflection_needed': '反射が要る',
    '4_second_order': '2次反射が効く', '5a_delay_speakers': 'スピーカーの遅れでSTI低下', '5b_delay_reflections': '反射の遅れでSTI低下',
    '6_near_miss': '惜しい（届かない）', '7_receiver_needed': '受信機が要る', '8_ground': '地面反射が最大',
  };

  let K, D, T, E, PA, PW, TH;       // 外部 / データ
  let C = {};                        // three のクラス
  let overlayRoot = null;
  const S = { mode: 'off', term: 'roof', plan: 'new', step: 0, rcv: '2_roof', proof: 0, stiVar: 'wo_reflections_all', play: false, playT0: 0, showOther: true, fold: false };
  let api = null;

  // ------------------------------------------------------------ 起動待ち
  function boot() {
    if (!window.__ready || !window.__kikoeru) { setTimeout(boot, 100); return; }
    Promise.all(['terms_1500', 'effect_range', 'paths', 'proof_wall', 'checks'].map((n) => fetch('../physics/' + n + '.json').then((r) => { if (!r.ok) throw new Error(n + ' HTTP ' + r.status); return r.json(); })))
      .then(([t, e, p, w]) => { T = t; E = e; PA = p; PW = w; TH = T.meta.thresholds; init(); })
      .catch((err) => { console.error('physics_layer: データ読み込みに失敗', err); const d = document.createElement('div'); d.id = 'phys-note'; d.textContent = '物理の層: データの読み込みに失敗しました（' + err.message + '）'; document.body.appendChild(d); });
  }

  // ------------------------------------------------------------ three のクラス取り出し
  function grabClasses() {
    K = window.__kikoeru; D = K.D;
    const scene = K.scene, shell = scene.getObjectByName('shell'), overlay = scene.getObjectByName('overlay');
    let ls2 = null; overlay.traverse((o) => { if (o.isLineSegments2 && !ls2) ls2 = o; });
    C.Mesh = shell.constructor; C.Group = overlay.constructor; C.BufGeo = shell.geometry.constructor; C.BufAttr = shell.geometry.attributes.position.constructor;
    C.ShaderMat = shell.material.constructor;
    C.Vector3 = K.camera.position.constructor;
    C.LS2 = ls2.constructor; C.LMat = ls2.material.constructor; C.LGeo = ls2.geometry.constructor; C.Color = ls2.material.color.constructor;
    C.Vector2 = ls2.material.resolution.constructor;
    C.ok = { LS2: !!C.LS2, LMat: !!C.LMat, LGeo: !!C.LGeo };
  }
  const V3 = (x, y, z) => new C.Vector3(x, y, z);
  const GY = (x, yn) => K.groundY(x, yn);                         // 局所 (x 東, y 北) -> three の高さ
  const toThree = (x, yn, z) => [x, GY(x, yn) + z, -yn];         // 局所座標の点 -> three（z = 地面からの高さ）

  // ------------------------------------------------------------ 角柱（LOD1 外形を、LOD2 の高さに合わせて押し出す。web2 の覆いと同じ作り）
  let BLD = null;   // {mesh, starts[], counts[], col(Float32Array)}
  function polyClean(poly) {
    const pts = [];
    for (const p of poly) { const q = pts[pts.length - 1]; if (!q || Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-3) pts.push(p); }
    if (pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-3) pts.pop();
    return pts;
  }
  const area2 = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a; };
  function offsetPoly(pts, d) {  // pts は ccw。外側へ d 膨らませる
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[(i + pts.length - 1) % pts.length], p1 = pts[i], p2 = pts[(i + 1) % pts.length];
      const nn = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dy / l, -dx / l]; };
      const n1 = nn(p0, p1), n2 = nn(p1, p2);
      let mx = n1[0] + n2[0], my = n1[1] + n2[1]; const ml = Math.hypot(mx, my);
      if (ml < 1e-6) { out.push([p1[0] + n1[0] * d, p1[1] + n1[1] * d]); continue; }
      mx /= ml; my /= ml; const c = Math.max(0.5, mx * n1[0] + my * n1[1]);
      out.push([p1[0] + mx * d / c, p1[1] + my * d / c]);
    }
    return out;
  }
  function earclip(pts) {  // pts: ccw の単純多角形 -> 三角形の添字
    const idx = pts.map((_, i) => i), tris = [];
    const inTri = (p, a, b, c) => {
      const d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
      const d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]);
      const d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    };
    let guard = 0;
    while (idx.length > 3 && guard++ < 5000) {
      let found = false;
      for (let i = 0; i < idx.length; i++) {
        const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
        const A = pts[a], B = pts[b], Cc = pts[c];
        if ((B[0] - A[0]) * (Cc[1] - A[1]) - (B[1] - A[1]) * (Cc[0] - A[0]) <= 1e-9) continue;
        let bad = false;
        for (const j of idx) { if (j === a || j === b || j === c) continue; if (inTri(pts[j], A, B, Cc)) { bad = true; break; } }
        if (bad) continue;
        tris.push([a, b, c]); idx.splice(i, 1); found = true; break;
      }
      if (!found) { tris.push([idx[idx.length - 1], idx[0], idx[1]]); idx.splice(0, 1); }
    }
    if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
    return tris;
  }
  // 多角形（局所 x, 北 y）を、three 座標で y0..y1 の角柱にして、pos/nor に追記する。戻り値は頂点数
  function pushPrism(pos, nor, pts, y0, y1, tx = 0, ty = 0) {
    const P = pts.map((p) => [p[0] + tx, p[1] + ty]);
    const T3 = earclip(P);
    let n = 0;
    const v = (x, y, yn, nx, ny, nz) => { pos.push(x, y, -yn); nor.push(nx, ny, nz); n++; };
    for (const [a, b, c] of T3) { v(P[a][0], y1, P[a][1], 0, 1, 0); v(P[b][0], y1, P[b][1], 0, 1, 0); v(P[c][0], y1, P[c][1], 0, 1, 0); }
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      const nx = dy / l, nz = -(-dx / l);  // 外向き法線（局所 (dy,-dx)/l）を three へ: z = -北
      v(a[0], y0, a[1], nx, 0, nz); v(b[0], y0, b[1], nx, 0, nz); v(b[0], y1, b[1], nx, 0, nz);
      v(a[0], y0, a[1], nx, 0, nz); v(b[0], y1, b[1], nx, 0, nz); v(a[0], y1, a[1], nx, 0, nz);
    }
    return n;
  }
  const VS = 'attribute vec4 aCol; varying vec4 vC; varying vec3 vN; void main(){ vC=aCol; vN=normal; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }';
  const FS = 'uniform float uOp; uniform float uGain; varying vec4 vC; varying vec3 vN; void main(){ float l=0.74+0.26*clamp(dot(normalize(vN),normalize(vec3(0.35,0.85,0.4))),0.0,1.0); gl_FragColor=vec4(vC.rgb*l*uGain, clamp(vC.a*uOp,0.0,1.0)); }';
  function makeMat(op, gain, side) {
    const m = new C.ShaderMat({ vertexShader: VS, fragmentShader: FS, uniforms: { uOp: { value: op }, uGain: { value: gain } }, transparent: true, depthWrite: false, depthTest: true });
    m.side = side == null ? 0 : side;
    return m;
  }
  function buildBuildings() {
    const B = D.scene.buildings, fit = D.fit.fit;
    const pos = [], nor = [], starts = [], counts = [], tops = [];
    for (let k = 0; k < B.length; k++) {
      const b = B[k];
      let pts = polyClean(b.poly);
      starts.push(pos.length / 3);
      if (pts.length < 3) { counts.push(0); tops.push(0); continue; }
      if (area2(pts) < 0) pts = pts.slice().reverse();
      let cx = 0, cy = 0; for (const p of pts) { cx += p[0]; cy += p[1]; } cx /= pts.length; cy /= pts.length;
      const gnd = GY(cx, cy), f = fit[b.id];
      const base = (f ? Math.min(f[0], gnd) : gnd) - 0.4;
      let top = f ? f[1] + 0.3 : gnd + b.h + 0.3;
      if (top < base + 2) top = base + 2;
      const og = offsetPoly(pts, 0.35);
      counts.push(pushPrism(pos, nor, og, base, top));
      tops.push(top);
    }
    const g = new C.BufGeo();
    g.setAttribute('position', new C.BufAttr(new Float32Array(pos), 3));
    g.setAttribute('normal', new C.BufAttr(new Float32Array(nor), 3));
    const col = new Float32Array((pos.length / 3) * 4);
    const ca = new C.BufAttr(col, 4); if (ca.setUsage) ca.setUsage(35048);
    g.setAttribute('aCol', ca);
    const mesh = new C.Mesh(g, makeMat(1, 1.0, 0));
    mesh.renderOrder = 8; mesh.frustumCulled = false; mesh.name = 'phys-buildings';
    overlayRoot.add(mesh);
    BLD = { mesh, starts, counts, col: ca.array, ca, tops, n: B.length };
    // 輪郭用: 屋上の外周（three 座標）
    BLD.rim = B.map((b, k) => {
      let pts = polyClean(b.poly); if (pts.length < 3) return [];
      if (area2(pts) < 0) pts = pts.slice().reverse();
      const og = offsetPoly(pts, 0.35), y = tops[k] + 0.05, arr = [];
      for (let i = 0; i < og.length; i++) { const a = og[i], c = og[(i + 1) % og.length]; arr.push(a[0], y, -a[1], c[0], y, -c[1]); }
      return arr;
    });
  }
  function paintBuildings(fn) {  // fn(k) -> [r,g,b,a]
    const col = BLD.col;
    for (let k = 0; k < BLD.n; k++) {
      const c = fn(k), s = BLD.starts[k], n = BLD.counts[k];
      for (let v = s; v < s + n; v++) { const o = v * 4; col[o] = c[0]; col[o + 1] = c[1]; col[o + 2] = c[2]; col[o + 3] = c[3]; }
    }
    BLD.ca.needsUpdate = true;
    BLD.mesh.visible = true;
  }

  // ------------------------------------------------------------ 輪郭・線（LineSegments2）
  const lineObjs = [];   // 管理して破棄するための一覧
  function makeLines(posArr, hex, width, opts = {}) {
    const g = new C.LGeo(); g.setPositions(posArr);
    const m = new C.LMat({ linewidth: width, worldUnits: false, transparent: !!opts.alpha, depthTest: opts.depthTest !== false });
    m.color.set(hex);
    if (opts.alpha != null) m.opacity = opts.alpha;
    m.resolution.set(K.renderer.domElement.width, K.renderer.domElement.height);
    if (opts.dash) { m.dashed = true; m.dashSize = opts.dash[0]; m.gapSize = opts.dash[1]; m.dashScale = 1; }
    const l = new C.LS2(g, m); l.frustumCulled = false; l.renderOrder = opts.order || 9;
    if (opts.dash) l.computeLineDistances();
    return l;
  }
  const dynGroup = () => { if (!dynGroup.g) { dynGroup.g = new C.Group(); overlayRoot.add(dynGroup.g); } return dynGroup.g; };
  function clearDyn() {
    const g = dynGroup(); while (g.children.length) {
      const o = g.children.pop(); if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose();
    }
    labels.length = 0; $('phys-labels').innerHTML = '';
  }
  function rimPositions(idxs) { const a = []; for (const k of idxs) { const r = BLD.rim[k]; for (let i = 0; i < r.length; i++) a.push(r[i]); } return a; }
  function addRim(idxs, hex, width) {
    if (!idxs.length) return; const p = rimPositions(idxs); if (!p.length) return;
    dynGroup().add(makeLines(p, hex, width, { order: 10 }));
  }
  // 小さな八面体（スピーカー・受音点・鏡像）。色は rgba
  function addOcta(list, rgba, mat) {
    const pos = [], nor = [];
    for (const o of list) {
      const [x, y, z, r] = o;
      const P = [[x + r, y, z], [x - r, y, z], [x, y + r, z], [x, y - r, z], [x, y, z + r], [x, y, z - r]];
      const F = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]];
      for (const f of F) {
        const a = P[f[0]], b = P[f[1]], c = P[f[2]];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0]; const l = Math.hypot(nx, ny, nz) || 1;
        for (const p of [a, b, c]) { pos.push(p[0], p[1], p[2]); nor.push(nx / l, ny / l, nz / l); }
      }
    }
    const g = new C.BufGeo(); g.setAttribute('position', new C.BufAttr(new Float32Array(pos), 3)); g.setAttribute('normal', new C.BufAttr(new Float32Array(nor), 3));
    const col = new Float32Array(pos.length / 3 * 4); for (let i = 0; i < col.length; i += 4) { col[i] = rgba[0]; col[i + 1] = rgba[1]; col[i + 2] = rgba[2]; col[i + 3] = rgba[3]; }
    g.setAttribute('aCol', new C.BufAttr(col, 4));
    const m = new C.Mesh(g, mat || makeMat(1, 1.0, 2)); m.renderOrder = 11; m.frustumCulled = false;
    dynGroup().add(m); return m;
  }

  // ------------------------------------------------------------ 色
  const lerp = (a, b, t) => a + (b - a) * t;
  const RAMP = [[0, [0.7, 0.75, 0.8, 0.0]], [0.5, [0.95, 0.95, 0.7, 0.08]], [1, [1.0, 0.93, 0.55, 0.38]], [3, [1.0, 0.70, 0.20, 0.62]], [6, [0.97, 0.40, 0.10, 0.72]], [10, [0.85, 0.12, 0.25, 0.80]], [15, [0.65, 0.08, 0.55, 0.84]], [20, [0.38, 0.14, 0.80, 0.90]]];
  function rampColor(v) {
    if (!(v > 0)) return RAMP[0][1].slice();
    for (let i = 1; i < RAMP.length; i++) if (v <= RAMP[i][0]) { const [a, ca] = RAMP[i - 1], [b, cb] = RAMP[i], t = (v - a) / (b - a); return ca.map((x, j) => lerp(x, cb[j], t)); }
    return RAMP[RAMP.length - 1][1].slice();
  }
  const STI_RANGE = 0.3;
  function divColor(d) {  // ΔSTI: 負 = 橙赤（聞き取りが落ちる）、正 = 青
    const a = Math.abs(d); if (a < 0.02) return [0.7, 0.75, 0.8, 0.02];
    const t = clamp((a - 0.02) / (STI_RANGE - 0.02), 0, 1), al = 0.15 + 0.7 * t;
    return d < 0 ? [lerp(1.0, 0.85, t), lerp(0.7, 0.15, t), lerp(0.3, 0.1, t), al] : [lerp(0.55, 0.1, t), lerp(0.8, 0.45, t), 1.0, al];
  }
  const GREEN = [0.0, 0.7, 0.5, 0.34], DIM = [0.8, 0.3, 0.2, 0.14], NEW_C = [0.83, 1.0, 0.23, 0.88], LOST_C = [1.0, 0.17, 0.6, 0.88];
  const cssRGBA = (c) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${Math.max(c[3], 0.25)})`;

  // ------------------------------------------------------------ 状態の適用
  const plan = () => T.plans[S.plan];
  const EP = () => E.plans[S.plan];
  const termKeys = () => TERMS.map((t) => t.k);
  const jaOf = (k) => (T.meta.effect_keys_ja && T.meta.effect_keys_ja[k]) || k;

  function webToggles(on) {  // web2 の既存表示（別の配置・別の評価）を、物理モード中は切る
    const ids = ['chk-status', 'chk-cands', 'chk-heat', 'chk-wave'];
    const ov = K.scene.getObjectByName('overlay');
    if (on) {
      if (!webToggles.vis) { webToggles.vis = []; ov.children.forEach((c) => { webToggles.vis.push([c, c.visible]); }); }
      if (!webToggles.saved) { webToggles.saved = {}; ids.forEach((i) => { webToggles.saved[i] = $(i).checked; }); }
      ids.forEach((i) => { const el = $(i); if (el.checked) { el.checked = false; if (el.onchange) el.onchange(); } });
      document.body.classList.add('phys-on');
      webToggles.vis.forEach(([c]) => { c.visible = false; });
    } else {
      document.body.classList.remove('phys-on');
      if (webToggles.vis) { webToggles.vis.forEach(([c, v]) => { c.visible = v; }); webToggles.vis = null; }
      if (webToggles.saved) { ids.forEach((i) => { const el = $(i); const v = webToggles.saved[i]; if (el.checked !== v) { el.checked = v; if (el.onchange) el.onchange(); } }); webToggles.saved = null; }
    }
  }

  function speakerMarkers() {  // 選んだ配置のスピーカーを自前で描く（web2 の配置とは別）
    const P = plan(), list = [], poles = [];
    for (const s of P.speakers) {
      const g = GY(s.x, s.y);
      list.push([s.x, g + s.z, -s.y, 4.5]); poles.push(s.x, g, -s.y, s.x, g + s.z, -s.y);
    }
    addOcta(list.map((o) => [o[0], o[1], o[2], 10]), [1.0, 0.85, 0.2, 1.0]);
    if (poles.length) dynGroup().add(makeLines(poles, "#ffd633", 4, { order: 10 }));
    const rc = P.receivers || [];
    if (rc.length) {
      const idByIdx = new Map(D.scene.buildings.map((b, i) => [b.id, i]));
      const ro = []; for (const id of rc) { const k = idByIdx.get(id); if (k == null) continue; ro.push([T.buildings.cx[k], BLD.tops[k] + 3, -T.buildings.cy[k], 2.6]); }
      addOcta(ro, [0.3, 0.9, 1.0, 1.0]);
    }
  }

  function termValues() {  // 現在の項の建物ごとの値（効き dB。cov は 0/1。sti は Δ）
    const P = plan();
    if (S.term === 'sti') return P.delta_sti_vs_all[S.stiVar];
    if (S.term === 'cov') return P.covered.all;
    return P.effect_db[S.term];
  }
  function paintTerms() {
    const P = plan(), vals = termValues(), strong = [], strong2 = [];
    const cap = new Set((P.effect_unbounded_idx && P.effect_unbounded_idx[S.term]) || []);
    if (S.term === 'cov') {
      paintBuildings((k) => (vals[k] ? GREEN : [1.0, 0.3, 0.1, 0.45]));
      for (let k = 0; k < BLD.n; k++) if (!vals[k]) strong.push(k);
    } else if (S.term === 'sti') {
      paintBuildings((k) => (vals[k] == null ? [0.5, 0.5, 0.5, 0.03] : divColor(vals[k])));
      for (let k = 0; k < BLD.n; k++) { const v = vals[k]; if (v != null && Math.abs(v) >= 0.1) strong.push(k); if (v != null && Math.abs(v) >= 0.2) strong2.push(k); }
    } else {
      paintBuildings((k) => (cap.has(k) ? RAMP[RAMP.length - 1][1] : rampColor(vals[k])));
      for (let k = 0; k < BLD.n; k++) { const v = vals[k]; if (v >= 3) strong.push(k); if (v >= 10) strong2.push(k); }
    }
    clearDyn();
    addRim(strong, S.term === 'cov' ? '#ff7a3a' : '#ffffff', S.term === 'cov' ? 1.6 : 2.2);
    addRim(strong2, '#ffffff', 4);
    speakerMarkers();
  }
  // 階段
  function stepCov(i) { return plan().ladder[STEPS[i].k]; }
  function stepStats(i) {
    const a = stepCov(i), c = STEPS[i].cmp, b = c ? plan().ladder[c] : null; let n = 0, gain = 0, lost = 0;
    for (let k = 0; k < BLD.n; k++) { if (a[k]) n++; if (b) { if (a[k] && !b[k]) gain++; if (!a[k] && b[k]) lost++; } }
    return { n, gain, lost, cmp: c ? STEPS[stepIdx(c)] : null };
  }
  function paintLadder() {
    const a = stepCov(S.step), c = STEPS[S.step].cmp, b = c ? plan().ladder[c] : null, gain = [], lost = [];
    paintBuildings((k) => {
      if (!b) return a[k] ? GREEN : DIM;
      if (a[k] && !b[k]) { gain.push(k); return NEW_C; }
      if (!a[k] && b[k]) { lost.push(k); return LOST_C; }
      return a[k] ? GREEN : DIM;
    });
    clearDyn(); addRim(gain, '#e8ff5a', 3.5); addRim(lost, '#ff3da0', 3.5); speakerMarkers();
  }

  // ------------------------------------------------------------ 経路ビュー
  const labels = [];
  const repOf = (code) => PA.representatives.find((r) => r.code === code);
  const idIndex = () => { if (!idIndex.m) idIndex.m = new Map(D.scene.buildings.map((b, i) => [b.id, i])); return idIndex.m; };
  function pathsForShow(r) {
    const arr = r.paths.map((p, i) => ({ p, i }));
    return arr.filter(({ p }) => S.showOther || p.nearest_speaker);
  }
  function chosenPaths(r) {  // 描く経路: 合計に入るものを大きい順に 12 本まで + 遮られた直線 + 地面
    const inMain = pathsForShow(r).filter(({ p }) => p.in_main_total).sort((a, b) => b.p.level_db - a.p.level_db).slice(0, 12);
    const extra = pathsForShow(r).filter(({ p }) => !p.in_main_total && (p.kind === 'direct_blocked_line' ? p.nearest_speaker : true)).slice(0, 3);
    return inMain.concat(extra);
  }
  function pathPoint(p, t) {  // 経路長で t (0..1) の位置（three）
    const V = p.vertices.map((v) => toThree(v[0], v[1], v[2]));
    let tot = 0; const seg = []; for (let i = 0; i < V.length - 1; i++) { const l = Math.hypot(V[i + 1][0] - V[i][0], V[i + 1][1] - V[i][1], V[i + 1][2] - V[i][2]); seg.push(l); tot += l; }
    let d = t * tot; for (let i = 0; i < seg.length; i++) { if (d <= seg[i] || i === seg.length - 1) { const u = seg[i] ? d / seg[i] : 0; return [lerp(V[i][0], V[i + 1][0], u), lerp(V[i][1], V[i + 1][1], u), lerp(V[i][2], V[i + 1][2], u)]; } d -= seg[i]; }
    return V[0];
  }
  function paintPaths() {
    const r = repOf(S.rcv); if (!r) return;
    const idx = idIndex(), P = plan();
    const hi = new Map();  // k -> color
    const blockers = new Set(), walls = new Set();
    const chosen = chosenPaths(r);
    for (const { p } of chosen) { (p.blockers || []).forEach((id) => { if (p.kind === 'direct_blocked_line' || p.kind === 'diff_roof' || p.kind.startsWith('diff')) blockers.add(idx.get(id)); }); (p.walls || []).forEach((w) => walls.add(w.building_index != null ? w.building_index : idx.get(w.building_id))); }
    // 遮る建物は、最寄りスピーカーの直接系の blockers に絞る（回折の経路にも同じ建物が並ぶため、全部は塗らない）
    const bl2 = new Set(); for (const { p } of chosen) if (p.kind === 'direct_blocked_line') (p.blockers || []).forEach((id) => bl2.add(idx.get(id)));
    paintBuildings((k) => {
      if (k === r.building_index) return [1, 1, 1, 0.75];
      if (walls.has(k)) return [1.0, 0.45, 0.7, 0.34];
      if (bl2.has(k)) return [0.95, 0.2, 0.15, 0.5];
      return [0.7, 0.75, 0.8, 0.07];
    });
    clearDyn();
    addRim([...bl2].filter((k) => k != null), '#ff4a3a', 3.5); addRim([...walls].filter((k) => k != null), '#ff7fc0', 3.5); addRim([r.building_index], '#ffffff', 4);
    // 経路
    chosen.forEach(({ p, i }) => {
      const kd = KIND[p.kind] || { c: '#fff', ja: p.kind, short: p.kind, dash: false };
      const V = p.vertices.map((v) => toThree(v[0], v[1], v[2]));
      const seg = []; for (let j = 0; j < V.length - 1; j++) seg.push(...V[j], ...V[j + 1]);
      const near = p.nearest_speaker;
      const l = makeLines(seg, kd.c, kd.dash ? 3.5 : (near ? 5 : 3), { order: 12, depthTest: false, alpha: kd.dash ? 0.95 : 1, dash: kd.dash ? [3, 3] : null });
      dynGroup().add(l);
      // 頂点の印
      const mk = []; for (let j = 1; j < V.length - 1; j++) mk.push([V[j][0], V[j][1], V[j][2], 1.6]);
      if (mk.length) addOcta(mk, hex2rgba(kd.c, 1));
      // ラベル
      const mid = pathPoint(p, 0.5 + 0.06 * (i % 4));
      const txt = p.level_db == null ? `${kd.short}（合計に入らない） 発音から ${fmt(p.delay_ms)} ms` : `${kd.short} ${fmt(p.level_db, 1)} dB ・ 発音から ${fmt(p.delay_ms)} ms`;
      addLabel(mid, txt, kd.c);
    });
    // スピーカー・受音点
    const spk = new Map(); chosen.forEach(({ p }) => spk.set(p.speaker.cand_index, p.speaker));
    const so = []; spk.forEach((s) => so.push([s.x, GY(s.x, s.y) + s.z, -s.y, 4.5]));
    addOcta(so, [1.0, 0.85, 0.2, 1]);
    const poles = []; spk.forEach((s) => { const g = GY(s.x, s.y); poles.push(s.x, g, -s.y, s.x, g + s.z, -s.y); });
    if (poles.length) dynGroup().add(makeLines(poles, "#ffd633", 4, { order: 10 }));
    spk.forEach((s) => addLabel([s.x, GY(s.x, s.y) + s.z + 7, -s.y], `スピーカー ${s.cand_index}`, '#ffd633'));
    const rv = toThree(r.receiver[0], r.receiver[1], r.receiver[2]);
    addOcta([[rv[0], rv[1], rv[2], 2.2]], [1, 1, 1, 1]);
    addLabel([rv[0], rv[1] + 6, rv[2]], `受音点（外壁の 1 点、高さ ${T.buildings.receiver_height_m} m）`, '#ffffff');
  }
  const hex2rgba = (h, a) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a];
  function addLabel(p3, text, color) {
    const el = document.createElement('div'); el.className = 'phl'; el.textContent = text; el.style.borderColor = color; $('phys-labels').appendChild(el);
    labels.push({ el, p: p3, w: 0, h: 22 });
  }

  // ------------------------------------------------------------ 検算ビュー（街の外れの空き地）
  const PROOF_OFF = { x: 0, y: -760 };
  function proofGround() { return GY(0, -470); }
  function paintProof() {
    const ex = PW.examples[S.proof]; if (!ex) return;
    BLD.mesh.visible = false; clearDyn();
    const gy = proofGround(), ox = PROOF_OFF.x, oy = PROOF_OFF.y;
    const P3 = (x, yn, z) => [x + ox, gy + z, -(yn + oy)];
    // 地面の格子（描く範囲）
    const ext = proofExtent(ex), g = [];
    for (let x = Math.ceil(ext.x0 / 10) * 10; x <= ext.x1; x += 10) g.push(...P3(x, ext.y0, 0), ...P3(x, ext.y1, 0));
    for (let y = Math.ceil(ext.y0 / 10) * 10; y <= ext.y1; y += 10) g.push(...P3(ext.x0, y, 0), ...P3(ext.x1, y, 0));
    dynGroup().add(makeLines(g, '#6f8294', 1, { order: 9, alpha: 0.5 }));
    // 壁（長さは切り取って描く）
    const pos = [], nor = [], col = [];
    ex.walls.forEach((w) => {
      const pts = w.polygon.map((p) => [clamp(p[0], ext.x0, ext.x1), p[1]]);
      let q = pts; if (area2(q) < 0) q = q.slice().reverse();
      const n = pushPrism(pos, nor, q, gy, gy + Math.min(w.height_m, 100), ox, oy);
      for (let i = 0; i < n; i++) col.push(0.75, 0.8, 0.9, 0.32);
    });
    const gm = new C.BufGeo(); gm.setAttribute('position', new C.BufAttr(new Float32Array(pos), 3)); gm.setAttribute('normal', new C.BufAttr(new Float32Array(nor), 3)); gm.setAttribute('aCol', new C.BufAttr(new Float32Array(col), 4));
    const wm = new C.Mesh(gm, makeMat(1, 1.0, 2)); wm.renderOrder = 8; wm.frustumCulled = false; dynGroup().add(wm);
    // 経路・鏡像
    const sp = ex.speaker, rc = ex.receiver;
    const Ls = (pts, hex, w, dash, alpha) => { const a = []; for (let i = 0; i < pts.length - 1; i++) a.push(...pts[i], ...pts[i + 1]); dynGroup().add(makeLines(a, hex, w, { order: 12, depthTest: false, dash: dash || null, alpha: alpha == null ? 1 : alpha })); };
    const pv = (v) => P3(v[0], v[1], v[2]);
    addOcta([[...P3(sp[0], sp[1], sp[2]), 3]], [1, 0.85, 0.2, 1]); addLabel(P3(sp[0], sp[1], sp[2] + 6), 'スピーカー S', '#ffd633');
    addOcta([[...P3(rc[0], rc[1], rc[2]), 2.4]], [1, 1, 1, 1]); addLabel(P3(rc[0], rc[1], rc[2] + 6), '受音点 R', '#ffffff');
    const items = [];
    ex.paths.forEach((p, i) => {
      const kd = KIND[p.kind] || KIND.reflect1;
      if (p.kind === 'direct_los') { Ls([pv(sp), pv(rc)], kd.c, 3.5, [3, 3]); addLabel(lerp3(pv(sp), pv(rc), 0.5), `直接 ${fmt(p.level_db_code, 2)} dB（比較用）`, kd.c); return; }
      const V = (p.vertices_analytic || []).map(pv);
      Ls(V, kd.c, 5);
      const refl = p.kind === 'reflect1' ? [p.reflection_point_analytic] : [p.P1_analytic, p.P2_analytic];
      refl.forEach((q, j) => { addOcta([[...pv(q), 1.8]], hex2rgba(kd.c, 1)); addLabel(pv([q[0], q[1], q[2] + 3.5]), `反射点${refl.length > 1 ? j + 1 : ''} (${fmt(q[0], 2)}, ${fmt(q[1], 2)}, ${fmt(q[2], 2)})`, kd.c); });
      // 鏡像（壁面 y = 一定）
      const images = mirrorImages(sp, p);
      images.forEach((im, j) => { addOcta([[...pv(im), 2.6]], hex2rgba(kd.c, 0.35)); addLabel(pv([im[0], im[1], im[2] - 6]), `鏡像 S${"'".repeat(j + 1)}${p.wall ? '（' + p.wall + '）' : (p.kind === 'reflect2' ? '（経路 ' + (ex.paths.filter((q, k) => q.kind === 'reflect2' && k <= i).length) + '）' : '')}`, kd.c); });
      if (images.length) Ls([pv(images[images.length - 1]), pv(rc)], kd.c, 2.5, [2, 3], 0.9);
      items.push(p);
    });
  }
  const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  function mirrorImages(sp, p) {  // 壁面が y = 一定の例（検算の 3 例とも）: 反射点の y が壁面
    const pts = p.kind === 'reflect1' ? [p.reflection_point_analytic] : [p.P1_analytic, p.P2_analytic];
    let cur = sp.slice(); const out = [];
    for (const q of pts) { cur = [cur[0], 2 * q[1] - cur[1], cur[2]]; out.push(cur); }
    return out;
  }
  function proofExtent(ex) {
    const all = [ex.speaker, ex.receiver]; ex.paths.forEach((p) => { (p.vertices_analytic || []).forEach((v) => all.push(v)); });
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; all.forEach((v) => { x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]); });
    ex.paths.forEach((p) => { if (p.kind !== 'direct_los') mirrorImages(ex.speaker, p).forEach((v) => all.push(v)); });
    all.forEach((v) => { x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]); });
    ex.walls.forEach((w) => w.polygon.forEach((p) => { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }));
    return { x0: x0 - 30, x1: x1 + 30, y0: y0 - 10, y1: y1 + 10 };
  }

  // ------------------------------------------------------------ カメラ
  let tw = null;
  const ease = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
  function poseOrbit(az, el, dist, tx, ty, tz) {  // az: 度（0 = +x 方向から、反時計）, el: 度
    const a = az * Math.PI / 180, e = el * Math.PI / 180;
    const t = V3(tx, ty, tz), p = V3(tx + Math.cos(a) * Math.cos(e) * dist, ty + Math.sin(e) * dist, tz - Math.sin(a) * Math.cos(e) * dist);
    return { p, t };
  }
  function poseFor(kind, arg) {
    if (kind === 'overview' || kind === 'top' || kind === 'street' || kind === 'speaker') return K.PRE[kind];
    if (kind === 'terms') { return poseOrbit(200, 36, 880, 0, 20, -10); }
    if (kind === 'recv') {
      const r = repOf(arg), chosen = chosenPaths(r), rv = toThree(r.receiver[0], r.receiver[1], r.receiver[2]);
      let sx = 0, sy = 0, sw = 0; chosen.forEach(({ p }) => { if (p.in_main_total) { const w = Math.pow(10, p.level_db / 10); sx += p.speaker.x * w; sy += p.speaker.y * w; sw += w; } });
      if (!sw) { chosen.forEach(({ p }) => { sx += p.speaker.x; sy += p.speaker.y; sw += 1; }); }
      if (!sw) { const sp = PA.meta.speakers.find((q) => q.cand_index === r.nearest_speaker_cand); if (sp) { sx = sp.x; sy = sp.y; sw = 1; } }
      if (!sw) { sx = r.receiver[0] + 60; sy = r.receiver[1]; sw = 1; }
      sx /= sw; sy /= sw;
      const sv = toThree(sx, sy, 0), dx = sv[0] - rv[0], dz = sv[2] - rv[2], dist = Math.hypot(dx, dz) || 80;
      let px = -dz / dist, pz = dx / dist; if (pz < 0) { px = -px; pz = -pz; }   // 経路の断面が見える向き（南側から）
      const R = clamp(dist * 1.9, 140, 520), el = 28 * Math.PI / 180, mx = (rv[0] + sv[0]) / 2, mz = (rv[2] + sv[2]) / 2;
      return { p: V3(mx + px * R * Math.cos(el), rv[1] + 14 + R * Math.sin(el), mz + pz * R * Math.cos(el)), t: V3(lerp(mx, rv[0], 0.12), rv[1] + 10, lerp(mz, rv[2], 0.12)) };
    }
    if (kind === 'proof') {
      const ex = PW.examples[arg], e = proofExtent(ex), gy = proofGround();
      const cx = (e.x0 + e.x1) / 2 + PROOF_OFF.x, cyn = (e.y0 + e.y1) / 2 + PROOF_OFF.y, ext = Math.max(e.x1 - e.x0, e.y1 - e.y0);
      return poseOrbit(250, 38, ext * 1.05, cx, gy + 4, -cyn);
    }
    return K.PRE.overview;
  }
  function camSet(pose) { K.setPose({ p: pose.p, t: pose.t }); }
  function camLerp(a, b, u, easeOn = true) {
    const e = easeOn ? ease(clamp(u, 0, 1)) : clamp(u, 0, 1);
    const p = V3(0, 0, 0).lerpVectors(a.p, b.p, e), t = V3(0, 0, 0).lerpVectors(a.t, b.t, e);
    p.y += Math.sin(Math.PI * e) * 0.1 * a.p.distanceTo(b.p);
    camSet({ p, t });
  }
  function camTo(pose, dur = 1600) {
    if (dur <= 0) { camSet(pose); tw = null; return; }
    tw = { a: { p: K.camera.position.clone(), t: K.controls.target.clone() }, b: pose, s: performance.now(), dur };
  }

  // ------------------------------------------------------------ 画面の部品
  const ui = {};
  function buildUI() {
    const vb = $('viewbox') || $('stage');
    const note = document.createElement('div'); note.id = 'phys-note';
    const al = TH.alpha, bg = TH.background_db, lv = TH.level_db, sti = TH.sti;
    note.innerHTML = `モデルの計算値。<b>実測との比較は無い。</b>2 次までの反射、1 kHz 単一帯域の STI 風の指標、吸音率 ${al}、背景 ${bg} dB、しきい値（${lv} dB かつ STI 風 ${sti}）などは仮定。`;
    vb.appendChild(note);
    const lab = document.createElement('div'); lab.id = 'phys-labels'; vb.appendChild(lab);
    const pn = document.createElement('div'); pn.id = 'phys-panel';
    pn.innerHTML = '<div id="phys-head"><span>物理の層</span><span class="sp"></span><span id="phys-tabs"></span><button id="phys-fold" title="畳む">▼</button></div><div id="phys-body"></div>';
    vb.appendChild(pn);
    const tm = document.createElement('div'); tm.id = 'phys-time'; tm.className = 'hidden'; vb.appendChild(tm);
    ui.panel = pn; ui.body = $('phys-body'); ui.tabs = $('phys-tabs'); ui.time = tm;
    ui.tabs.innerHTML = [['terms', '項ごと'], ['ladder', '階段'], ['paths', '経路'], ['proof', '検算'], ['off', '元の表示']].map(([m, n]) => `<button data-mode="${m}">${n}</button>`).join('');
    ui.panel.addEventListener('click', onClick);
    ui.panel.addEventListener('change', onChange);
    $('phys-fold').onclick = () => { S.fold = !S.fold; ui.panel.classList.toggle('fold', S.fold); $('phys-fold').textContent = S.fold ? '▲' : '▼'; };
  }
  function onClick(e) {
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset;
    if (d.mode) api.setMode(d.mode);
    else if (d.term) api.setTerm(d.term);
    else if (d.plan) api.setPlan(d.plan);
    else if (d.step != null && d.step !== '') api.setStep(+d.step);
    else if (d.act === 'play') api.play(!S.play);
    else if (d.rcv) api.selectReceiver(d.rcv);
    else if (d.proof != null && d.proof !== '') api.setProof(+d.proof);
    else if (d.stivar) api.setStiVar(d.stivar);
    else if (d.act === 'other') { S.showOther = !S.showOther; api.update(true); }
  }
  function onChange(e) { /* 現在 select は使わない */ }

  const planBtns = () => `<div class="row">配置: <button data-plan="new" class="${S.plan === 'new' ? 'on' : ''}">新配置（${T.plans.new.speakers.length} 本）</button><button data-plan="old" class="${S.plan === 'old' ? 'on' : ''}">旧配置（${T.plans.old.speakers.length} 本 + 受信機 ${T.plans.old.receivers.length} 台）</button></div>`;

  // 項ごとのパネル
  function legendCanvas(kind) {
    const w = 400, h = 42; const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d');
    g.fillStyle = '#26303a'; g.fillRect(0, 0, w, h);
    const L = 30, R = w - 14, W = R - L;
    if (kind === 'sti') {
      for (let x = 0; x < W; x++) { const d = (x / W - 0.5) * 2 * STI_RANGE; g.fillStyle = cssRGBA(divColor(d)); g.fillRect(L + x, 4, 1, 16); }
      g.fillStyle = '#fff'; g.font = '14px sans-serif'; g.fillText(`−${STI_RANGE}`, L - 4, 36); g.fillText('0', L + W / 2 - 4, 36); g.fillText(`+${STI_RANGE}`, R - 30, 36);
    } else {
      const maxv = 20;
      for (let x = 0; x < W; x++) { g.fillStyle = cssRGBA(rampColor(x / W * maxv)); g.fillRect(L + x, 4, 1, 16); }
      g.fillStyle = '#fff'; g.font = '14px sans-serif';
      [0, 1, 3, 10, 20].forEach((v) => { const x = L + v / maxv * W; g.fillRect(x, 20, 1, 4); g.fillText(v === 20 ? '20 dB 以上' : String(v), v === 20 ? x - 62 : x - 3, 37); });
    }
    return cv;
  }
  function termsPanel() {
    const P = plan(), ep = EP(), ek = ep.terms[S.term];
    let h = planBtns();
    h += '<div class="row">' + TERMS.map((t) => `<button data-term="${t.k}" class="${S.term === t.k ? 'on' : ''}">${t.ja}</button>`).join('') + '</div>';
    if (S.term === 'sti') h += '<div class="row">比べる条件: ' + STI_VARS.map((v) => `<button data-stivar="${v.k}" class="${S.stiVar === v.k ? 'on' : ''}">${v.ja}</button>`).join('') + '</div>';
    h += '<div id="phys-legend"></div>';
    h += termsStats();
    return h;
  }
  function verdictOf(f3, n3) {  // 語の境目は、この表示の自前の決め（画面にも書く）
    const pc = `効きが 3 dB 以上は ${fmt(n3)} 棟、${fmt(f3 * 100, 1)}%`;
    if (f3 < 0.01) return ['v-none', `ほぼ効いていない（${pc}）`];
    if (f3 < 0.10) return ['v-few', `少数の建物にだけ効く（${pc}）`];
    if (f3 < 0.25) return ['v-some', `一部の建物に効く（${pc}）`];
    return ['v-wide', `広く効く（${pc}）`];
  }
  function termsStats() {
    const P = plan(), N = BLD.n;
    if (S.term === 'sti') return stiStats();
    if (S.term === 'cov') {
      const c = P.covered.all; let n = 0; c.forEach((v) => { n += v ? 1 : 0; });
      return `<div class="verdict v-wide">聞こえる ${fmt(n)} / ${fmt(N)} 棟（最終判定: ${TH.level_db} dB 以上かつ STI 風 ${TH.sti} 以上）</div><p class="small">緑 = 聞こえる。聞こえない建物は朱色の輪郭。色は「その項の効き」ではなく、最終判定です。</p>`;
    }
    const ek = EP().terms[S.term], a = ek.subsets.all, dc = ek.decision_changes, rc = ek.reach_ge3db;
    const add = ek.effect_kind === 'add';
    const [vc, vt] = verdictOf(a.frac_ge3, a.ge3);
    let h = `<div class="verdict ${vc}">${esc(ek.name_ja)}: ${vt}</div>`;
    h += `<table><tr><th>効き</th><th class="n">棟数</th><th class="n">全 ${fmt(N)} 棟に対して</th></tr>`
      + `<tr><td>1 dB 以上</td><td class="n">${fmt(a.ge1)}</td><td class="n">${fmt(a.frac_ge1 * 100, 1)}%</td></tr>`
      + `<tr><td>3 dB 以上</td><td class="n">${fmt(a.ge3)}</td><td class="n">${fmt(a.frac_ge3 * 100, 1)}%</td></tr>`
      + `<tr><td>10 dB 以上</td><td class="n">${fmt(a.ge10)}</td><td class="n">${fmt(a.frac_ge10 * 100, 1)}%</td></tr>`
      + `<tr><td>最大 / 中央値</td><td class="n" colspan="2">${fmt(a.max, 2)} dB / ${fmt(a.median, 2)} dB${ek.n_unbounded_capped_at_60 ? `（${ek.n_unbounded_capped_at_60} 棟は 60 dB 頭打ち）` : ''}</td></tr></table>`;
    h += `<table><tr><td>${add ? '足して初めて聞こえる棟' : '取り除くと聞こえなくなる棟'}</td><td class="n"><b>${fmt(dc.needed)}</b> 棟</td></tr>`
      + `<tr><td>${add ? '足すと聞こえなくなる棟' : '取り除くと初めて聞こえる棟（STI 風が単調でないため）'}</td><td class="n">${fmt(dc.harmful)} 棟</td></tr></table>`;
    if (rc && rc.n) h += `<p class="small">効きが 3 dB 以上の ${fmt(rc.n)} 棟は、最寄りスピーカーから 50% が ${fmt(rc.nearest_dist_p50_m)} m 以内、90% が ${fmt(rc.nearest_dist_p90_m)} m 以内、最大 ${fmt(rc.nearest_dist_max_m)} m。最寄りへの遮蔽の深さは中央値 ${fmt(rc.shield_p50_db, 1)} dB（最小 ${fmt(rc.shield_min_db, 1)} dB）。見通しの棟は ${fmt(rc.n_los_nearest)}。</p>`;
    h += `<canvas id="phys-c1" width="432" height="104"></canvas><canvas id="phys-c2" width="432" height="104"></canvas>`;
    const capDb = ek.by_shield_depth_5db[ek.by_shield_depth_5db.length - 1].hi_db;
    h += `<p class="small">語の境目は自前の決め: 3 dB 以上が 1% 未満=ほぼ無し、10% 未満=少数、25% 未満=一部、以上=広く。</p>`;
    h += `<p class="small">距離は配置（スピーカー ${T.plans[S.plan].speakers.length} 本）の中での分布で、物理の限界ではない。遮蔽の深さ = 最寄りスピーカーの自由空間レベル − 直接音のモデル値（0〜${fmt(capDb)} dB、${fmt(capDb)} は仮定の上限）。</p>`;
    return h;
  }
  function stiStats() {
    const P = plan(), d = P.delta_sti_vs_all[S.stiVar], cv = P.covered, cvv = cv[S.stiVar], N = BLD.n;
    let n05 = 0, n10 = 0, n20 = 0, neg = 0, pos = 0, lost = 0, gain = 0, mn = 1, mx = -1;
    for (let k = 0; k < N; k++) { const v = d[k]; if (v == null) continue; const a = Math.abs(v); if (a >= 0.05) n05++; if (a >= 0.1) n10++; if (a >= 0.2) n20++; if (v <= -0.05) neg++; if (v >= 0.05) pos++; mn = Math.min(mn, v); mx = Math.max(mx, v); if (cv.all[k] && !cvv[k]) lost++; if (!cv.all[k] && cvv[k]) gain++; }
    const vj = STI_VARS.find((x) => x.k === S.stiVar).ja;
    return `<div class="verdict v-some">聞き取りやすさ（STI 風）の変化: 「${vj}」と ΔSTI が ±0.1 以上の建物は ${fmt(n10)} 棟（${fmt(n10 / N * 100, 1)}%）</div>`
      + `<table><tr><td>|ΔSTI| 0.05 以上 / 0.1 以上 / 0.2 以上</td><td class="n">${fmt(n05)} / ${fmt(n10)} / ${fmt(n20)} 棟</td></tr>`
      + `<tr><td>下がる（−0.05 以下）/ 上がる（+0.05 以上）</td><td class="n">${fmt(neg)} / ${fmt(pos)} 棟</td></tr>`
      + `<tr><td>最小 / 最大</td><td class="n">${fmt(mn, 2)} / ${fmt(mx, 2)}</td></tr>`
      + `<tr><td>この条件で 聞こえる→聞こえない / 聞こえない→聞こえる</td><td class="n">${fmt(lost)} / ${fmt(gain)} 棟</td></tr></table>`
      + `<p class="small">ΔSTI = 条件を変えたときの STI 風 − 主設定の STI 風。橙赤 = 聞き取りが落ちる、青 = 上がる。1 kHz 単一帯域の近似（IEC 60268-16 の STI ではない）。</p>`;
  }
  function drawBars(cv, rows, title) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height; g.clearRect(0, 0, W, H); g.fillStyle = '#0f151c'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#c6d1db'; g.font = '14px sans-serif'; g.fillText(title, 6, 14);
    const n = rows.length, L = 34, B = H - 34, Tp = 24, bw = (W - L - 8) / n;
    g.strokeStyle = '#46586b'; g.beginPath(); g.moveTo(L, Tp); g.lineTo(L, B); g.lineTo(W - 4, B); g.stroke();
    const maxv = Math.max(0.1, ...rows.map((r) => r.v)); const top = Math.min(1, Math.ceil(maxv * 10) / 10);
    g.fillStyle = '#c6d1db'; g.fillText(Math.round(top * 100) + '%', 2, Tp + 4); g.fillText('0', 18, B);
    rows.forEach((r, i) => {
      const x = L + i * bw + 3, h = (r.v / top) * (B - Tp);
      g.fillStyle = r.v >= 0.01 ? '#ffa347' : '#546475'; g.fillRect(x, B - h, bw - 6, h);
      g.fillStyle = '#fff'; g.font = '14px sans-serif'; g.fillText(`${Math.round(r.v * 100)}%`, x, B - h - 3);
      g.fillStyle = '#c6d1db'; g.fillText(r.l, x - 1, B + 13); g.fillStyle = '#8fa0b0'; g.fillText('n=' + r.n, x - 1, B + 26);
    });
  }
  function drawTermsCharts() {
    const lg = $('phys-legend');
    if (S.term === 'sti') { lg.innerHTML = ''; lg.appendChild(legendCanvas('sti')); const cp = document.createElement('div'); cp.className = 'small'; cp.textContent = 'ΔSTI = 条件を変えたときの変化。|ΔSTI| が 0.1 以上の建物は白い輪郭、0.2 以上は太い輪郭。'; lg.appendChild(cp); return; }
    if (S.term === 'cov') return;
    const ek = EP().terms[S.term]; const c1 = $('phys-c1'), c2 = $('phys-c2'); if (!c1 || !c2) return;
    drawBars(c1, ek.by_nearest_distance_50m.map((r) => ({ v: r.n ? r.n_ge3 / r.n : 0, l: `${r.lo_m}`, n: r.n })), '最寄りスピーカーまでの水平距離（m、50 m 刻み）別');
    drawBars(c2, ek.by_shield_depth_5db.map((r) => ({ v: r.n ? r.n_ge3 / r.n : 0, l: r.label.replace(/遮蔽なし.*/, '0').replace(/（上限.*/, '↑').replace('〜', '-'), n: r.n })), '最寄りへの直接音の遮蔽の深さ（dB）別');
    lg.innerHTML = ''; lg.appendChild(legendCanvas('ramp'));
    const cap = document.createElement('div'); cap.className = 'small'; cap.textContent = EP().terms[S.term].effect_kind === 'add' ? '色 = 足したときの増分 dB。無色 = 効いていない。3 dB 以上は白い輪郭。' : '色 = 取り除くと下がる dB。無色 = 効いていない。3 dB 以上は白い輪郭。'; lg.appendChild(cap);
  }
  function ladderPanel() {
    const N = BLD.n; let h = planBtns();
    h += `<div class="row"><button data-act="play" class="${S.play ? 'on' : ''}">${S.play ? '■ 停止' : '▶ 自動再生（1 段 2 秒）'}</button></div><div class="steps">`;
    STEPS.forEach((s, i) => { const st = stepStats(i); h += `<button data-step="${i}" class="${S.step === i ? 'on' : ''}"><span class="bar" style="width:${(st.n / N * 100).toFixed(1)}%"></span><span>${i + 1}. ${s.n}<b class="c">${fmt(st.n)} 棟</b></span></button>`; });
    h += '</div>';
    const st = stepStats(S.step), s = STEPS[S.step];
    h += `<h3>${S.step + 1}. ${s.n}</h3><p class="small">${esc(T.meta.ladder_stages[s.k])}</p>`;
    h += `<div class="verdict v-wide">聞こえる ${fmt(st.n)} / ${fmt(N)} 棟</div>`;
    h += `<p class="small"><span class="sw2" style="background:#00b380"></span>聞こえる　<span class="sw2" style="background:#cc4d33"></span>聞こえない（薄い赤茶）</p>`;
    if (st.cmp) h += `<table><tr><td>「${st.cmp.n}」と比べて</td><td class="n"><span class="sw2" style="background:#d4ff3a"></span>新たに聞こえる ${fmt(st.gain)} 棟</td></tr><tr><td></td><td class="n"><span class="sw2" style="background:#ff2d9a"></span>聞こえなくなる ${fmt(st.lost)} 棟</td></tr></table>`;
    else h += '<p class="small">最初の段（比較なし）。</p>';
    h += '<p class="small warn">階段は、単純に足していく列ではない（例: 3 段目は 2 段目より少ない）。各段は上の「〜と比べて」の段との差を示す。1 本ごとの判定と、全スピーカーの合成の判定は別物。</p>';
    if (S.plan === 'old') h += `<p class="small">旧配置の戸別受信機 ${T.plans.old.receivers.length} 台は、この階段には含めていない（スピーカーのみ）。</p>`;
    return h;
  }
  function pathsPanel() {
    const r = repOf(S.rcv);
    let h = `<p class="small">経路のデータは<b>${PA.meta.plan === 'new' ? '新配置' : '旧配置'}のみ</b>（paths.json）。</p>` + '<div class="row">' + PA.representatives.map((x) => `<button data-rcv="${x.code}" class="${S.rcv === x.code ? 'on' : ''}" title="${esc(x.title)}">${CODE_TITLE[x.code] || x.code}</button>`).join('') + '</div>';
    h += `<h3>${esc(r.title)}</h3><p>${esc(rcvExplain(r))}</p>`;
    h += `<p class="small">最寄りスピーカーまで ${fmt(r.nearest_dist_m, 1)} m。合計 ${fmt(r.total_level_db, 1)} dB（しきい値まで ${r.margin_vs_75db >= 0 ? '+' : ''}${fmt(r.margin_vs_75db, 1)} dB）、STI 風 ${fmt(r.sti_all, 2)}。経路は全体の割合 ${PA.meta.share_min} 以上のみ（列挙 ${fmt(r.summary.n_paths_enumerated_main)} 本、描画 ${chosenPaths(r).length} 本）。</p>`;
    h += `<div class="row"><button data-act="other" class="${S.showOther ? 'on' : ''}">他のスピーカーの経路も表示</button></div>`;
    h += `<h3>線の見方</h3><table>${['direct_los', 'direct_blocked_line', 'diff_roof', 'diff_edge_left', 'diff_edge_right', 'reflect1', 'reflect2', 'ground'].map((k) => `<tr><td><span class="sw2" style="background:${KIND[k].c}"></span>${KIND[k].ja}</td><td class="small">${KIND[k].dash ? '点線' : '実線'}</td></tr>`).join('')}</table>`;
    h += '<p class="small">太い線 = 最寄りのスピーカーの経路、細い線 = 他のスピーカー。遮る建物は赤、反射する壁は桃色の輪郭。経路の頂点の高さは、モデルの高さ（LOD1）を地面に足した位置で、画面の建物（LOD2）の屋根とは数 m ずれうる。</p>';
    return h;
  }
  function rcvExplain(r) {
    const k = r.building_index, P = T.plans[PA.meta.plan], sh = r.summary.by_kind_share, top = Object.entries(sh).sort((a, b) => b[1] - a[1])[0];
    const kn = top ? (KIND[top[0]] || {}).ja : '';
    const lv = P.level_db, cv = (v) => v == null ? '—' : fmt(v, 1);
    switch (r.code) {
      case '1_los': return `見通しがあり、直接音が全体の ${fmt(sh.direct_los * 100, 1)}% を占める。反射や回折はほぼ関係しない。`;
      case '2_roof': case '2_left': case '2_right': return `直接音は建物に遮られ、回折が主役。最大の寄与は「${kn}」（全体の ${fmt(top[1] * 100, 1)}%）。`;
      case '3_reflection_needed': return `直接音（合成）だけでは ${TH.level_db} dB に届かない（${cv(lv.direct_all[k])} dB）。反射を足した全体は ${cv(lv.total[k])} dB で聞こえる。`;
      case '4_second_order': return `2 次反射を取り除くと聞こえなくなる（全体 ${cv(lv.total[k])} dB、2 次反射なし: 聞こえる=${P.covered.wo_wall2[k] ? 'はい' : 'いいえ'}）。2 次反射が全体の ${fmt(sh.reflect2 * 100, 1)}%。`;
      case '5a_delay_speakers': return `音圧は足りる（${cv(r.total_level_db)} dB）が、複数スピーカーの到達の時間差で STI 風が ${fmt(r.sti_all, 3)} と、しきい値 ${TH.sti} を下回る。最強の 1 本だけなら ${fmt(r.sti_variants.strongest_only, 2)}、遅れを無視すれば ${fmt(r.sti_variants.no_delay, 2)}。`;
      case '5b_delay_reflections': return `音圧は足りる（${cv(r.total_level_db)} dB）が、反射の遅れで STI 風が ${fmt(r.sti_all, 3)}（しきい値 ${TH.sti}）。反射を除くと ${fmt(r.sti_variants.direct_only, 2)}。`;
      case '6_near_miss': return `どの項を足しても届かない（惜しい）。合計 ${cv(r.total_level_db)} dB。`;
      case '7_receiver_needed': return `スピーカーでは届かず、旧配置では戸別受信機が要る建物。`;
      case '8_ground': return `地面反射の増分が最大の建物（足したときの効き ${fmt(r.term_effect_db.ground, 2)} dB。主設定の合計には入れない項）。`;
      default: return '';
    }
  }
  function timePanel() {
    const r = repOf(S.rcv);
    ui.time.classList.remove('hidden');
    const sv = r.sti_variants, tl = r.term_level_db, te = r.term_effect_db;
    const names = { los: '見通し', roof: '屋根越え', left: '左エッジ', right: '右エッジ', wall1: '1次反射', wall2: '2次反射', ground: '地面（足す）' };
    let h = '<b>家での聞こえ方（届く時刻と大きさ）</b><canvas id="phys-tc" width="540" height="230"></canvas>';
    h += '<table><tr><th>項</th><td class="n">レベル</td><td class="n">効き（取り除く）</td></tr>';
    Object.keys(names).forEach((k) => {
      h += `<tr><td><span class="sw2" style="background:${termColor(k)}"></span>${names[k]}</td><td class="n">${tl[k] == null ? '—' : fmt(tl[k], 1) + ' dB'}</td><td class="n">${te[k] == null ? '—' : fmt(te[k], 1) + ' dB'}${k === 'ground' ? '（足す）' : ''}</td></tr>`;
    });
    h += `<tr><th>STI 風</th><td class="n" colspan="2">全項入り <b>${fmt(sv.all, 2)}</b> ／ 反射なし <b>${fmt(sv.direct_only, 2)}</b> ／ 最強の 1 本のみ <b>${fmt(sv.strongest_only, 2)}</b></td></tr></table>`;
    ui.time.innerHTML = h; drawTimeline(r);
  }
  const termColor = (k) => ({ los: KIND.direct_los.c, roof: KIND.diff_roof.c, left: KIND.diff_edge_left.c, right: KIND.diff_edge_right.c, wall1: KIND.reflect1.c, wall2: KIND.reflect2.c, ground: KIND.ground.c }[k]);
  function drawTimeline(r) {
    const cv = $('phys-tc'); if (!cv) return; const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    g.fillStyle = '#0f151c'; g.fillRect(0, 0, W, H);
    const ps = r.paths.filter((p) => p.in_main_total && p.level_db != null);
    g.font = '14px sans-serif';
    if (!ps.length) { g.fillStyle = '#ffd18a'; g.fillText('合計に入る経路がありません（描ける棒が無い）', 20, 100); return; }
    const top = ps.reduce((a, b) => (b.level_db > a.level_db ? b : a)), ref = top.delay_ms;
    const rel = (p) => p.delay_ms - ref;
    const mn = Math.min(0, ...ps.map(rel)), mx = Math.max(0, ...ps.map(rel));
    const step = (m) => (m <= 150 ? 25 : m <= 400 ? 100 : m <= 1000 ? 200 : 400);
    const xs = step(Math.max(mx, -mn)), xmax = Math.max(xs * 2, Math.ceil(mx / xs) * xs), xmin = Math.min(0, Math.floor(mn / xs) * xs);
    const lmax = Math.ceil((Math.max(...ps.map((p) => p.level_db)) + 1) / 10) * 10, lmin = Math.max(20, Math.floor(Math.min(...ps.map((p) => p.level_db)) / 10) * 10 - 10);
    const L = 44, R = W - 26, Tp = 62, B = H - 40, X = (ms) => L + (ms - xmin) / (xmax - xmin) * (R - L), Y = (db) => B - (db - lmin) / (lmax - lmin) * (B - Tp);
    const x50 = X(Math.min(50, xmax));
    g.fillStyle = 'rgba(55,214,122,0.16)'; g.fillRect(L, Tp, x50 - L, B - Tp); g.fillStyle = 'rgba(255,120,80,0.10)'; g.fillRect(x50, Tp, R - x50, B - Tp);
    for (let v = lmin; v <= lmax; v += 10) { g.fillStyle = '#c6d1db'; g.fillText(String(v), 12, Y(v) + 5); g.strokeStyle = '#26323e'; g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(R, Y(v)); g.stroke(); }
    g.strokeStyle = '#46586b'; g.beginPath(); g.moveTo(L, Tp); g.lineTo(L, B); g.lineTo(R, B); g.stroke();
    g.fillStyle = '#c6d1db'; for (let ms = Math.ceil(xmin / xs) * xs; ms <= xmax; ms += xs) g.fillText(String(ms), X(ms) - 10, B + 16);
    g.fillText('最も大きい音（太い白枠）からの遅れ（ms）　縦軸: dB', L, H - 6);
    g.setLineDash([4, 3]); g.strokeStyle = '#e8eef4'; g.beginPath(); g.moveTo(x50, Tp); g.lineTo(x50, B); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#9fe8bf'; g.fillText('緑: 最大の音の 50 ms 後までに届く = 聞き取りを助ける', 6, 30);
    g.fillStyle = '#ffb09a'; g.fillText('橙: それより遅れて重なる音 = 邪魔になる', 6, 48);
    g.fillStyle = '#8fa0b0'; g.fillText('50 ms は慣用の目安で、モデルの境界ではない', 6, 14);
    ps.forEach((p) => {
      const kd = KIND[p.kind]; g.fillStyle = kd.c; const x = X(rel(p)); g.fillRect(x - 2, Y(p.level_db), 5, B - Y(p.level_db));
      if (p === top) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(x - 3, Y(p.level_db) - 1, 7, B - Y(p.level_db) + 1); g.lineWidth = 1; }
      else if (p.nearest_speaker) { g.strokeStyle = 'rgba(255,255,255,0.7)'; g.strokeRect(x - 2.5, Y(p.level_db) - 0.5, 6, B - Y(p.level_db) + 0.5); }
    });
  }
  function wallDims(ex) {
    const L = ex.walls.map((w) => { const xs = w.polygon.map((p) => p[0]), ys = w.polygon.map((p) => p[1]); return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)); });
    const lo = Math.min(...L), hi = Math.max(...L), h = [...new Set(ex.walls.map((w) => w.height_m))];
    return `長さ ${fmt(lo)}${hi !== lo ? '〜' + fmt(hi) : ''} m、高さ ${h.map((v) => fmt(v)).join('・')} m`;
  }
  function proofPanel() {
    let h = '<div class="row">' + PW.examples.map((e, i) => `<button data-proof="${i}" class="${S.proof === i ? 'on' : ''}">${esc(e.name)}</button>`).join('') + '</div>';
    const ex = PW.examples[S.proof];
    h += `<p class="small">街の外れの空き地に、検算用の壁を置いて描いている（街の建物ではない）。壁は実際は${wallDims(ex)}で、図には一部だけを描く。</p>`;
    h += `<p class="small">解析 = 鏡像法の手計算（${esc(ex.analytic_method)}）。コード = echo3 の計算（arrivals）。レベルは吸音率 0 で比べている。</p>`;
    let worst = 99;
    ex.paths.forEach((p, i) => {
      const kd = KIND[p.kind] || KIND.reflect1;
      const dg = p.digits_agree || {}; const dgs = Object.entries(dg);
      dgs.forEach(([, v]) => { worst = Math.min(worst, v); });
      h += `<h3><span class="sw2" style="background:${kd.c}"></span>${p.wall ? p.wall + '：' : ''}${kd.ja}</h3><table>`;
      if (p.kind === 'direct_los') { h += `<tr><td>経路長（解析）</td><td class="n">${fmt(p.length_m_analytic, 6)} m</td></tr><tr><td>レベル 解析 / コード</td><td class="n">${fmt(p.level_db_analytic, 6)} / ${fmt(p.level_db_code, 6)} dB</td></tr>`; }
      else {
        const lc = p.length_m_geom_arrivals != null ? p.length_m_geom_arrivals : p.length_m_code_second_one;
        h += `<tr><td>経路長 解析 / コード</td><td class="n">${fmt(p.length_m_analytic, 8)} / ${fmt(lc, 8)} m</td></tr>`
          + `<tr><td>レベル 解析 / コード（α=0）</td><td class="n">${fmt(p.level_db_analytic_alpha0, 8)} / ${fmt(p.level_db_code_alpha0 != null ? p.level_db_code_alpha0 : p.level_db_geom_arrivals_alpha0, 8)} dB</td></tr>`;
        dgs.forEach(([k, v]) => { h += `<tr><td class="small">一致する桁: ${esc(k)}</td><td class="n" style="color:${v < 10 ? '#ff8a8a' : '#9fe8bf'}">${fmt(v, 1)} 桁</td></tr>`; });
      }
      h += '</table>';
    });
    const tt = ex.totals; if (tt) h += `<h3>合成</h3><table><tr><td>レベル 解析 / コード</td><td class="n">${fmt(tt.level_db_analytic_alpha0, 6)} / ${fmt(tt.level_db_code_alpha0, 6)} dB</td></tr><tr><td>エネルギーの一致</td><td class="n">${fmt(tt.digits_agree_energy, 1)} 桁</td></tr><tr><td>複素和 Z の最大相対差</td><td class="n">${tt.max_rel_diff_Z_code_vs_analytic.toExponential(2)}</td></tr></table>`;
    h += worst < 10 ? `<div class="verdict v-none">一致が崩れている（最小 ${fmt(worst, 1)} 桁）</div>` : `<p class="small">一致する桁は、相対差が 10<sup>−桁</sup> になる桁数で、16 が倍精度の限界。この 3 つの単純な配置での、式と実装の一致であり、音響モデルが実際の街で正しいことの確認ではない。</p>`;
    return h;
  }

  // ------------------------------------------------------------ 全体の更新
  let lastKey = '';
  function render() {
    if (!BLD) return;
    ui.tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
    ui.time.classList.add('hidden');
    if (S.mode === 'off') {
      webToggles(false); BLD.mesh.visible = false; clearDyn();
      ui.body.innerHTML = '<p>web2 本来の表示（右パネルの被覆は web2 の配置・別の評価）です。「項ごと」「階段」「経路」「検算」で、物理の層を重ねます。</p>';
      K.markDirty(true); return;
    }
    webToggles(true);
    if (S.mode === 'terms') { ui.body.innerHTML = termsPanel(); paintTerms(); drawTermsCharts(); }
    else if (S.mode === 'ladder') { ui.body.innerHTML = ladderPanel(); paintLadder(); }
    else if (S.mode === 'paths') { ui.body.innerHTML = pathsPanel(); paintPaths(); timePanel(); }
    else if (S.mode === 'proof') { ui.body.innerHTML = proofPanel(); paintProof(); }
    const wc = $('n-cov'); const wm = document.querySelector('[data-method].on');
    ui.body.insertAdjacentHTML('beforeend', (K.model === 'ext') ? `<p class="small phys-webnote" style="margin-top:10px;border-top:1px solid #2f3d4b;padding-top:6px">右の被覆パネル${wc ? '（' + esc(wc.textContent) + ' 棟）' : ''}は、拡張モデル（この層と同じ評価）の、web2 で選んだ配置${wm ? '（' + esc(wm.textContent) + '）' : ''}の数字です。この層の「新配置」は、予算 1,500・貪欲法 + 局所探索の配置（998 棟）です。地面の色の音圧は直接音＋回折のみです。</p>` : `<p class="small phys-webnote" style="margin-top:10px;border-top:1px solid #2f3d4b;padding-top:6px">右の被覆パネル${wc ? '（' + esc(wc.textContent) + ' 棟）' : ''}は、web2 本来の配置${wm ? '（' + esc(wm.textContent) + '）' : ''}と別の評価で、この層（${(S.mode === 'paths' ? PA.meta.plan : S.plan) === 'new' ? '新配置' : '旧配置'}、echo3 の評価）の数字とは別です。</p>`);
    K.markDirty(true);
    updateLabels();
  }
  // ラベルの画面位置
  function updateLabels() {
    if (!labels.length) return;
    const cam = K.camera, rect = $('phys-labels').getBoundingClientRect(), W = rect.width, H = rect.height;
    cam.updateMatrixWorld();
    const pv = V3(0, 0, 0), items = [];
    labels.forEach((l) => {
      pv.set(l.p[0], l.p[1], l.p[2]).project(cam);
      const ok = pv.z < 1 && pv.z > -1 && Math.abs(pv.x) < 1.15 && Math.abs(pv.y) < 1.15;
      if (!l.w) { l.w = l.el.offsetWidth || 120; l.h = l.el.offsetHeight || 22; }
      l.x = clamp((pv.x * 0.5 + 0.5) * W - l.w / 2, 4, W - l.w - 4); l.y = clamp((-pv.y * 0.5 + 0.5) * H - l.h / 2, 70, H - l.h - 70); l.ok = ok; items.push(l);
    });
    // パネルの下に隠れる位置のラベルは、パネルの横へ避ける
    const rects = [];
    [ui.panel, ui.time].forEach((el) => { if (el && !el.classList.contains('hidden') && el.offsetParent !== null) { const q = el.getBoundingClientRect(); rects.push({ l: q.left - rect.left, r: q.right - rect.left, t: q.top - rect.top, b: q.bottom - rect.top }); } });
    items.forEach((l) => {
      rects.forEach((q) => {
        if (l.x < q.r && q.l < l.x + l.w && l.y < q.b && q.t < l.y + l.h) {
          const toLeft = q.l - l.w - 4, toRight = q.r + 4;
          l.x = (q.l > W / 2 || toLeft >= 4) && q.l > W / 2 ? toLeft : toRight;
        }
      });
    });
    // 重なりの回避（画面上の矩形が重なったら下へずらす。上から順に）
    items.filter((l) => l.ok).sort((a, b) => a.y - b.y).forEach((l, i, arr) => {
      for (let it = 0; it < 12; it++) { let moved = false; for (let j = 0; j < i; j++) { const o = arr[j]; if (l.x < o.x + o.w + 2 && o.x < l.x + l.w + 2 && l.y < o.y + o.h + 2 && o.y < l.y + l.h + 2) { l.y = o.y + o.h + 3; moved = true; } } if (!moved) break; }
    });
    labels.forEach((l) => { l.el.style.display = l.ok ? 'block' : 'none'; l.el.style.transform = `translate(${Math.round(l.x)}px,${Math.round(l.y)}px)`; });
  }
  const camSig = { m: null };
  function rafLoop(now) {
    requestAnimationFrame(rafLoop);
    if (tw) {
      const u = clamp((now - tw.s) / tw.dur, 0, 1); camLerp(tw.a, tw.b, u); if (u >= 1) tw = null;
    }
    if (S.play) {
      const i = Math.floor((now - S.playT0) / 2000) % STEPS.length;
      if (i !== S.step) { api.setStep(i); }
    }
    // カメラが動いたら、ラベルと線の太さの解像度を更新
    const me = K.camera.matrixWorld.elements.join(',') + K.camera.projectionMatrix.elements[0];
    if (me !== camSig.m) { camSig.m = me; updateLabels(); }
  }
  function syncResolution() {
    const w = K.renderer.domElement.width, h = K.renderer.domElement.height;
    dynGroup().children.forEach((o) => { if (o.material && o.material.resolution) o.material.resolution.set(w, h); });
  }

  // ------------------------------------------------------------ 窓口
  function init() {
    grabClasses();
    overlayRoot = new C.Group(); overlayRoot.name = 'phys-root'; K.scene.add(overlayRoot);
    buildBuildings(); buildUI();
    window.addEventListener('resize', () => { syncResolution(); updateLabels(); K.markDirty(true); });
    api = {
      ready: true,
      classes: Object.keys(C),
      setMode(m, opt) {
        S.mode = m; if (m !== 'ladder') S.play = false;
        if (m === 'terms' && opt && opt.cam !== false && !api._noCam) { /* カメラは呼び出し側が決める */ }
        render(); this.update();
      },
      setTerm(k) { if (!termKeys().includes(k)) return; S.term = k; if (S.mode !== 'terms') S.mode = 'terms'; render(); },
      setStiVar(k) { S.stiVar = k; if (S.mode === 'terms') render(); },
      setPlan(p) { if (!T.plans[p]) return; S.plan = p; render(); },
      setStep(i) { S.step = clamp(i | 0, 0, STEPS.length - 1); if (S.mode !== 'ladder') S.mode = 'ladder'; render(); },
      play(on) { S.play = !!on; S.playT0 = performance.now() - S.step * 2000; if (S.mode !== 'ladder') { S.mode = 'ladder'; } render(); },
      selectReceiver(code, flyMs) { if (!repOf(code)) return; S.rcv = code; S.mode = 'paths'; render(); if (flyMs !== 0) camTo(poseFor('recv', code), flyMs == null ? 1800 : flyMs); },
      setProof(i, flyMs) { S.proof = clamp(i | 0, 0, PW.examples.length - 1); S.mode = 'proof'; render(); if (flyMs !== 0) camTo(poseFor('proof', S.proof), flyMs == null ? 1800 : flyMs); },
      hideAll() { S.mode = 'off'; S.play = false; render(); },
      showPanel(on) { ui.panel.classList.toggle('hidden', !on); },
      poseFor, poseOrbit, camLerp, camTo, camSet,
      update(force) { syncResolution(); if (force) render(); else { updateLabels(); } K.markDirty(false); },
      state() { return JSON.parse(JSON.stringify(S)); },
      receivers() { return PA.representatives.map((r) => r.code); },
      pose() { return { p: K.camera.position.toArray(), t: K.controls.target.toArray() }; },
    };
    window.__phys = api;
    requestAnimationFrame(rafLoop);
    // URL パラメータ
    if (qs.get('panel') === '0') api.showPanel(false);
    if (qs.get('fold') === '1') { S.fold = true; ui.panel.classList.add('fold'); $('phys-fold').textContent = '▲'; }
    const physOn = qs.get('physics') === '1' || qs.has('mode');
    const plq = qs.get('plan'); if (plq && T.plans[plq]) S.plan = plq;
    if (qs.get('term') && termKeys().includes(qs.get('term'))) S.term = qs.get('term');
    if (qs.has('step')) S.step = clamp(+qs.get('step') | 0, 0, STEPS.length - 1);
    if (qs.get('rcv') && repOf(qs.get('rcv'))) S.rcv = qs.get('rcv');
    if (qs.has('proof')) S.proof = clamp(+qs.get('proof') | 0, 0, PW.examples.length - 1);
    if (qs.get('stivar')) S.stiVar = qs.get('stivar');
    const mode = qs.get('mode') || (physOn ? 'terms' : 'off');
    S.mode = mode; render();
    if (mode === 'paths' && !qs.has('pose')) camSet(poseFor('recv', S.rcv));
    if (mode === 'proof' && !qs.has('pose')) camSet(poseFor('proof', S.proof));
    if (mode === 'terms' && !qs.has('pose') && !qs.has('cam')) camSet(poseFor('terms'));
    if (qs.get('play') === '1') api.play(true);
    window.__physReady = true;
  }
  boot();
})();
