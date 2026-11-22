/* Builds the single Excel file with every team member's games (ExcelJS), including the late-game
 * factor graphs. Pure functions of the stored rows, so they can also be run under Node for testing.
 *   buildWorkbook(ExcelJS, games, moves) -> { wb, charts }   (charts are added afterwards by xlcharts.js)
 *   lateStats(games, moves)              -> per-factor late-game win rates and weighted regression
 */
(function (root) {
  "use strict";
  // the team's six factors (independent variables), in the order of the team slides
  const SIX = [
    { key: "detour", name: "우회율", formula: "내 남은 최단거리 ÷ 목표까지 남은 줄 수", step: 0.1 },
    { key: "share", name: "벽 점유율", formula: "내 남은 벽 ÷ (내 남은 벽 + 상대 남은 벽)", step: 0.1 },
    { key: "vuln", name: "경로 취약도", formula: "상대가 벽 1개로 늘릴 수 있는 내 거리 최대 증가량 ÷ 내 최단거리", step: 0.1 },
    { key: "attack", name: "공격 잠재력", formula: "내가 벽 1개로 늘릴 수 있는 상대 거리 최대 증가량 ÷ 상대 최단거리", step: 0.1 },
    { key: "width", name: "경로 폭", formula: "최단경로 위 칸 수 ÷ (내 남은 최단거리 + 1)", step: 0.1 },
    { key: "center", name: "중앙 이탈도", formula: "|내 말 열 번호(1~9) − 5| ÷ 4", step: 0.25 },
  ];
  const REF = [
    ["d_me", "내 거리"], ["d_op", "상대 거리"], ["w_me", "내 남은 벽"], ["w_op", "상대 남은 벽"], ["adv", "거리 우위"],
    ["threat1", "위협(벽1)"], ["opp1", "기회(벽1)"], ["threat2", "갈래 봉쇄 위협(벽2)"], ["opp2", "갈래 봉쇄 기회(벽2)"],
  ];
  const MIN_N = 10;            // bins with fewer games are shown in grey and left out of the regression
  const LATE_SHEET = "후반 그래프";
  const MATE = 99000;
  const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥"];

  const r4 = (x) => (x === null || x === undefined ? null : Math.round(x * 1e4) / 1e4);
  const kst = (iso) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }); } catch (e) { return iso; }
  };
  const isMate = (v) => v !== null && v !== undefined && Math.abs(v) > MATE;
  /** Korean subject particle 이/가 after a word. */
  const iga = (w) => { const c = w.charCodeAt(w.length - 1); return c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28 ? "이" : "가"; };

  /** Phase from the walls both players have used so far. opt.late = walls used from which 후반 starts (default 14),
   * opt.onEmpty = a player with no walls left also means 후반 (default true). */
  const normOpt = (opt) => ({ late: opt && opt.late ? opt.late : 14, onEmpty: !(opt && opt.onEmpty === false) });
  function phaseFromWalls(wMe, wOp, opt) {
    const o = normOpt(opt);
    const used = 20 - wMe - wOp;
    if (used >= o.late || (o.onEmpty && (wMe === 0 || wOp === 0))) return "후반";
    if (used >= 6) return "중반";
    return "초반";
  }
  const phaseOfRow = (m, opt) => (m.b_w_me === null || m.b_w_me === undefined ? (m.phase === "종반" ? "후반" : m.phase)
                                                                              : phaseFromWalls(m.b_w_me, m.b_w_op, opt));
  /** Human-readable description of the phase rule in use. */
  function ruleText(opt) {
    const o = normOpt(opt);
    const mid = o.late > 6 ? "6~" + (o.late - 1) + "개 중반, " : "";
    return "두 사람이 쓴 벽의 합계 " + (o.late > 6 ? "0~5개 초반, " : "0~" + (o.late - 1) + "개 초반, ") + mid + o.late + "개 이상" +
           (o.onEmpty ? "이거나 한쪽 벽이 다 떨어지면" : "이면") + " 후반";
  }

  /** Bin of a factor value: 0.1-wide bins, or the five exact levels of 중앙 이탈도. */
  function binOf(f, x) {
    if (f.step === 0.25) {
      const k = Math.round(x * 4);
      return { k, label: (k / 4).toFixed(2), x: k / 4 };
    }
    const k = Math.floor(x * 10 + 1e-6);
    return { k, label: (k / 10).toFixed(1) + "~" + ((k + 1) / 10).toFixed(1), x: (k + 0.5) / 10 };
  }

  function groupGames(games, moves) {
    const byGame = new Map();
    for (const m of moves) {
      if (!byGame.has(m.game_id)) byGame.set(m.game_id, []);
      byGame.get(m.game_id).push(m);
    }
    for (const list of byGame.values()) list.sort((a, b) => a.ply - b.ply);
    const played = games.filter((g) => byGame.has(g.id))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return { byGame, played };
  }

  /** Weighted least squares y = a + b x (weights w). Returns null with fewer than 2 distinct x. */
  function wls(pts) {
    const W = pts.reduce((s, p) => s + p.w, 0);
    if (pts.length < 2 || W <= 0) return null;
    const mx = pts.reduce((s, p) => s + p.w * p.x, 0) / W;
    const my = pts.reduce((s, p) => s + p.w * p.y, 0) / W;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) { sxx += p.w * (p.x - mx) ** 2; sxy += p.w * (p.x - mx) * (p.y - my); syy += p.w * (p.y - my) ** 2; }
    if (sxx <= 1e-12) return null;
    const b = sxy / sxx, a = my - b * mx;
    let sres = 0;
    for (const p of pts) sres += p.w * (p.y - a - b * p.x) ** 2;
    return { a, b, r2: syy > 1e-12 ? 1 - sres / syy : null, n: pts.length };
  }

  /** Late-game win rate per factor bin. Each finished game counts at most once per bin. */
  function lateStats(games, moves, opt) {
    const { byGame, played } = groupGames(games, moves);
    const used = [];
    for (const g of played) {
      const list = byGame.get(g.id);
      const last = list[list.length - 1];
      if (!last || !last.game_over) continue;            // unfinished games have no result
      const late = list.filter((m) => phaseOfRow(m, opt) === "후반");
      if (!late.length) continue;
      used.push({ g, won: last.winner === "나", late });
    }
    const levels = new Map();
    for (const u of used) {
      const lv = u.g.start_level ?? "?";
      levels.set(lv, (levels.get(lv) || 0) + 1);
    }
    const factors = SIX.map((f) => {
      const bins = new Map();
      for (const u of used) {
        const seen = new Set();
        for (const m of u.late) {
          const v = m["b_" + f.key];
          if (v === null || v === undefined) continue;
          const b = binOf(f, v);
          if (seen.has(b.k)) continue;
          seen.add(b.k);
          if (!bins.has(b.k)) bins.set(b.k, { k: b.k, label: b.label, x: b.x, games: 0, wins: 0 });
          const e = bins.get(b.k);
          e.games++;
          if (u.won) e.wins++;
        }
      }
      const list = [...bins.values()].sort((a, b) => a.k - b.k);
      for (const e of list) e.rate = e.games ? e.wins / e.games : null;
      const fit = wls(list.filter((e) => e.games >= MIN_N).map((e) => ({ x: e.x, y: e.rate, w: e.games })));
      let lo = null, hi = null;
      for (const e of list) if (e.games >= MIN_N) { lo = lo === null ? e.x : Math.min(lo, e.x); hi = hi === null ? e.x : Math.max(hi, e.x); }
      for (const e of list) e.pred = fit && e.x >= lo - 1e-9 && e.x <= hi + 1e-9 ? fit.a + fit.b * e.x : null;
      return { f, bins: list, fit };
    });
    return { games: used.length, wins: used.filter((u) => u.won).length, levels: [...levels.entries()], factors };
  }

  const HEAD_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDE6D8" } };
  const GROUP_FILLS = ["FFD9E4F2", "FFE3EFD9", "FFF6E3C8", "FFE7E7E7", "FFEADDF0"].map((c) => ({ type: "pattern", pattern: "solid", fgColor: { argb: c } }));
  const BORDER = { bottom: { style: "thin", color: { argb: "FFB8AE9C" } } };
  function styleHeader(row, fill) {
    row.eachCell((c) => {
      c.font = { bold: true };
      c.fill = fill || HEAD_FILL;
      c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      c.border = BORDER;
    });
  }
  const colLetter = (n) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; };

  /** games/moves: rows as stored in Supabase. Returns { wb, charts }. */
  function buildWorkbook(ExcelJS, games, moves, opt) {
    const o = normOpt(opt);
    const { byGame, played } = groupGames(games, moves);
    const info = new Map();
    played.forEach((g, i) => {
      const list = byGame.get(g.id);
      const last = list[list.length - 1];
      const done = !!(last && last.game_over);
      const result = done ? (last.winner === "나" ? "승" : "패") : "미완료";
      const mine = list.filter((m) => m.mover === "나");
      const theirs = list.filter((m) => m.mover === "AI");
      const levels = [];
      for (const m of list) if (m.ai_level != null && levels[levels.length - 1] !== m.ai_level) levels.push(m.ai_level);
      const recs = mine.filter((m) => m.rec_match !== null && m.rec_match !== undefined);
      const losses = mine.filter((m) => m.eval_loss !== null && m.eval_loss !== undefined);
      const cnt = (t) => mine.filter((m) => m.action_type === t).length;
      const lateStart = list.find((m) => phaseOfRow(m, o) === "후반");
      info.set(g.id, {
        no: i + 1, g, list, done, result,
        level: levels.length === 1 ? levels[0] : (levels.length ? levels.join("→") : (g.start_level ?? "")),
        plies: list.length, mine: mine.length, lateStart: lateStart ? lateStart.ply : null,
        myWalls: mine.filter((m) => m.action >= 81).length,
        aiWalls: theirs.filter((m) => m.action >= 81).length,
        types: [cnt("이동"), cnt("공격 벽"), cnt("수비 벽"), cnt("기타 벽")],
        recRate: recs.length ? recs.filter((m) => m.rec_match).length / recs.length : null,
        meanLoss: losses.length ? losses.reduce((a, m) => a + m.eval_loss, 0) / losses.length : null,
      });
    });

    const wb = new ExcelJS.Workbook();
    wb.creator = "Barricade 기록 대국";
    wb.created = new Date();
    const charts = [];

    // ------------------------------------------------------------ 경기 요약
    const ws1 = wb.addWorksheet("경기 요약", { views: [{ state: "frozen", ySplit: 1 }] });
    const h1 = ["경기 번호", "시작 시각", "플레이어", "기기", "내 진영", "AI 강도", "결과", "총 수", "후반 시작 수", "내 수",
                "내 벽 사용", "AI 벽 사용", "내 이동", "내 공격 벽", "내 수비 벽", "내 기타 벽",
                "AI 추천 일치율", "평균 평가 손실", "경기 ID"];
    ws1.addRow(h1);
    styleHeader(ws1.getRow(1));
    for (const g of played) {
      const x = info.get(g.id);
      ws1.addRow([x.no, kst(g.created_at), g.player, g.device || "", g.my_side === 0 ? "선공" : "후공", x.level,
                  x.result, x.plies, x.lateStart === null ? "-" : x.lateStart, x.mine, x.myWalls, x.aiWalls, ...x.types,
                  x.recRate === null ? null : r4(x.recRate), x.meanLoss === null ? null : Math.round(x.meanLoss * 10) / 10, g.id]);
    }
    ws1.getColumn(17).numFmt = "0.0%";
    [9, 20, 12, 8, 8, 9, 8, 7, 10, 7, 9, 9, 8, 10, 10, 10, 12, 12, 38].forEach((w, i) => { ws1.getColumn(i + 1).width = w; });
    if (played.length) ws1.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: h1.length } };

    // ------------------------------------------------------------ 후반 그래프
    const st = lateStats(games, moves, o);
    const ws = wb.addWorksheet(LATE_SHEET, { views: [{ showGridLines: false }] });
    [13, 9, 8, 8, 9, 13, 13, 11].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    ws.getColumn(9).width = 3;
    ws.getCell("A1").value = "후반 국면 · 요인별 승률 그래프와 회귀 분석  (후반 기준: 쓴 벽 " + o.late + "개 이상" + (o.onEmpty ? " 또는 한쪽 벽 0개" : "") + ")";
    ws.getCell("A1").font = { bold: true, size: 14 };
    const notes = [
      "· 끝까지 둔 판의 후반 장면만 씁니다. 국면 기준: " + ruleText(o) + ".",
      "· 값은 모두 나(사람) 기준이고, 0.1 간격 구간으로 묶습니다 (중앙 이탈도는 0, 0.25, 0.5, 0.75, 1의 5단계).",
      "· 한 판에서 같은 구간이 여러 번 나와도 그 판은 그 구간에 한 번만 셉니다. 승률 = 그 구간을 지난 판 중 내가 이긴 판의 비율.",
      "· 회귀선: " + MIN_N + "판 이상인 구간만, 판 수를 가중치로 한 직선(가중 최소제곱법). " + MIN_N + "판 미만 구간은 회색 점으로만 표시합니다.",
    ];
    notes.forEach((t, i) => { const c = ws.getCell(2 + i, 1); c.value = t; c.font = { color: { argb: "FF6F685D" } }; });
    const lv = st.levels.map(([l, n]) => l + "(" + n + "판)").join(", ");
    ws.getCell(6, 1).value = "분석에 쓴 판: " + st.games + "판 (내가 이긴 판 " + st.wins + ", 진 판 " + (st.games - st.wins) + ")" +
      (lv ? " · 시작 시 AI 강도: " + lv : "");
    ws.getCell(6, 1).font = { bold: true };

    let r = 8;
    st.factors.forEach((F, fi) => {
      const f = F.f;
      const head = ws.getCell(r, 1);
      head.value = CIRCLED[fi] + " " + f.name + "  —  " + f.formula;
      head.font = { bold: true, size: 12 };
      const fit = F.fit;
      const sr = r + 1;
      const lab = ws.getRow(sr);
      ["기울기 b", "절편 a", "R²", "회귀에 쓴 구간"].forEach((x, i) => { lab.getCell(i + 1).value = x; });
      styleHeader(lab, { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3EFE7" } });
      const val = ws.getRow(sr + 1);
      val.values = [fit ? r4(fit.b) : "-", fit ? r4(fit.a) : "-", fit && fit.r2 !== null ? r4(fit.r2) : "-", fit ? fit.n : 0];
      for (let i = 1; i <= 4; i++) val.getCell(i).alignment = { horizontal: "center" };
      let msg;
      if (!F.bins.length) msg = "아직 자료가 없습니다.";
      else if (!fit) msg = MIN_N + "판 이상인 구간이 2개 미만이라 회귀선을 그리지 않았습니다. 판이 더 쌓이면 자동으로 그려집니다.";
      else {
        const per = f.step === 0.25 ? 0.25 : 0.1;
        const d = fit.b * per * 100;
        msg = "승률 = " + r4(fit.a) + " + (" + r4(fit.b) + ") × " + f.name + "  →  " + f.name + iga(f.name) + " " + per + " 오를 때 승률이 약 " +
              (d >= 0 ? "+" : "") + d.toFixed(1) + "%p " + (d >= 0 ? "올라갑니다" : "내려갑니다") +
              (fit.r2 !== null ? " (R² " + fit.r2.toFixed(2) + ")" : "");
      }
      const ir = sr + 2;
      ws.getCell(ir, 1).value = "해석";
      ws.getCell(ir, 1).font = { bold: true, color: { argb: "FF6F685D" } };
      ws.getCell(ir, 1).alignment = { vertical: "top" };
      ws.mergeCells(ir, 2, ir, 8);
      ws.getCell(ir, 2).value = msg;
      ws.getCell(ir, 2).alignment = { wrapText: true, vertical: "top" };
      ws.getRow(ir).height = 32;
      const hr = sr + 3;
      const hrow = ws.getRow(hr);
      ["구간", "구간 값(x)", "판 수", "이긴 판", "승률", "승률 (" + MIN_N + "판 이상)", "승률 (" + MIN_N + "판 미만)", "회귀 예측"]
        .forEach((x, i) => { hrow.getCell(i + 1).value = x; });
      styleHeader(hrow);
      hrow.height = 30;
      const first = hr + 1;
      F.bins.forEach((e, i) => {
        const row = ws.getRow(first + i);
        row.values = [e.label, e.x, e.games, e.wins, r4(e.rate),
                      e.games >= MIN_N ? r4(e.rate) : null, e.games < MIN_N ? r4(e.rate) : null,
                      e.pred === null ? null : r4(e.pred)];
        row.getCell(2).numFmt = f.step === 0.25 ? "0.00" : "0.00";
        for (const c of [5, 6, 7, 8]) row.getCell(c).numFmt = "0.0%";
        if (e.games < MIN_N) row.getCell(1).font = { color: { argb: "FF9B958B" } };
      });
      const last = first + Math.max(F.bins.length, 1) - 1;
      if (F.bins.length) {
        const ref = (col) => "'" + LATE_SHEET + "'!$" + col + "$" + first + ":$" + col + "$" + last;
        charts.push({
          sheet: LATE_SHEET,
          from: { col: 9, row: r - 1 }, to: { col: 18, row: r + 19 },
          title: "후반 · " + f.name + " 구간별 승률",
          xTitle: f.name + " (구간 값)", yTitle: "승률 (내가 이긴 판 비율)", xFmt: "0.0#",
          series: [
            { name: MIN_N + "판 이상 구간", kind: "points", color: "2F6DB5", xRef: ref("B"), yRef: ref("F"),
              xs: F.bins.map((e) => e.x), ys: F.bins.map((e) => (e.games >= MIN_N ? r4(e.rate) : null)) },
            { name: MIN_N + "판 미만 구간 (참고)", kind: "points", color: "B5B0A6", xRef: ref("B"), yRef: ref("G"),
              xs: F.bins.map((e) => e.x), ys: F.bins.map((e) => (e.games < MIN_N ? r4(e.rate) : null)) },
            { name: "회귀선", kind: "line", color: "C8463C", xRef: ref("B"), yRef: ref("H"),
              xs: F.bins.map((e) => e.x), ys: F.bins.map((e) => (e.pred === null ? null : r4(e.pred))) },
          ],
        });
      }
      r = Math.max(last + 3, r + 23);
    });

    // ------------------------------------------------------------ 수 기록
    const ws2 = wb.addWorksheet("수 기록", { views: [{ state: "frozen", ySplit: 2, xSplit: 4 }] });
    const base = ["경기 번호", "플레이어", "이 판 결과", "수 번호", "둔 쪽", "수", "행동 종류", "국면", "AI 강도"];
    const six = SIX.map((f) => f.name);
    const sixD = SIX.map((f) => "Δ " + f.name);
    const ref = REF.map(([, n]) => n);
    const ai = ["AI 평가 (나 기준)", "AI 탐색 깊이", "AI 탐색 노드", "생각 시간(초)", "AI 추천 수", "추천과 같은 수",
                "추천 수 평가", "내 수 평가", "평가 손실", "기록 시각", "경기 ID"];
    const groups = [["기본 정보", base.length], ["6개 요인 (두기 전, 나 기준)", six.length],
                    ["6개 요인 변화량 (둔 뒤 − 두기 전)", sixD.length], ["참고 값 (두기 전, 나 기준)", ref.length],
                    ["AI 정보 (점수 100 = 1수, + 는 나에게 유리)", ai.length]];
    const gRow = ws2.addRow([]);
    let col = 1;
    groups.forEach(([label, n], gi) => {
      ws2.mergeCells(1, col, 1, col + n - 1);
      const c = ws2.getCell(1, col);
      c.value = label;
      c.font = { bold: true };
      c.fill = GROUP_FILLS[gi];
      c.alignment = { horizontal: "center", vertical: "middle" };
      col += n;
    });
    gRow.height = 20;
    const headers = [...base, ...six, ...sixD, ...ref, ...ai];
    const hRow = ws2.addRow(headers);
    styleHeader(hRow);
    hRow.height = 32;
    let fillCol = 1;
    groups.forEach(([, n], gi) => { for (let i = 0; i < n; i++) hRow.getCell(fillCol + i).fill = GROUP_FILLS[gi]; fillCol += n; });
    for (const g of played) {
      const x = info.get(g.id);
      for (const m of x.list) {
        ws2.addRow([
          x.no, g.player, x.result, m.ply, m.mover, m.notation, m.action_type, phaseOfRow(m, o), m.ai_level,
          ...SIX.map((f) => r4(m["b_" + f.key])),
          ...SIX.map((f) => r4(m["c_" + f.key])),
          ...REF.map(([k]) => r4(m["b_" + k])),
          m.ai_score, m.ai_depth, m.ai_nodes,
          m.think_ms === null || m.think_ms === undefined ? null : Math.round(m.think_ms / 100) / 10,
          m.rec_notation, m.rec_match === null || m.rec_match === undefined ? null : (m.rec_match ? "예" : "아니오"),
          m.rec_score, m.after_score, m.eval_loss, kst(m.created_at), g.id,
        ]);
      }
    }
    const widths = [8, 12, 8, 7, 6, 6, 9, 6, 7, ...six.map(() => 10), ...sixD.map(() => 10), ...ref.map(() => 9),
                    10, 8, 10, 9, 9, 9, 9, 9, 9, 20, 38];
    widths.forEach((w, i) => { ws2.getColumn(i + 1).width = w; });
    ws2.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: headers.length } };

    // ------------------------------------------------------------ 플레이어별
    const ws3 = wb.addWorksheet("플레이어별", { views: [{ state: "frozen", ySplit: 1 }] });
    ws3.addRow(["플레이어", "경기 수", "완료", "승", "패", "승률", "미완료", "평균 수(완료 판)", "AI 추천 일치율"]);
    styleHeader(ws3.getRow(1));
    const players = new Map();
    for (const g of played) {
      const x = info.get(g.id);
      if (!players.has(g.player)) players.set(g.player, []);
      players.get(g.player).push(x);
    }
    for (const [name, xs] of players) {
      const done = xs.filter((x) => x.done);
      const win = done.filter((x) => x.result === "승").length;
      let recN = 0, recY = 0;
      for (const x of xs) for (const m of x.list) if (m.mover === "나" && m.rec_match !== null && m.rec_match !== undefined) { recN++; if (m.rec_match) recY++; }
      ws3.addRow([name, xs.length, done.length, win, done.length - win, done.length ? r4(win / done.length) : null,
                  xs.length - done.length, done.length ? Math.round(done.reduce((a, x) => a + x.plies, 0) / done.length * 10) / 10 : null,
                  recN ? r4(recY / recN) : null]);
    }
    ws3.getColumn(6).numFmt = "0.0%";
    ws3.getColumn(9).numFmt = "0.0%";
    [14, 8, 8, 6, 6, 8, 8, 14, 14].forEach((w, i) => { ws3.getColumn(i + 1).width = w; });

    // ------------------------------------------------------------ 요인 설명
    const ws4 = wb.addWorksheet("요인 설명");
    ws4.addRow(["항목", "설명"]);
    styleHeader(ws4.getRow(1));
    const rows = [
      ["기준", "모든 값은 플레이한 사람(나) 기준입니다. AI가 둔 수의 줄도 '나' 기준 값입니다. 행동 종류만 그 수를 둔 쪽 기준입니다. 최단거리는 상대 말은 무시하고 벽만 고려해 BFS로 계산합니다."],
      ...SIX.map((f) => [f.name, f.formula + (f.key === "detour" ? " (최대 5, 목표 줄에 도착했으면 1)" : f.key === "share" ? " (양쪽 다 0개면 0.5)" : "")]),
      ["Δ (변화량)", "그 수를 둔 뒤 값 − 두기 전 값."],
      ["내 거리 / 상대 거리", "말에서 목표 줄까지의 최단거리(칸 수)."],
      ["내 남은 벽 / 상대 남은 벽", "각자 남은 벽 개수(처음 10개)."],
      ["거리 우위", "상대 거리 − 내 거리. 클수록 내가 앞섭니다."],
      ["위협(벽1) / 기회(벽1)", "벽 1개로 늘릴 수 있는 내 거리 / 상대 거리의 최대 증가량."],
      ["갈래 봉쇄 위협·기회(벽2)", "벽을 최대 2개 더 놓아 늘릴 수 있는 내 거리 / 상대 거리의 최대 증가량."],
      ["행동 종류", "이동 / 공격 벽(상대 거리를 늘린 벽) / 수비 벽(둔 쪽의 위협(벽1)·위협(벽2) 중 하나 이상을 줄이고 어느 것도 늘리지 않은 벽) / 기타 벽."],
      ["국면", "두기 전 국면 기준, 이 파일은 '" + ruleText(o) + "'으로 나눴습니다. 기준은 앱의 '엑셀 후반 그래프 기준'에서 바꿀 수 있고, 이미 둔 판도 남은 벽 수로 다시 계산합니다. (기록에 저장되는 국면 이름표는 14개 기준)"],
      ["후반 그래프", "끝까지 둔 판의 후반 장면만 쓰고, 한 판은 한 구간에 한 번만 셉니다. 구간 승률 = 그 구간을 지난 판 중 내가 이긴 판 비율. 회귀선은 " + MIN_N + "판 이상인 구간만 판 수를 가중치로 한 직선입니다. 기울기는 요인이 1 오를 때 승률 변화, R²는 선이 점들을 얼마나 잘 설명하는지(0~1)입니다."],
      ["AI 강도", "AI 알파베타 탐색 깊이(몇 수 앞까지 보는지). 그 수를 둘 때의 설정값입니다."],
      ["AI 평가 (나 기준)", "AI가 자기 수를 고를 때 본 형세를 나 기준으로 바꾼 값. 100 = 1수 차이, + 는 나에게 유리. ±99,000을 넘으면 강제 승패 수순을 찾았다는 뜻입니다."],
      ["AI 추천 수", "내 차례에 AI가 같은 강도로 계산한 '나라면 둘 수'."],
      ["추천 수 평가 / 내 수 평가", "AI 추천 수와 내가 실제로 둔 수를 같은 깊이로 계산한 형세(나 기준)."],
      ["평가 손실", "추천 수 평가 − 내 수 평가. 0이면 AI가 보기에 최선과 같은 수준, 클수록 손해 본 수입니다. 강제 승패 수순이 걸린 경우와 강도 1은 비웁니다."],
      ["생각 시간", "그 수를 두기까지 걸린 시간(초). 내 수는 내 차례가 된 때부터, AI 수는 AI 계산 시간입니다."],
      ["결과", "승 / 패 / 미완료(중간에 새 게임을 시작했거나 창을 닫은 판)."],
    ];
    for (const n of rows) ws4.addRow(n);
    ws4.getColumn(1).width = 26;
    ws4.getColumn(2).width = 110;
    ws4.eachRow((rw, i) => { if (i > 1) rw.getCell(2).alignment = { wrapText: true, vertical: "top" }; });
    return { wb, charts };
  }

  root.BR_EXCEL = { buildWorkbook, lateStats, phaseFromWalls, ruleText, binOf, wls, isMate, SIX, MIN_N, colLetter };
})(typeof self !== "undefined" ? self : globalThis);
