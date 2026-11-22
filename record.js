/* Builds one record row per move: factor values from the human player's viewpoint before the move,
 * the change the move made, the action type (from the mover's viewpoint, as in the similar-position
 * project) and the game phase. Shared by the page and the Node tests. */
(function (root) {
  "use strict";
  const B = root.BE;
  const FN = B.FNAMES;
  const KO = {
    d_me: "내 거리", d_op: "상대 거리", w_me: "내 남은 벽", w_op: "상대 남은 벽",
    threat2: "갈래 봉쇄 위협(벽2)", opp2: "갈래 봉쇄 기회(벽2)", adv: "거리 우위", detour: "우회율",
    share: "벽 점유율", vuln: "경로 취약도", attack: "공격 잠재력", width: "경로 폭", center: "중앙 이탈도",
    threat1: "위협(벽1)", opp1: "기회(벽1)",
  };
  const clean = (x) => Math.round(x * 1e10) / 1e10;   // drop floating-point noise such as 0.19999999999999998

  /** Game phase from the walls both players have used so far (position before the move; never goes back):
   * 초반 0-5 walls used in total, 중반 6-13, 후반 14 or more or one player has no walls left (the stored label).
   * opt = { late, onEmpty } changes the 후반 threshold for analysis and display. */
  function phaseFromWalls(wlA, wlB, opt) {
    const late = opt && opt.late ? opt.late : 14;
    const onEmpty = opt && opt.onEmpty === false ? false : true;
    const used = 2 * B.MAX_WALLS - wlA - wlB;
    if (used >= late || (onEmpty && (wlA === 0 || wlB === 0))) return "후반";
    if (used >= 6) return "중반";
    return "초반";
  }
  function phaseOf(s) { return phaseFromWalls(s[B.WL0], s[B.WL1]); }

  /** Factor snapshot of a position: core + vectors for both players. */
  function snapshot(s) {
    const cr = B.core(s);
    return { cr, f: [B.fvec(s, cr, 0), B.fvec(s, cr, 1)] };
  }

  /** Row for move a played in position sBefore; human = the human player's index (0/1). */
  function moveRow(sBefore, a, human, before) {
    const mover = sBefore[B.TURN];
    const snapB = before || snapshot(sBefore);
    const sA = sBefore.slice();
    B.applyAction(sA, a);
    const snapA = snapshot(sA);
    const type = B.classify(a, snapB.f[mover], snapA.f[mover]);
    const fb = snapB.f[human], fa = snapA.f[human];
    const row = {
      mover: mover === human ? "나" : "AI",
      notation: B.actionStr(a),
      action: a,
      action_type: B.TYPES[type],
      phase: phaseOf(sBefore),
    };
    for (let k = 0; k < FN.length; k++) {
      row["b_" + FN[k]] = clean(fb[k]);
      row["c_" + FN[k]] = clean(fa[k] - fb[k]);
    }
    const w = B.winner(sA);
    row.game_over = w >= 0;
    row.winner = w < 0 ? null : (w === human ? "나" : "AI");
    return { row, after: sA, snapAfter: snapA };
  }

  root.BR_RECORD = { FN, KO, phaseOf, phaseFromWalls, snapshot, moveRow };
})(typeof self !== "undefined" ? self : globalThis);
