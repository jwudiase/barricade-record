/* Barricade engine, alpha-beta search and factor calculation for the browser.
 *
 * Line-by-line port of the Python project files
 *   barricade_ai/engine.py   (rules, legal moves, wall legality, hashing, notation)
 *   barricade_ai/search.py   (alpha-beta: negamax + transposition table + iterative deepening)
 *   similar_ai/features/feat.py (situation variables, factors, action-type classification)
 * so that the browser bot plays exactly like the Python bot and the recorded factor values are
 * identical to the Python ones (checked by tests/compare.js against Python output).
 *
 * State = Int16Array(136): [p0r, p0c, p1r, p1c, wl0, wl1, turn, ply, hw(64), vw(64)]
 * Action = kind*81 + r*9 + c  (kind 0 = pawn move to (r,c), 1 = horizontal wall, 2 = vertical wall)
 * Requires zobrist.js (global BZ) to be loaded first.
 */
(function (root) {
  "use strict";
  const BZ = root.BZ;
  const P0R = 0, P0C = 1, P1R = 2, P1C = 3, WL0 = 4, WL1 = 5, TURN = 6, PLY = 7;
  const HW0 = 8, VW0 = 72, SLEN = 136, MAX_WALLS = 10;
  const DR = [-1, 1, 0, 0], DC = [0, 0, -1, 1];

  function initState() {
    const s = new Int16Array(SLEN);
    s[P0R] = 8; s[P0C] = 4; s[P1R] = 0; s[P1C] = 4;
    s[WL0] = MAX_WALLS; s[WL1] = MAX_WALLS;
    return s;
  }

  function canStep(s, r, c, d) {
    if (d === 0) {
      if (r === 0) return false;
      if (c < 8 && s[HW0 + (r - 1) * 8 + c] !== 0) return false;
      if (c > 0 && s[HW0 + (r - 1) * 8 + c - 1] !== 0) return false;
      return true;
    } else if (d === 1) {
      if (r === 8) return false;
      if (c < 8 && s[HW0 + r * 8 + c] !== 0) return false;
      if (c > 0 && s[HW0 + r * 8 + c - 1] !== 0) return false;
      return true;
    } else if (d === 2) {
      if (c === 0) return false;
      if (r < 8 && s[VW0 + r * 8 + c - 1] !== 0) return false;
      if (r > 0 && s[VW0 + (r - 1) * 8 + c - 1] !== 0) return false;
      return true;
    }
    if (c === 8) return false;
    if (r < 8 && s[VW0 + r * 8 + c] !== 0) return false;
    if (r > 0 && s[VW0 + (r - 1) * 8 + c] !== 0) return false;
    return true;
  }

  const QUEUE = new Int32Array(81);   // BFS queue (BFS is never re-entered, so one buffer is enough)

  function bfsGoal(s, goalRow, dist) {
    dist.fill(-1);
    let head = 0, tail = 0;
    for (let c = 0; c < 9; c++) {
      const idx = goalRow * 9 + c;
      dist[idx] = 0;
      QUEUE[tail++] = idx;
    }
    while (head < tail) {
      const cur = QUEUE[head++];
      const r = (cur / 9) | 0, c = cur - r * 9;
      const nd = dist[cur] + 1;
      for (let d = 0; d < 4; d++) {
        if (canStep(s, r, c, d)) {
          const ni = (r + DR[d]) * 9 + (c + DC[d]);
          if (dist[ni] < 0) { dist[ni] = nd; QUEUE[tail++] = ni; }
        }
      }
    }
  }

  function bfsCell(s, start, dist) {
    dist.fill(-1);
    dist[start] = 0;
    QUEUE[0] = start;
    let head = 0, tail = 1;
    while (head < tail) {
      const cur = QUEUE[head++];
      const r = (cur / 9) | 0, c = cur - r * 9;
      const nd = dist[cur] + 1;
      for (let d = 0; d < 4; d++) {
        if (canStep(s, r, c, d)) {
          const ni = (r + DR[d]) * 9 + (c + DC[d]);
          if (dist[ni] < 0) { dist[ni] = nd; QUEUE[tail++] = ni; }
        }
      }
    }
  }

  const pawnCell = (s, p) => s[2 * p] * 9 + s[2 * p + 1];

  function pathDist(s, p, dist) {
    bfsGoal(s, 8 * p, dist);
    return dist[pawnCell(s, p)];
  }

  function pawnMoves(s, out) {
    const t = s[TURN];
    const r = s[2 * t], c = s[2 * t + 1];
    const orr = s[2 * (1 - t)], oc = s[2 * (1 - t) + 1];
    let n = 0;
    for (let d = 0; d < 4; d++) {
      if (!canStep(s, r, c, d)) continue;
      const nr = r + DR[d], nc = c + DC[d];
      if (nr === orr && nc === oc) {
        if (canStep(s, nr, nc, d)) {
          out[n++] = (nr + DR[d]) * 9 + (nc + DC[d]);
        } else {
          for (let d2 = 0; d2 < 4; d2++) {
            if (d2 === d || d2 === (d ^ 1)) continue;
            if (canStep(s, nr, nc, d2)) out[n++] = (nr + DR[d2]) * 9 + (nc + DC[d2]);
          }
        }
      } else {
        out[n++] = nr * 9 + nc;
      }
    }
    return n;
  }

  function wallStructOk(s, kind, r, c) {
    if (kind === 0) {
      if (s[HW0 + r * 8 + c] !== 0) return false;
      if (c > 0 && s[HW0 + r * 8 + c - 1] !== 0) return false;
      if (c < 7 && s[HW0 + r * 8 + c + 1] !== 0) return false;
      if (s[VW0 + r * 8 + c] !== 0) return false;
    } else {
      if (s[VW0 + r * 8 + c] !== 0) return false;
      if (r > 0 && s[VW0 + (r - 1) * 8 + c] !== 0) return false;
      if (r < 7 && s[VW0 + (r + 1) * 8 + c] !== 0) return false;
      if (s[HW0 + r * 8 + c] !== 0) return false;
    }
    return true;
  }

  function wallTry(s, kind, r, c, dist0, dist1, res) {
    const i = (kind === 0 ? HW0 : VW0) + r * 8 + c;
    s[i] = 1;
    res[0] = pathDist(s, 0, dist0);
    res[1] = pathDist(s, 1, dist1);
    s[i] = 0;
  }

  const LA_TMP = new Int32Array(8), LA_D0 = new Int16Array(81), LA_D1 = new Int16Array(81), LA_RES = new Int32Array(2);
  /** All legal actions of the side to move (same order as the Python engine). */
  function legalActions(s) {
    const out = [];
    const n = pawnMoves(s, LA_TMP);
    for (let i = 0; i < n; i++) out.push(LA_TMP[i]);
    const t = s[TURN];
    if (s[4 + t] > 0) {
      for (let kind = 0; kind < 2; kind++) {
        for (let r = 0; r < 8; r++) {
          for (let c = 0; c < 8; c++) {
            if (!wallStructOk(s, kind, r, c)) continue;
            wallTry(s, kind, r, c, LA_D0, LA_D1, LA_RES);
            if (LA_RES[0] >= 0 && LA_RES[1] >= 0) out.push((1 + kind) * 81 + r * 9 + c);
          }
        }
      }
    }
    return out;
  }

  function applyAction(s, a) {
    const ch = (a / 81) | 0, rem = a - ch * 81;
    const r = (rem / 9) | 0, c = rem - r * 9;
    const t = s[TURN];
    if (ch === 0) { s[2 * t] = r; s[2 * t + 1] = c; }
    else if (ch === 1) { s[HW0 + r * 8 + c] = 1; s[4 + t] -= 1; }
    else { s[VW0 + r * 8 + c] = 1; s[4 + t] -= 1; }
    s[TURN] = 1 - t;
    s[PLY] += 1;
  }

  function winner(s) {
    if (s[P0R] === 0) return 0;
    if (s[P1R] === 8) return 1;
    return -1;
  }

  // 64-bit Zobrist hash as two unsigned 32-bit halves (same keys as the Python engine)
  const HASH = new Uint32Array(2);
  function zhash(s) {
    let i0 = s[0] * 9 + s[1], i1 = 81 + s[2] * 9 + s[3];
    let hi = BZ.PAWN_HI[i0] ^ BZ.PAWN_HI[i1], lo = BZ.PAWN_LO[i0] ^ BZ.PAWN_LO[i1];
    const w0 = s[WL0], w1 = 11 + s[WL1];
    hi ^= BZ.WL_HI[w0] ^ BZ.WL_HI[w1];
    lo ^= BZ.WL_LO[w0] ^ BZ.WL_LO[w1];
    if (s[TURN] === 1) { hi ^= BZ.TURN_HI; lo ^= BZ.TURN_LO; }
    for (let i = 0; i < 64; i++) {
      if (s[HW0 + i] !== 0) { hi ^= BZ.HW_HI[i]; lo ^= BZ.HW_LO[i]; }
      if (s[VW0 + i] !== 0) { hi ^= BZ.VW_HI[i]; lo ^= BZ.VW_LO[i]; }
    }
    HASH[0] = hi; HASH[1] = lo;
    return HASH;
  }

  // ---------------------------------------------------------------- notation
  function decode(a) {
    const ch = (a / 81) | 0, rem = a - ch * 81;
    return [ch, (rem / 9) | 0, rem % 9];
  }
  function actionStr(a) {
    const [ch, r, c] = decode(a);
    if (ch === 0) return "abcdefghi"[c] + (9 - r);
    return "abcdefgh"[c] + (8 - r) + (ch === 1 ? "h" : "v");
  }
  function parseAction(txt) {
    txt = String(txt).trim().toLowerCase();
    if (txt.length === 2) return (9 - +txt[1]) * 9 + "abcdefghi".indexOf(txt[0]);
    if (txt.length === 3) return (txt[2] === "h" ? 1 : 2) * 81 + (8 - +txt[1]) * 9 + "abcdefgh".indexOf(txt[0]);
    throw new Error("bad notation " + txt);
  }

  // shortest path of player p for display (same tracing rule as server.py)
  const FWD = { 0: [0, 2, 3, 1], 1: [1, 2, 3, 0] };
  function shortestPath(s, p) {
    const dist = new Int16Array(81);
    bfsGoal(s, 8 * p, dist);
    let r = s[2 * p], c = s[2 * p + 1];
    if (dist[r * 9 + c] < 0) return [];
    const path = [[r, c]];
    while (dist[r * 9 + c] > 0) {
      for (const d of FWD[p]) {
        if (canStep(s, r, c, d)) {
          const nr = r + DR[d], nc = c + DC[d];
          if (dist[nr * 9 + nc] === dist[r * 9 + c] - 1) { r = nr; c = nc; break; }
        }
      }
      path.push([r, c]);
    }
    return path;
  }

  // ================================================================= alpha-beta (search.py)
  const WIN = 100000, MATE = WIN - 1000, MAXPLY = 40;
  const DEFAULT_PARAMS = [100.0, 120.0, 20.0, 0.0, 0.0, 0.0];

  const EV_DM = new Int16Array(81), EV_DO = new Int16Array(81);
  function evaluate(s, params) {
    const t = s[TURN], o = 1 - t;
    bfsGoal(s, 8 * t, EV_DM);
    bfsGoal(s, 8 * o, EV_DO);
    const dMe = EV_DM[s[2 * t] * 9 + s[2 * t + 1]];
    const dOp = EV_DO[s[2 * o] * 9 + s[2 * o + 1]];
    const wlMe = s[4 + t], wlOp = s[4 + o];
    let v = params[0] * (dOp - dMe) + params[1] * (wlMe - wlOp) + params[2];
    if (wlOp === 0) v += params[3] * (dOp - dMe);
    if (wlMe === 0) v -= params[4] * (dOp - dMe);
    return Math.trunc(v);
  }

  const GM_DM = new Int16Array(81), GM_DO = new Int16Array(81), GM_DF = new Int16Array(81);
  const GM_D0 = new Int16Array(81), GM_D1 = new Int16Array(81), GM_RES = new Int32Array(2);
  const GM_TMP = new Int32Array(8), GM_ONP = new Uint8Array(81);
  const GM_WA = new Int32Array(64), GM_WG = new Int32Array(64);
  /** Ordered candidate actions of the side to move into mv / sc. Returns count. */
  function genMoves(s, mv, sc, wallK, allowZeroGain) {
    const t = s[TURN], o = 1 - t;
    const dm = GM_DM, do_ = GM_DO, df = GM_DF;
    const pm = s[2 * t] * 9 + s[2 * t + 1];
    const po = s[2 * o] * 9 + s[2 * o + 1];
    bfsGoal(s, 8 * t, dm);
    bfsGoal(s, 8 * o, do_);
    const dMe = dm[pm], dOp = do_[po];
    const n = pawnMoves(s, GM_TMP);
    for (let i = 0; i < n; i++) { mv[i] = GM_TMP[i]; sc[i] = 1000 - 10 * dm[GM_TMP[i]]; }
    let cnt = n;
    if (s[4 + t] > 0) {
      bfsCell(s, po, df);
      const onp = GM_ONP;
      for (let x = 0; x < 81; x++) onp[x] = (df[x] >= 0 && do_[x] >= 0 && df[x] + do_[x] === dOp) ? 1 : 0;
      const wa = GM_WA, wg = GM_WG;
      let nw = 0;
      for (let kind = 0; kind < 2; kind++) {
        for (let r = 0; r < 8; r++) {
          for (let c = 0; c < 8; c++) {
            if (!wallStructOk(s, kind, r, c)) continue;
            let x1, y1, x2, y2;
            if (kind === 0) { x1 = r * 9 + c; y1 = (r + 1) * 9 + c; x2 = x1 + 1; y2 = y1 + 1; }
            else { x1 = r * 9 + c; y1 = x1 + 1; x2 = (r + 1) * 9 + c; y2 = x2 + 1; }
            let hit = false;
            if (onp[x1] && onp[y1] && Math.abs(do_[x1] - do_[y1]) === 1) hit = true;
            if (onp[x2] && onp[y2] && Math.abs(do_[x2] - do_[y2]) === 1) hit = true;
            if (!hit) continue;
            wallTry(s, kind, r, c, GM_D0, GM_D1, GM_RES);
            if (GM_RES[0] < 0 || GM_RES[1] < 0) continue;
            const dMe2 = GM_RES[t], dOp2 = GM_RES[o];
            const gain = (dOp2 - dOp) - (dMe2 - dMe);
            if (gain <= 0 && !(allowZeroGain && dOp2 > dOp)) continue;
            const act = (1 + kind) * 81 + r * 9 + c;
            let j;
            if (nw < wallK) { j = nw; nw++; }
            else if (gain > wg[wallK - 1]) { j = wallK - 1; }
            else continue;
            while (j > 0 && wg[j - 1] < gain) { wa[j] = wa[j - 1]; wg[j] = wg[j - 1]; j--; }
            wa[j] = act; wg[j] = gain;
          }
        }
      }
      for (let i = 0; i < nw; i++) { mv[cnt] = wa[i]; sc[cnt] = 880 + 60 * wg[i]; cnt++; }
    }
    return cnt;
  }

  /** Alpha-beta agent with its own transposition table (kept between moves, like the Python bot). */
  class AlphaBeta {
    constructor(opts = {}) {
      this.depth = opts.depth || 6;
      this.nodes = opts.nodes || 3000000;
      this.wallK = opts.wallK || 8;
      this.params = (opts.params || DEFAULT_PARAMS).slice();
      const bits = opts.ttBits || 20;
      const size = 1 << bits;
      this.mask = size - 1;
      this.ttHi = new Uint32Array(size);
      this.ttLo = new Uint32Array(size);
      this.ttVal = new Int32Array(size);
      this.ttDep = new Int8Array(size);
      this.ttFlg = new Int8Array(size);
      this.ttMv = new Int16Array(size);
      this.stb = [];
      this.mvb = [];
      this.scb = [];
      for (let i = 0; i < MAXPLY + 2; i++) {
        this.stb.push(new Int16Array(SLEN));
        this.mvb.push(new Int32Array(64));
        this.scb.push(new Int32Array(64));
      }
      this.nodeCount = 0;
      this.abort = false;
      this.last = null;
    }
    reset() { this.ttHi.fill(0); this.ttLo.fill(0); }

    negamax(ply, depth, alpha, beta) {
      this.nodeCount++;
      if (this.nodeCount > this.nodes) this.abort = true;
      if (this.abort) return 0;
      const s = this.stb[ply];
      const params = this.params;
      if (depth <= 0 || ply >= MAXPLY - 1) return evaluate(s, params);

      const alpha0 = alpha;
      const h = zhash(s);
      const hHi = h[0], hLo = h[1];
      const idx = hLo & this.mask;
      let ttMove = -1;
      if (this.ttHi[idx] === hHi && this.ttLo[idx] === hLo) {
        ttMove = this.ttMv[idx];
        if (ply > 0 && this.ttDep[idx] >= depth) {
          let v = this.ttVal[idx];
          if (v > MATE) v -= ply;
          else if (v < -MATE) v += ply;
          const f = this.ttFlg[idx];
          if (f === 0) return v;
          else if (f === 1) { if (v > alpha) alpha = v; }
          else { if (v < beta) beta = v; }
          if (alpha >= beta) return v;
        }
      }

      const mv = this.mvb[ply], sc = this.scb[ply];
      const n = genMoves(s, mv, sc, this.wallK, params[5] > 0.5);
      if (n === 0) return evaluate(s, params);
      if (ttMove >= 0) {
        for (let i = 0; i < n; i++) if (mv[i] === ttMove) { sc[i] = 100000; break; }
      }

      let best = -WIN * 2;
      let bestMv = mv[0];
      const child = this.stb[ply + 1];
      for (let i = 0; i < n; i++) {
        let bi = i;
        for (let j = i + 1; j < n; j++) if (sc[j] > sc[bi]) bi = j;
        if (bi !== i) {
          const tm = mv[i]; mv[i] = mv[bi]; mv[bi] = tm;
          const ts = sc[i]; sc[i] = sc[bi]; sc[bi] = ts;
        }
        const a = mv[i];
        child.set(s);
        applyAction(child, a);
        let v;
        if (winner(child) >= 0) v = WIN - (ply + 1);
        else v = -this.negamax(ply + 1, depth - 1, -beta, -alpha);
        if (this.abort) return 0;
        if (v > best) {
          best = v; bestMv = a;
          if (v > alpha) { alpha = v; if (alpha >= beta) break; }
        }
      }
      let sv = best;
      if (sv > MATE) sv += ply;
      else if (sv < -MATE) sv -= ply;
      this.ttHi[idx] = hHi; this.ttLo[idx] = hLo;
      this.ttVal[idx] = sv;
      this.ttDep[idx] = depth;
      this.ttMv[idx] = bestMv;
      this.ttFlg[idx] = best <= alpha0 ? 2 : (best >= beta ? 1 : 0);
      return best;
    }

    /** Iterative deepening. Returns {a, score, depth, nodes} (score from the mover's view, centi-steps). */
    search(s, maxDepth) {
      maxDepth = maxDepth || this.depth;
      this.stb[0].set(s);
      this.nodeCount = 0;
      this.abort = false;
      let bestA = -1, bestV = 0, reached = 0;
      for (let d = 1; d <= maxDepth; d++) {
        const v = this.negamax(0, d, -WIN * 2, WIN * 2);
        if (this.abort) break;
        const h = zhash(this.stb[0]);
        const idx = h[1] & this.mask;
        if (this.ttHi[idx] === h[0] && this.ttLo[idx] === h[1]) {
          bestA = this.ttMv[idx]; bestV = v; reached = d;
        }
        if (Math.abs(v) > MATE) break;
      }
      if (bestA < 0) {
        const n = genMoves(this.stb[0], this.mvb[0], this.scb[0], this.wallK, this.params[5] > 0.5);
        let bi = 0;
        for (let i = 1; i < n; i++) if (this.scb[0][i] > this.scb[0][bi]) bi = i;
        if (n > 0) bestA = this.mvb[0][bi];
      }
      this.last = { a: bestA, score: bestV, depth: reached, nodes: this.nodeCount };
      return this.last;
    }
  }

  // ================================================================= factors (feat.py)
  const FNAMES = ["d_me", "d_op", "w_me", "w_op", "threat2", "opp2",
                  "adv", "detour", "share", "vuln", "attack", "width", "center",
                  "threat1", "opp1"];
  const TYPES = ["이동", "공격 벽", "수비 벽", "기타 벽"];
  const DETOUR_CAP = 5.0;

  function setWall(s, k, v) { if (k < 64) s[HW0 + k] = v; else s[VW0 + k - 64] = v; }
  function fdist(s, p, buf) { bfsGoal(s, 8 * p, buf); return buf[s[2 * p] * 9 + s[2 * p + 1]]; }
  function onSp(df, dg, x, y, D) {
    if (df[x] >= 0 && dg[y] >= 0 && df[x] + 1 + dg[y] === D) return true;
    if (df[y] >= 0 && dg[x] >= 0 && df[y] + 1 + dg[x] === D) return true;
    return false;
  }
  function cutList(s, p, out, dg, df) {
    bfsGoal(s, 8 * p, dg);
    const src = s[2 * p] * 9 + s[2 * p + 1];
    bfsCell(s, src, df);
    const D = dg[src];
    let n = 0;
    for (let k = 0; k < 128; k++) {
      const kind = (k / 64) | 0, i = k % 64, r = (i / 8) | 0, c = i % 8;
      if (!wallStructOk(s, kind, r, c)) continue;
      let x1, y1, x2, y2;
      if (kind === 0) { x1 = r * 9 + c; y1 = (r + 1) * 9 + c; x2 = x1 + 1; y2 = y1 + 1; }
      else { x1 = r * 9 + c; y1 = x1 + 1; x2 = (r + 1) * 9 + c; y2 = x2 + 1; }
      if (onSp(df, dg, x1, y1, D) || onSp(df, dg, x2, y2, D)) out[n++] = k;
    }
    return n;
  }
  const MI_S = new Int16Array(SLEN), MI_DG = new Int16Array(81), MI_DF = new Int16Array(81);
  const MI_D0 = new Int16Array(81), MI_D1 = new Int16Array(81);
  const MI_LA = new Int32Array(128), MI_LB = new Int32Array(128);
  /** [best increase of p's distance with 1 wall, with up to 2 walls], nw = walls available to the other side. */
  function maxInc12(s0, p, nw) {
    if (nw <= 0) return [0, 0];
    const s = MI_S; s.set(s0);
    const q = 1 - p;
    const base = fdist(s, p, MI_D0);
    const na = cutList(s, p, MI_LA, MI_DG, MI_DF);
    let best1 = 0, best2 = 0;
    for (let i = 0; i < na; i++) {
      const ka = MI_LA[i];
      setWall(s, ka, 1);
      const dp = fdist(s, p, MI_D0);
      if (dp >= 0 && fdist(s, q, MI_D1) >= 0) {
        if (dp - base > best1) best1 = dp - base;
        if (nw >= 2) {
          const nb = cutList(s, p, MI_LB, MI_DG, MI_DF);
          for (let j = 0; j < nb; j++) {
            const kb = MI_LB[j];
            setWall(s, kb, 1);
            const dp2 = fdist(s, p, MI_D0);
            if (dp2 >= 0 && fdist(s, q, MI_D1) >= 0) { if (dp2 - base > best2) best2 = dp2 - base; }
            setWall(s, kb, 0);
          }
        }
      }
      setWall(s, ka, 0);
    }
    if (best1 > best2) best2 = best1;
    return [best1, best2];
  }
  function widthCells(s, p, dg, df) {
    bfsGoal(s, 8 * p, dg);
    const src = s[2 * p] * 9 + s[2 * p + 1];
    bfsCell(s, src, df);
    const D = dg[src];
    let n = 0;
    for (let x = 0; x < 81; x++) if (df[x] >= 0 && dg[x] >= 0 && df[x] + dg[x] === D) n++;
    return n;
  }
  const CO_DG = new Int16Array(81), CO_DF = new Int16Array(81);
  /** core(s): per player [dist, inc1, inc2, width_cells, rows_left] */
  function core(s) {
    const out = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
    for (let p = 0; p < 2; p++) {
      const q = 1 - p;
      out[p][0] = fdist(s, p, CO_DG);
      let nw = s[4 + q];
      if (nw > 2) nw = 2;
      const [b1, b2] = maxInc12(s, p, nw);
      out[p][1] = b1;
      out[p][2] = b2;
      out[p][3] = widthCells(s, p, CO_DG, CO_DF);
      out[p][4] = p === 0 ? s[2 * p] : 8 - s[2 * p];
    }
    return out;
  }
  /** Feature vector (FNAMES order) of state s from player m's viewpoint, given cr = core(s). */
  function fvec(s, cr, m) {
    const o = 1 - m;
    const f = new Array(15).fill(0);
    const dMe = cr[m][0], dOp = cr[o][0];
    const wMe = s[4 + m], wOp = s[4 + o];
    f[0] = dMe; f[1] = dOp; f[2] = wMe; f[3] = wOp;
    f[4] = cr[m][2]; f[5] = cr[o][2];
    f[6] = dOp - dMe;
    const rows = cr[m][4];
    if (rows <= 0) f[7] = 1.0;
    else { const v = dMe / rows; f[7] = v < DETOUR_CAP ? v : DETOUR_CAP; }
    f[8] = wMe + wOp === 0 ? 0.5 : wMe / (wMe + wOp);
    f[9] = dMe <= 0 ? 0.0 : cr[m][1] / dMe;
    f[10] = dOp <= 0 ? 0.0 : cr[o][1] / dOp;
    f[11] = cr[m][3] / (dMe + 1.0);
    f[12] = Math.abs(s[2 * m + 1] - 4) / 4.0;
    f[13] = cr[m][1];
    f[14] = cr[o][1];
    return f;
  }
  /** Action type (0 move, 1 attack wall, 2 defensive wall, 3 other wall) from the mover's vectors. */
  function classify(a, fb, fa) {
    if (a < 81) return 0;
    if (fa[1] > fb[1]) return 1;
    if (fa[13] <= fb[13] && fa[4] <= fb[4] && (fa[13] < fb[13] || fa[4] < fb[4])) return 2;
    return 3;
  }

  root.BE = {
    P0R, P0C, P1R, P1C, WL0, WL1, TURN, PLY, HW0, VW0, SLEN, MAX_WALLS, WIN, MATE,
    initState, canStep, bfsGoal, bfsCell, pathDist, pawnMoves, wallStructOk, legalActions,
    applyAction, winner, zhash, decode, actionStr, parseAction, shortestPath,
    evaluate, genMoves, AlphaBeta, DEFAULT_PARAMS,
    FNAMES, TYPES, core, fvec, classify, maxInc12, cutList, widthCells,
  };
})(typeof self !== "undefined" ? self : globalThis);
