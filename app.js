/* Barricade 기록 대국 - page logic: board, game flow against the in-browser AI, per-move recording. */
(() => {
  "use strict";
  const B = window.BE, R = window.BR_RECORD, CFG = window.BR_CONFIG;
  const N = 9, CELL = 54, GAP = 12, PAD = 30, UNIT = CELL + GAP, TOL = 7;
  const BOARD = N * CELL + (N - 1) * GAP;
  const SIZE = BOARD + 2 * PAD;
  const FILES = "abcdefghi";
  const LEVELS = [[1, "1수 앞"], [2, "2수 앞 · 입문"], [3, "3수 앞"], [4, "4수 앞 · 보통"], [5, "5수 앞"],
                  [6, "6수 앞 · 강함 (권장)"], [7, "7수 앞 · 매우 강함"], [8, "8수 앞 · 최강 (느림)"]];
  const DEFAULTS = { side: 0, level: 6, showPaths: false, flip: true, rangeMin: 14, rangeMax: 20 };
  const KEY = "barricade-rec-settings", GKEY = "barricade-rec-game", PKEY = "barricade-rec-player";

  const $ = (id) => document.getElementById(id);
  const cv = $("board");
  const ctx = cv.getContext("2d");
  const store = new window.BR_Store(CFG);
  store.onchange = () => renderRecord();

  // ---------------------------------------------------------------- AI workers
  class Brain {
    constructor() { this.start(); }
    start() {
      this.w = new Worker("ai-worker.js");
      this.seq = 0;
      this.wait = new Map();
      this.w.onmessage = (e) => {
        const p = this.wait.get(e.data.id);
        if (!p) return;
        this.wait.delete(e.data.id);
        if (e.data.ok) p.res(e.data); else p.rej(new Error(e.data.error));
      };
      this.w.onerror = (e) => {
        for (const p of this.wait.values()) p.rej(new Error("AI 계산 오류: " + (e.message || "알 수 없음")));
        this.wait.clear();
      };
    }
    restart() {           // drops any running search and the transposition table (new game)
      this.w.terminate();
      for (const p of this.wait.values()) p.rej(new Error("cancelled"));
      this.start();
    }
    call(msg) {
      const id = ++this.seq;
      return new Promise((res, rej) => { this.wait.set(id, { res, rej }); this.w.postMessage(Object.assign({ id }, msg)); });
    }
    search(s, depth) { return this.call({ type: "search", s: Array.from(s), depth }); }
  }
  const bot = new Brain();       // plays the AI side
  const adviser = new Brain();   // computes "what the AI would play" in my position, while I think

  // ---------------------------------------------------------------- settings / player
  let settings = loadSettings();
  function loadSettings() {
    try {
      const s = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || "{}"));
      if (!LEVELS.some(([v]) => v === s.level)) s.level = DEFAULTS.level;
      if (Number.isInteger(s.lateWalls) && !("rangeMin" in JSON.parse(localStorage.getItem(KEY) || "{}"))) s.rangeMin = s.lateWalls;   // v1.2 setting
      delete s.lateWalls; delete s.lateOnEmpty;
      const ok = (v) => Number.isInteger(v) && v >= 0 && v <= 20;
      if (!ok(s.rangeMin)) s.rangeMin = DEFAULTS.rangeMin;
      if (!ok(s.rangeMax)) s.rangeMax = DEFAULTS.rangeMax;
      if (s.rangeMax < s.rangeMin) s.rangeMax = s.rangeMin;
      return s;
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings() { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* blocked */ } }
  let player = "";
  try { player = localStorage.getItem(PKEY) || ""; } catch (e) { /* blocked */ }
  const device = (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                  (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))) ? "모바일" : "PC";

  // ---------------------------------------------------------------- game state
  let G = null;            // current game
  let gen = 0;             // bumps on every new game, so results of an old game's searches are ignored
  let busy = false, busyLabel = "";
  let hover = null, touchPending = null, flash = null, msg = null;
  let lastOrient = 1, lastPointer = "mouse";
  let newGameArmed = 0;
  let otherTab = false;    // another tab of this browser took over the saved game
  let LEG = [new Map(), new Map(), new Map()];
  let viewCache = null;

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
    "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));

  function saveGame() {
    if (!G || otherTab) return;
    try {
      localStorage.setItem(GKEY, JSON.stringify({
        id: G.id, human: G.human, hist: G.hist, rowsSent: G.rowsSent, over: G.over,
        botInfo: G.botInfo, pendingRow: G.pendingRow || null, levelAtStart: G.levelAtStart,
      }));
    } catch (e) { /* storage blocked */ }
  }
  function replay(hist) {
    const s = B.initState();
    for (const a of hist) B.applyAction(s, a);
    return s;
  }
  const isOver = () => !G || G.over;
  const myTurn = () => !!(G && !G.over && G.s[B.TURN] === G.human && !busy && !otherTab);

  function pushRow(row) {
    row.game_id = G.id;
    store.enqueue("moves", row);
    G.rowsSent = Math.max(G.rowsSent, row.ply);
    if (G.pendingRow && G.pendingRow.ply <= row.ply) G.pendingRow = null;
    saveGame();
  }

  function newGame() {
    if (!player) { openNameDialog(); return; }
    otherTab = false;
    gen++;
    bot.restart();
    adviser.restart();
    busy = false; busyLabel = "";
    G = {
      id: uuid(), human: settings.side, hist: [], s: B.initState(), over: false,
      rowsSent: 0, botInfo: null, pendingRow: null, levelAtStart: settings.level, rec: null, snap: null,
    };
    store.enqueue("games", {
      id: G.id, player, device, my_side: G.human, engine: "alphabeta", start_level: settings.level,
      app_version: CFG.appVersion, user_agent: navigator.userAgent.slice(0, 400),
    });
    saveGame();
    next();
  }

  function restoreGame() {
    let d;
    try { d = JSON.parse(localStorage.getItem(GKEY) || "null"); } catch (e) { d = null; }
    if (!d || !Array.isArray(d.hist) || (d.human !== 0 && d.human !== 1)) return false;
    let s;
    try {
      s = B.initState();
      for (const a of d.hist) {
        if (B.winner(s) >= 0 || !B.legalActions(s).includes(a)) throw new Error("bad record");
        B.applyAction(s, a);
      }
    } catch (e) { return false; }
    G = {
      id: d.id, human: d.human, hist: d.hist.slice(), s, over: B.winner(s) >= 0, rowsSent: d.rowsSent | 0,
      botInfo: d.botInfo || null, pendingRow: d.pendingRow || null, levelAtStart: d.levelAtStart, rec: null, snap: null,
    };
    // rows of moves that were played but not yet handed to the outbox (page closed mid-move)
    for (let ply = G.rowsSent + 1; ply <= G.hist.length; ply++) {
      const sb = replay(G.hist.slice(0, ply - 1));
      const { row } = R.moveRow(sb, G.hist[ply - 1], G.human);
      row.ply = ply;
      if (G.pendingRow && G.pendingRow.ply === ply) Object.assign(row, G.pendingRow);
      pushRow(row);
    }
    return true;
  }

  function next() {
    viewCache = null;
    if (!G || G.over) { render(); return; }
    if (G.s[B.TURN] === G.human) startMyTurn();
    else botMove();
  }

  function startMyTurn() {
    G.turnStart = Date.now();
    G.snap = R.snapshot(G.s);
    const myGen = gen, ply = G.hist.length;
    G.rec = { ply, level: settings.level, promise: adviser.search(G.s, settings.level).catch(() => null) };
    G.rec.promise.then(() => { if (myGen === gen) renderRecord(); });
    render();
  }

  async function playMine(a) {
    if (!myTurn()) return;
    if (!B.legalActions(G.s).includes(a)) { setMsg("둘 수 없는 수입니다"); render(); return; }
    const myGen = gen;
    const thinkMs = Date.now() - (G.turnStart || Date.now());
    const level = settings.level;
    const { row, after } = R.moveRow(G.s, a, G.human, G.snap);
    row.ply = G.hist.length + 1;
    row.think_ms = thinkMs;
    row.ai_level = level;
    G.s = after;
    G.hist.push(a);
    G.over = B.winner(after) >= 0;
    G.pendingRow = Object.assign({}, row);
    const recOk = !!(G.rec && G.rec.ply === row.ply - 1);
    const recP = recOk ? G.rec.promise : Promise.resolve(null);
    const recLevel = recOk ? G.rec.level : level;
    G.rec = null;
    saveGame();
    viewCache = null;
    busy = true;
    busyLabel = G.over ? "기록 정리 중…" : "AI가 생각 중…";
    render();

    const botP = G.over ? Promise.resolve(null) : bot.search(G.s, level).catch((e) => ({ error: e }));
    // value of the move I actually played, searched to the same horizon as the AI's recommendation
    // (recommendation = depth `level` from my position = my move + level-1 replies)
    const mineP = (G.over || recLevel < 2) ? Promise.resolve(null) : adviser.search(G.s, recLevel - 1).catch(() => null);
    const [rec, br, mineV] = await Promise.all([recP, botP, mineP]);
    if (myGen !== gen) return;
    if (rec) {
      row.rec_notation = B.actionStr(rec.a);
      row.rec_match = rec.a === a;
      row.rec_score = rec.score;
    }
    if (G.over) row.after_score = B.WIN - 1;          // my move reached the goal
    else if (mineV) row.after_score = -mineV.score;
    if (rec && row.after_score !== undefined && Math.abs(rec.score) <= B.MATE && Math.abs(row.after_score) <= B.MATE) {
      row.eval_loss = rec.score - row.after_score;
    }
    pushRow(row);
    busy = false; busyLabel = "";
    if (G.over) { render(); return; }
    if (!br || br.error) {
      setMsg("AI 계산 오류: " + (br && br.error ? br.error.message : "알 수 없음") + " - '봇 수 두기'를 눌러 다시 시도하세요", "error", 8000);
      render();
      return;
    }
    applyBot(br, level);
  }

  async function botMove() {
    if (!G || G.over || G.s[B.TURN] === G.human || busy || otherTab) { render(); return; }
    const myGen = gen, level = settings.level;
    busy = true; busyLabel = "AI가 생각 중…"; render();
    let br;
    try { br = await bot.search(G.s, level); }
    catch (e) {
      if (myGen !== gen) return;
      busy = false; busyLabel = "";
      setMsg("AI 계산 오류: " + e.message, "error", 8000); render(); return;
    }
    if (myGen !== gen) return;
    busy = false; busyLabel = "";
    applyBot(br, level);
  }

  function applyBot(br, level) {
    if (!B.legalActions(G.s).includes(br.a)) { setMsg("AI가 둘 수 없는 수를 냈습니다: " + br.a, "error", 8000); render(); return; }
    const { row, after } = R.moveRow(G.s, br.a, G.human);
    row.ply = G.hist.length + 1;
    row.ai_score = -br.score;
    row.ai_depth = br.depth;
    row.ai_nodes = br.nodes;
    row.think_ms = br.ms;
    row.ai_level = level;
    G.s = after;
    G.hist.push(br.a);
    G.over = B.winner(after) >= 0;
    G.botInfo = { kind: "ab", score: br.score, mate: Math.abs(br.score) >= B.WIN - 1000, depth: br.depth, nodes: br.nodes, ms: br.ms };
    pushRow(row);
    next();
  }

  // ---------------------------------------------------------------- view model (same shape as the old server state)
  function view() {
    if (viewCache) return viewCache;
    if (!G) return null;
    const s = G.s;
    const w = B.winner(s);
    const walls = [];
    G.hist.forEach((a, i) => { const [k, r, c] = B.decode(a); if (k) walls.push({ k, r, c, o: i % 2 }); });
    let last = null;
    if (G.hist.length) {
      const a = G.hist[G.hist.length - 1];
      const [k, r, c] = B.decode(a);
      last = { a, k, r, c, s: B.actionStr(a), p: (G.hist.length - 1) % 2 };
      if (k === 0) {
        const prev = replay(G.hist.slice(0, -1));
        last.from = [prev[2 * last.p], prev[2 * last.p + 1]];
      }
    }
    const tmp = new Int16Array(81);
    viewCache = {
      human: G.human, turn: s[B.TURN], ply: G.hist.length, winner: w,
      p: [[s[0], s[1]], [s[2], s[3]]], wallsLeft: [s[B.WL0], s[B.WL1]],
      walls, dist: [B.pathDist(s, 0, tmp), B.pathDist(s, 1, tmp)],
      paths: [B.shortestPath(s, 0), B.shortestPath(s, 1)],
      history: G.hist.map((a, i) => ({ a, s: B.actionStr(a), p: i % 2, k: (a / 81) | 0 })),
      last, botInfo: G.botInfo,
    };
    return viewCache;
  }
  function refreshLegal() {
    LEG = [new Map(), new Map(), new Map()];
    if (myTurn()) for (const a of B.legalActions(G.s)) { const [k, r, c] = B.decode(a); LEG[k].set(r * 9 + c, a); }
  }

  // ---------------------------------------------------------------- geometry
  const flipped = () => !!(G && settings.flip && G.human === 1);
  const cellDisp = (r, c) => (flipped() ? [8 - r, 8 - c] : [r, c]);
  const wallDisp = (r, c) => (flipped() ? [7 - r, 7 - c] : [r, c]);
  function cellCenter(r, c) { const [dr, dc] = cellDisp(r, c); return [PAD + dc * UNIT + CELL / 2, PAD + dr * UNIT + CELL / 2]; }
  function wallRect(k, r, c) {
    const [dr, dc] = wallDisp(r, c);
    return k === 1 ? [PAD + dc * UNIT, PAD + dr * UNIT + CELL, 2 * CELL + GAP, GAP]
                   : [PAD + dc * UNIT + CELL, PAD + dr * UNIT, GAP, 2 * CELL + GAP];
  }
  function axis(v) {
    if (v < -GAP / 2 || v > BOARD + GAP / 2) return null;
    const vv = Math.min(Math.max(v, 0), BOARD - 0.001);
    const i = Math.floor(vv / UNIT), f = vv - i * UNIT;
    if (f >= CELL) return { gap: i };
    if (f < TOL && i > 0) return { gap: i - 1 };
    if (f > CELL - TOL && i < 8) return { gap: i };
    return { cell: i };
  }
  const slot = (v) => Math.max(0, Math.min(7, Math.round((v - CELL - GAP / 2) / UNIT)));
  function hitTest(x, y) {
    const bx = x - PAD, by = y - PAD;
    const ax = axis(bx), ay = axis(by);
    if (!ax || !ay) return null;
    if (ax.cell !== undefined && ay.cell !== undefined) {
      const [r, c] = cellDisp(ay.cell, ax.cell);
      const a = LEG[0].get(r * 9 + c);
      return { type: "move", k: 0, r, c, a, legal: a !== undefined };
    }
    let k, dr, dc;
    if (ax.gap !== undefined && ay.gap !== undefined) {
      const dx = Math.abs(bx - (ax.gap * UNIT + CELL + GAP / 2));
      const dy = Math.abs(by - (ay.gap * UNIT + CELL + GAP / 2));
      k = (dx <= GAP / 2 && dy <= GAP / 2) ? lastOrient : (dx < dy ? 2 : 1);
      dr = ay.gap; dc = ax.gap;
    } else if (ax.gap !== undefined) { k = 2; dc = ax.gap; dr = slot(by); }
    else { k = 1; dr = ay.gap; dc = slot(bx); }
    lastOrient = k;
    const [r, c] = wallDisp(dr, dc);
    const a = LEG[k].get(r * 9 + c);
    return { type: "wall", k, r, c, a, legal: a !== undefined };
  }
  const same = (a, b) => (!a && !b) || (a && b && a.type === b.type && a.k === b.k && a.r === b.r && a.c === b.c);
  function toCanvas(e) {
    const rect = cv.getBoundingClientRect();
    return [(e.clientX - rect.left) * SIZE / rect.width, (e.clientY - rect.top) * SIZE / rect.height];
  }

  // ---------------------------------------------------------------- drawing
  function colors() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    return { frame: g("--board-frame"), gutter: g("--board-gutter"), cell: g("--board-cell"), label: g("--board-label"),
             p: [g("--p0"), g("--p1")], hint: g("--hint"), bad: g("--bad"), ring: g("--pawn-ring") };
  }
  function pathRR(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function fillRR(x, y, w, h, r, color, alpha = 1) { ctx.globalAlpha = alpha; ctx.fillStyle = color; pathRR(x, y, w, h, r); ctx.fill(); ctx.globalAlpha = 1; }
  function circle(x, y, rad, fill, alpha = 1) { ctx.globalAlpha = alpha; ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; }
  function setupCanvas() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    cv.width = Math.round(SIZE * dpr); cv.height = Math.round(SIZE * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  function draw() {
    const C = colors();
    ctx.clearRect(0, 0, SIZE, SIZE);
    fillRR(0, 0, SIZE, SIZE, 16, C.frame);
    fillRR(PAD - 6, PAD - 6, BOARD + 12, BOARD + 12, 8, C.gutter);
    for (let dr = 0; dr < 9; dr++) {
      for (let dc = 0; dc < 9; dc++) {
        const x = PAD + dc * UNIT, y = PAD + dr * UNIT;
        fillRR(x, y, CELL, CELL, 6, C.cell);
        const r = cellDisp(dr, dc)[0];
        if (r === 0) fillRR(x, y, CELL, CELL, 6, C.p[0], 0.24);
        if (r === 8) fillRR(x, y, CELL, CELL, 6, C.p[1], 0.24);
      }
    }
    ctx.fillStyle = C.label; ctx.font = "600 14px system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (let d = 0; d < 9; d++) {
      ctx.fillText(FILES[cellDisp(0, d)[1]], PAD + d * UNIT + CELL / 2, SIZE - 12);
      ctx.fillText(String(9 - cellDisp(d, 0)[0]), 13, PAD + d * UNIT + CELL / 2);
    }
    const S = view();
    if (!S) return;
    const me = S.human, mine = myTurn();
    if (settings.showPaths) {
      for (const p of [0, 1]) {
        const pts = S.paths[p];
        if (pts.length < 2) continue;
        ctx.save();
        ctx.globalAlpha = 0.55; ctx.strokeStyle = C.p[p]; ctx.lineWidth = 4;
        ctx.lineJoin = "round"; ctx.lineCap = "round";
        ctx.setLineDash(p === me ? [] : [7, 7]);
        ctx.beginPath();
        pts.forEach(([r, c], i) => { const [x, y] = cellCenter(r, c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke(); ctx.restore();
      }
    }
    if (S.last && S.last.k === 0 && S.last.from) {
      const [x, y] = cellCenter(S.last.from[0], S.last.from[1]);
      ctx.save(); ctx.globalAlpha = 0.6; ctx.strokeStyle = C.p[S.last.p]; ctx.lineWidth = 2.5;
      ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.arc(x, y, CELL * 0.26, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
    if (mine) {
      for (const key of LEG[0].keys()) {
        const [x, y] = cellCenter(Math.floor(key / 9), key % 9);
        circle(x, y, 7, C.p[me], 0.55);
      }
    }
    for (const w of S.walls) { const [x, y, ww, hh] = wallRect(w.k, w.r, w.c); fillRR(x, y, ww, hh, 4, C.p[w.o]); }
    if (S.last && S.last.k > 0) {
      const [x, y, ww, hh] = wallRect(S.last.k, S.last.r, S.last.c);
      ctx.save(); ctx.strokeStyle = C.ring; ctx.lineWidth = 2; pathRR(x - 1, y - 1, ww + 2, hh + 2, 5); ctx.stroke(); ctx.restore();
    }
    const h = touchPending || hover;
    if (h && mine) {
      if (h.type === "wall" && S.wallsLeft[me] > 0) {
        const [x, y, ww, hh] = wallRect(h.k, h.r, h.c);
        fillRR(x, y, ww, hh, 4, h.legal ? C.p[me] : C.bad, h.legal ? 0.55 : 0.5);
      } else if (h.type === "move" && h.legal) {
        const [x, y] = cellCenter(h.r, h.c);
        circle(x, y, 17, C.p[me], 0.35);
      }
    }
    if (flash && Date.now() < flash.until) {
      const [x, y, ww, hh] = wallRect(flash.k, flash.r, flash.c);
      fillRR(x, y, ww, hh, 4, C.bad, 0.85);
    }
    for (const p of [0, 1]) {
      const [x, y] = cellCenter(S.p[p][0], S.p[p][1]);
      ctx.save(); ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
      circle(x, y, 18, C.p[p]); ctx.restore();
      ctx.save(); ctx.strokeStyle = C.ring; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      ctx.fillStyle = "#fff"; ctx.font = "700 13px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(p === me ? "나" : "AI", x, y + 1);
    }
  }

  // ---------------------------------------------------------------- panel
  function setMsg(text, kind = "error", ms = 3000) { msg = { text, kind, until: Date.now() + ms }; setTimeout(renderPanel, ms + 20); }
  function fmtNodes(n) { return n >= 10000 ? (n / 10000).toFixed(1) + "만" : n.toLocaleString(); }
  function evalView(info) {
    const sc = -info.score;
    const meta = "깊이 " + info.depth + " · " + fmtNodes(info.nodes) + " 노드 · " + (info.ms / 1000).toFixed(2) + "초";
    if (info.mate) return { frac: sc > 0 ? 1 : 0, meta, text: sc > 0 ? "AI 계산: 당신이 이기는 수순이 있습니다" : "AI 계산: AI가 이기는 수순을 찾았습니다" };
    const steps = sc / 100;
    const text = Math.abs(steps) < 0.25 ? "AI 평가: 대등" : "AI 평가: " + (steps > 0 ? "당신이" : "AI가") + " 약 " + Math.abs(steps).toFixed(1) + "수 유리";
    return { frac: 0.5 + 0.5 * Math.tanh(sc / 300), text, meta };
  }
  function statusView() {
    if (otherTab) return ["다른 탭에서 게임을 진행 중입니다. 이 탭은 닫아 주세요 (새로 고치면 그 게임을 이어서 둡니다)", "error"];
    if (msg && msg.until > Date.now()) return [msg.text, msg.kind];
    if (!player) return ["이름을 입력하면 시작합니다", "idle"];
    const S = view();
    if (!S) return ["새 게임을 눌러 시작하세요", "idle"];
    if (S.winner >= 0) return S.winner === S.human ? ["승리했습니다!", "win"] : ["AI가 이겼습니다", "lose"];
    if (busy) return [busyLabel || "처리 중…", "think"];
    if (S.turn === S.human) return [touchPending ? "같은 자리를 한 번 더 탭하면 확정됩니다" : "당신 차례입니다", "turn"];
    return ["AI 차례", "think"];
  }
  function renderPanel() {
    const S = view();
    const root = document.documentElement.style;
    if (S) { root.setProperty("--me", "var(--p" + S.human + ")"); root.setProperty("--bot", "var(--p" + (1 - S.human) + ")"); }
    const [text, kind] = statusView();
    $("status").className = "status " + kind;
    $("status-text").textContent = text;
    let sub = "";
    if (S && S.winner < 0 && S.turn === S.human && !busy) sub = "점이 찍힌 칸을 눌러 이동하거나, 칸 사이 홈을 눌러 벽을 놓으세요 (남은 벽 " + S.wallsLeft[S.human] + "개)";
    else if (S && S.winner >= 0) sub = "총 " + S.ply + "수 · 기록이 저장되었습니다";
    $("substatus").textContent = sub;
    $("btn-retry").style.display = (S && S.winner < 0 && S.turn !== S.human && !busy) ? "block" : "none";
    $("player-name").textContent = player || "(이름 없음)";

    const box = $("players");
    box.textContent = "";
    if (S) {
      for (const p of [1 - S.human, S.human]) {
        const el = document.createElement("div");
        el.className = "player" + (S.winner < 0 && S.turn === p ? " active" : "");
        el.style.setProperty("--pc", "var(--p" + p + ")");
        const dot = document.createElement("span"); dot.className = "dot";
        const name = document.createElement("div"); name.className = "name";
        name.textContent = p === S.human ? "나" : "AI";
        const small = document.createElement("small"); small.textContent = p === 0 ? "선공 P0" : "후공 P1";
        name.appendChild(small);
        const dist = document.createElement("div"); dist.className = "dist";
        dist.textContent = S.dist[p] === 0 ? "도착" : "목표까지 " + S.dist[p] + "칸";
        const pips = document.createElement("div"); pips.className = "pips";
        for (let i = 0; i < 10; i++) { const pip = document.createElement("i"); if (i >= S.wallsLeft[p]) pip.className = "used"; pips.appendChild(pip); }
        const cnt = document.createElement("span"); cnt.textContent = "벽 " + S.wallsLeft[p] + "/10";
        pips.appendChild(cnt);
        el.append(dot, name, dist, pips);
        box.appendChild(el);
      }
    }
    if (S && S.botInfo) {
      const v = evalView(S.botInfo);
      $("eval-fill").style.width = (v.frac * 100).toFixed(1) + "%";
      $("eval-text").textContent = v.text;
      $("eval-meta").textContent = v.meta;
    } else {
      $("eval-fill").style.width = "50%";
      $("eval-text").textContent = "AI 평가: 아직 없음";
      $("eval-meta").textContent = "AI가 한 수 두면 형세 판단이 표시됩니다";
    }
    $("btn-new").disabled = false;
    $("btn-new").textContent = newGameArmed > Date.now() ? "한 번 더 누르면 새 게임" : "새 게임";
    $("btn-retry").disabled = busy;

    for (const b of $("side-seg").querySelectorAll("button")) b.classList.toggle("on", +b.dataset.side === settings.side);
    $("side-note").textContent = G && !G.over && G.human !== settings.side ? "새 게임부터 적용됩니다" : "";
    $("level").value = String(settings.level);
    $("show-paths").checked = !!settings.showPaths;
    $("flip").checked = !!settings.flip;

    const ol = $("moves");
    ol.textContent = "";
    if (!S || S.history.length === 0) {
      const e = document.createElement("li"); e.className = "empty"; e.textContent = "아직 둔 수가 없습니다"; ol.appendChild(e);
    } else {
      for (let i = 0; i < S.history.length; i += 2) {
        const li = document.createElement("li");
        const num = document.createElement("span"); num.className = "num"; num.textContent = (i / 2 + 1) + ".";
        li.appendChild(num);
        for (const j of [i, i + 1]) {
          const m = S.history[j];
          const sp = document.createElement("span");
          if (m) {
            sp.className = "mv" + (m.k ? " wall" : "") + (j === S.history.length - 1 ? " last" : "");
            sp.style.setProperty("--c", "var(--p" + m.p + ")");
            sp.textContent = m.s;
            sp.title = (m.p === S.human ? "나" : "AI") + (m.k ? " · 벽" : " · 이동");
          }
          li.appendChild(sp);
        }
        ol.appendChild(li);
      }
      ol.scrollTop = ol.scrollHeight;
    }
    const over = !!(S && S.winner >= 0);
    $("banner").classList.toggle("show", over);
    if (over) {
      const won = S.winner === S.human;
      $("banner-title").textContent = won ? "승리했습니다!" : "AI가 이겼습니다";
      $("banner-sub").textContent = S.ply + "수 만에 " + (won ? "목표 줄에 먼저 도착했습니다" : "AI가 먼저 도착했습니다") + " · 기록 저장됨";
    }
    renderRecord();
  }

  function renderRecord() {
    const pend = store.pending();
    const sent = G ? G.rowsSent : 0;
    let line = G ? "이번 판 " + sent + "수 기록" : "아직 기록 없음";
    line += pend ? " · 전송 대기 " + pend + "건" : " · 모두 전송됨";
    $("rec-line").textContent = line;
    $("rec-dot").className = "rec-dot" + (pend ? (store.lastError ? " err" : " wait") : "");
    $("rec-err").textContent = pend && store.lastError ? store.lastError : "";
    const tb = $("rec-table");
    tb.textContent = "";
    if (!G) return;
    const snap = (G.snap && myTurn()) ? G.snap : null;
    const s = G.s;
    const sn = snap || R.snapshot(s);
    const f = sn.f[G.human];
    const used = 2 * B.MAX_WALLS - s[B.WL0] - s[B.WL1];
    const inR = used >= settings.rangeMin && used <= settings.rangeMax;
    const items = [["국면", G.over ? "종료" : R.phaseOf(s)], ["쓴 벽 합계", used + " / 20" + (inR ? " · 범위 안" : "")],
                   ["우회율", fmt(f[7])], ["벽 점유율", fmt(f[8])], ["경로 취약도", fmt(f[9])],
                   ["공격 잠재력", fmt(f[10])], ["경로 폭", fmt(f[11])], ["중앙 이탈도", fmt(f[12])]];
    for (const [k, v] of items) {
      const d = document.createElement("div");
      const a = document.createElement("span"); a.textContent = k;
      const b = document.createElement("b"); b.textContent = v;
      d.append(a, b);
      tb.appendChild(d);
    }
  }
  const fmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(2));
  const rangeOpt = () => ({ min: settings.rangeMin, max: settings.rangeMax });
  function renderLateOpt() {
    $("rmin-val").textContent = String(settings.rangeMin);
    $("rmax-val").textContent = String(settings.rangeMax);
    $("rmin-minus").disabled = settings.rangeMin <= 0;
    $("rmin-plus").disabled = settings.rangeMin >= settings.rangeMax;
    $("rmax-minus").disabled = settings.rangeMax <= settings.rangeMin;
    $("rmax-plus").disabled = settings.rangeMax >= 20;
    $("late-hint").textContent = "지금 범위: " + window.BR_EXCEL.rangeText(rangeOpt()) +
      "인 장면. 엑셀을 받을 때 이미 둔 판까지 이 범위로 다시 계산합니다. 저장되는 기록은 바뀌지 않습니다.";
  }

  function render() { refreshLegal(); draw(); renderPanel(); }

  function reject(t) {
    const S = view();
    if (t.type === "wall") {
      if (S.wallsLeft[S.human] === 0) setMsg("남은 벽이 없습니다");
      else {
        setMsg("그 자리에는 벽을 놓을 수 없습니다 (겹침·교차, 또는 길을 완전히 막음)");
        flash = { k: t.k, r: t.r, c: t.c, until: Date.now() + 650 };
        setTimeout(draw, 680);
      }
    } else {
      const own = S.p[S.human];
      if (own[0] === t.r && own[1] === t.c) return;
      setMsg("그 칸으로는 이동할 수 없습니다", "error", 1800);
    }
    render();
  }

  // ---------------------------------------------------------------- excel
  let excelBusy = false;
  function loadScript(src, ready) {
    if (ready()) return Promise.resolve();
    return new Promise((res, rej) => {
      const sc = document.createElement("script");
      sc.src = src;
      sc.onload = () => res();
      sc.onerror = () => rej(new Error("엑셀 라이브러리를 불러오지 못했습니다"));
      document.head.appendChild(sc);
    });
  }
  const loadExcelJs = () => Promise.all([loadScript("exceljs.min.js", () => !!window.ExcelJS),
                                         loadScript("jszip.min.js", () => !!window.JSZip)]);
  async function downloadExcel() {
    if (excelBusy) return;
    excelBusy = true;
    const btn = $("btn-excel");
    btn.disabled = true; btn.textContent = "불러오는 중…";
    try {
      await store.flush();
      const [games, moves] = await Promise.all([store.fetchAll("games", "created_at.asc"), store.fetchAll("moves", "id.asc"), loadExcelJs()]);
      btn.textContent = "엑셀 만드는 중…";
      const { wb, charts } = window.BR_EXCEL.buildWorkbook(window.ExcelJS, games, moves, rangeOpt());
      let buf = await wb.xlsx.writeBuffer();
      btn.textContent = "그래프 넣는 중…";
      buf = await window.BR_XLCHARTS.addCharts(window.JSZip, buf, charts);
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const d = new Date(Date.now() + 9 * 3600e3).toISOString();
      const name = "바리케이드_기록_" + d.slice(0, 10).replace(/-/g, "") + "_" + d.slice(11, 16).replace(":", "") +
                   "_벽" + window.BR_EXCEL.rangeShort(rangeOpt()) + ".xlsx";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      const played = new Set(moves.map((m) => m.game_id)).size;
      setMsg("엑셀을 내려받았습니다 (경기 " + played + "판, " + moves.length + "수)", "turn", 4000);
    } catch (e) {
      setMsg(e.message || String(e), "error", 7000);
    } finally {
      excelBusy = false;
      btn.disabled = false; btn.textContent = "전체 기록 엑셀 받기";
      renderPanel();
    }
  }

  // ---------------------------------------------------------------- name dialog
  function openNameDialog() {
    $("name-input").value = player;
    $("name-note").textContent = G && !G.over && G.hist.length ? "진행 중인 판은 원래 이름으로 기록되고, 새 이름은 다음 판부터 적용됩니다." : "";
    $("name-modal").classList.add("show");
    setTimeout(() => $("name-input").focus(), 30);
  }
  function submitName(e) {
    e.preventDefault();
    const v = $("name-input").value.trim().slice(0, 20);
    if (!v) { $("name-input").focus(); return; }
    player = v;
    try { localStorage.setItem(PKEY, player); } catch (err) { /* blocked */ }
    $("name-modal").classList.remove("show");
    if (!G) newGame(); else renderPanel();
  }

  // ---------------------------------------------------------------- input
  cv.addEventListener("pointerdown", (e) => { lastPointer = e.pointerType || "mouse"; });
  cv.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    const t = myTurn() ? hitTest(...toCanvas(e)) : null;
    cv.style.cursor = !t ? "default" : (t.legal ? "pointer" : (t.type === "wall" ? "not-allowed" : "default"));
    if (!same(t, hover)) { hover = t; draw(); }
  });
  cv.addEventListener("pointerleave", () => { if (hover) { hover = null; draw(); } });
  cv.addEventListener("pointerup", (e) => {
    if (e.button !== 0 || !myTurn()) return;
    const t = (e.pointerType === "mouse" && hover) ? hover : hitTest(...toCanvas(e));
    if (!t) { if (touchPending) { touchPending = null; render(); } return; }
    if (lastPointer === "touch" && t.type === "wall" && !same(touchPending, t)) { touchPending = t; render(); return; }
    touchPending = null;
    if (!t.legal) { reject(t); return; }
    hover = null;
    playMine(t.a);
  });

  function onNewGame() {
    const inProgress = G && !G.over && G.hist.length > 0;
    if (inProgress && newGameArmed < Date.now()) {
      newGameArmed = Date.now() + 3000;
      setMsg("진행 중인 판은 '미완료'로 남습니다. 새 게임을 한 번 더 누르면 시작합니다.", "think", 3000);
      renderPanel();
      setTimeout(renderPanel, 3050);
      return;
    }
    newGameArmed = 0;
    newGame();
  }
  $("btn-new").addEventListener("click", onNewGame);
  $("banner-new").addEventListener("click", onNewGame);
  $("btn-retry").addEventListener("click", botMove);
  $("btn-excel").addEventListener("click", downloadExcel);
  $("btn-name").addEventListener("click", openNameDialog);
  $("name-form").addEventListener("submit", submitName);
  for (const b of $("side-seg").querySelectorAll("button")) {
    b.addEventListener("click", () => { settings.side = +b.dataset.side; saveSettings(); renderPanel(); });
  }
  $("level").addEventListener("change", (e) => { settings.level = +e.target.value; saveSettings(); });
  const setRange = (mn, mx) => {
    settings.rangeMin = Math.max(0, Math.min(20, mn));
    settings.rangeMax = Math.max(settings.rangeMin, Math.min(20, mx));
    saveSettings(); renderLateOpt(); renderRecord();
  };
  $("rmin-minus").addEventListener("click", () => setRange(settings.rangeMin - 1, settings.rangeMax));
  $("rmin-plus").addEventListener("click", () => setRange(Math.min(settings.rangeMin + 1, settings.rangeMax), settings.rangeMax));
  $("rmax-minus").addEventListener("click", () => setRange(settings.rangeMin, Math.max(settings.rangeMax - 1, settings.rangeMin)));
  $("rmax-plus").addEventListener("click", () => setRange(settings.rangeMin, settings.rangeMax + 1));
  $("show-paths").addEventListener("change", (e) => { settings.showPaths = e.target.checked; saveSettings(); draw(); });
  $("flip").addEventListener("change", (e) => { settings.flip = e.target.checked; saveSettings(); render(); });
  window.addEventListener("resize", setupCanvas);
  window.addEventListener("storage", (e) => {
    if (e.key === GKEY && G && !otherTab) { otherTab = true; gen++; busy = false; busyLabel = ""; render(); }
    if (e.key === PKEY) { try { player = localStorage.getItem(PKEY) || player; } catch (err) { /* blocked */ } renderPanel(); }
  });
  try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw); } catch (e) { /* old browser */ }

  // ---------------------------------------------------------------- start
  (function buildLevels() {
    const sel = $("level");
    for (const [v, label] of LEVELS) { const o = document.createElement("option"); o.value = v; o.textContent = label; sel.appendChild(o); }
  })();
  setupCanvas();
  renderLateOpt();
  render();
  (async function start() {
    // a saved game whose record was deleted from the team table can't be continued: start a new one
    let dropped = false;
    try {
      const saved = JSON.parse(localStorage.getItem(GKEY) || "null");
      if (saved && saved.id && !saved.over && !store.hasQueued("games", saved.id) && (await store.exists("games", saved.id)) === false) {
        localStorage.removeItem(GKEY);
        dropped = true;
      }
    } catch (e) { /* storage blocked */ }
    if (restoreGame()) { setMsg("진행 중이던 게임을 이어서 합니다", "turn", 3000); next(); }
    else render();
    if (!player) openNameDialog();
    else if (!G) {
      newGame();
      if (dropped) { setMsg("이전 판의 기록이 삭제되어 새 게임을 시작했습니다", "turn", 5000); renderPanel(); }
    }
    store.flush();
  })();

  // test hook (used by automated checks only)
  window.__BR = { get G() { return G; }, playMine, newGame, store, get busy() { return busy; } };
})();
