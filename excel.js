/* Builds the single Excel file with every team member's games (ExcelJS). Pure function of the rows,
 * so it can also be run under Node for testing. */
(function (root) {
  "use strict";
  const FN = ["d_me", "d_op", "w_me", "w_op", "threat2", "opp2", "adv", "detour", "share", "vuln",
              "attack", "width", "center", "threat1", "opp1"];
  const KO = {
    d_me: "내 거리", d_op: "상대 거리", w_me: "내 남은 벽", w_op: "상대 남은 벽",
    threat2: "갈래 봉쇄 위협(벽2)", opp2: "갈래 봉쇄 기회(벽2)", adv: "거리 우위", detour: "우회율",
    share: "벽 점유율", vuln: "경로 취약도", attack: "공격 잠재력", width: "경로 폭", center: "중앙 이탈도",
    threat1: "위협(벽1)", opp1: "기회(벽1)",
  };
  const MATE = 99000;
  const r4 = (x) => (x === null || x === undefined ? null : Math.round(x * 1e4) / 1e4);
  const kst = (iso) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }); } catch (e) { return iso; }
  };
  const isMate = (v) => v !== null && v !== undefined && Math.abs(v) > MATE;

  const HEAD_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDE6D8" } };
  const GROUP_FILLS = ["FFD9E4F2", "FFE3EFD9", "FFF6E3C8", "FFEADDF0"].map((c) => ({ type: "pattern", pattern: "solid", fgColor: { argb: c } }));
  const BORDER = { bottom: { style: "thin", color: { argb: "FFB8AE9C" } } };

  function styleHeader(row, fill) {
    row.eachCell((c) => {
      c.font = { bold: true };
      c.fill = fill || HEAD_FILL;
      c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      c.border = BORDER;
    });
  }

  /** games/moves: rows as stored in Supabase. Returns an ExcelJS workbook. */
  function buildWorkbook(ExcelJS, games, moves) {
    const byGame = new Map();
    for (const m of moves) {
      if (!byGame.has(m.game_id)) byGame.set(m.game_id, []);
      byGame.get(m.game_id).push(m);
    }
    for (const list of byGame.values()) list.sort((a, b) => a.ply - b.ply);
    const played = games.filter((g) => byGame.has(g.id))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

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
      info.set(g.id, {
        no: i + 1, g, list, done, result,
        level: levels.length === 1 ? levels[0] : (levels.length ? levels.join("→") : (g.start_level ?? "")),
        plies: list.length, mine: mine.length,
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

    // ------------------------------------------------------------ 경기 요약
    const ws1 = wb.addWorksheet("경기 요약", { views: [{ state: "frozen", ySplit: 1 }] });
    const h1 = ["경기 번호", "시작 시각", "플레이어", "기기", "내 진영", "AI 강도", "결과", "총 수", "내 수",
                "내 벽 사용", "AI 벽 사용", "내 이동", "내 공격 벽", "내 수비 벽", "내 기타 벽",
                "AI 추천 일치율", "평균 평가 손실", "경기 ID"];
    ws1.addRow(h1);
    styleHeader(ws1.getRow(1));
    for (const g of played) {
      const x = info.get(g.id);
      ws1.addRow([x.no, kst(g.created_at), g.player, g.device || "", g.my_side === 0 ? "선공" : "후공", x.level,
                  x.result, x.plies, x.mine, x.myWalls, x.aiWalls, ...x.types,
                  x.recRate === null ? null : r4(x.recRate), x.meanLoss === null ? null : Math.round(x.meanLoss * 10) / 10, g.id]);
    }
    ws1.getColumn(16).numFmt = "0.0%";
    [9, 20, 12, 8, 8, 9, 8, 7, 7, 9, 9, 8, 10, 10, 10, 12, 12, 38].forEach((w, i) => { ws1.getColumn(i + 1).width = w; });
    if (played.length) ws1.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: h1.length } };

    // ------------------------------------------------------------ 수 기록
    const ws2 = wb.addWorksheet("수 기록", { views: [{ state: "frozen", ySplit: 2, xSplit: 4 }] });
    const base = ["경기 번호", "플레이어", "이 판 결과", "수 번호", "둔 쪽", "수", "행동 종류", "국면", "AI 강도"];
    const before = FN.map((n) => KO[n]);
    const delta = FN.map((n) => "Δ " + KO[n]);
    const ai = ["AI 평가 (나 기준)", "AI 탐색 깊이", "AI 탐색 노드", "생각 시간(초)", "AI 추천 수", "추천과 같은 수",
                "추천 수 평가", "내 수 평가", "평가 손실", "기록 시각", "경기 ID"];
    const groups = [["기본 정보", base.length], ["두기 전 값 (나 기준)", FN.length],
                    ["변화량 (둔 뒤 − 두기 전, 나 기준)", FN.length], ["AI 정보 (점수 100 = 1수, + 는 나에게 유리)", ai.length]];
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
    const headers = [...base, ...before, ...delta, ...ai];
    const hRow = ws2.addRow(headers);
    styleHeader(hRow);
    hRow.height = 32;
    let fillCol = 1;
    groups.forEach(([, n], gi) => { for (let i = 0; i < n; i++) hRow.getCell(fillCol + i).fill = GROUP_FILLS[gi]; fillCol += n; });

    for (const g of played) {
      const x = info.get(g.id);
      for (const m of x.list) {
        ws2.addRow([
          x.no, g.player, x.result, m.ply, m.mover, m.notation, m.action_type, m.phase, m.ai_level,
          ...FN.map((n) => r4(m["b_" + n])),
          ...FN.map((n) => r4(m["c_" + n])),
          m.ai_score, m.ai_depth, m.ai_nodes,
          m.think_ms === null || m.think_ms === undefined ? null : Math.round(m.think_ms / 100) / 10,
          m.rec_notation, m.rec_match === null || m.rec_match === undefined ? null : (m.rec_match ? "예" : "아니오"),
          m.rec_score, m.after_score, m.eval_loss, kst(m.created_at), g.id,
        ]);
      }
    }
    const widths = [8, 12, 8, 7, 6, 6, 9, 6, 7, ...FN.map(() => 9), ...FN.map(() => 9), 10, 8, 10, 9, 9, 9, 9, 9, 9, 20, 38];
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
    const notes = [
      ["기준", "모든 값은 플레이한 사람(나) 기준입니다. AI가 둔 수의 줄도 '나' 기준 값입니다. 행동 종류만 그 수를 둔 쪽 기준입니다."],
      ["거리", "말에서 목표 줄까지의 최단 거리(칸 수). 상대 말은 무시하고 벽만 고려합니다."],
      ["내 거리 / 상대 거리", "나와 상대의 최단 거리."],
      ["내 남은 벽 / 상대 남은 벽", "각자 남은 벽 개수(처음 10개)."],
      ["갈래 봉쇄 위협(벽2)", "상대가 벽을 최대 2개(상대 남은 벽 수 한도) 더 놓아 늘릴 수 있는 내 최단 거리의 최대 증가량."],
      ["갈래 봉쇄 기회(벽2)", "내가 벽을 최대 2개 더 놓아 늘릴 수 있는 상대 최단 거리의 최대 증가량."],
      ["거리 우위", "상대 거리 − 내 거리. 클수록 내가 앞섭니다."],
      ["우회율", "내 거리 ÷ 목표까지 남은 줄 수 (최대 5, 남은 줄이 0이면 1)."],
      ["벽 점유율", "내 남은 벽 ÷ (양쪽 남은 벽 합). 둘 다 0이면 0.5."],
      ["경로 취약도", "위협(벽1) ÷ 내 거리."],
      ["공격 잠재력", "기회(벽1) ÷ 상대 거리."],
      ["경로 폭", "내 최단 경로들이 지나는 칸 수 ÷ (내 거리 + 1). 클수록 갈 길이 여러 갈래입니다."],
      ["중앙 이탈도", "|내 말의 열 − 가운데 열| ÷ 4. 0이면 가운데, 1이면 가장자리."],
      ["위협(벽1) / 기회(벽1)", "벽 1개로 늘릴 수 있는 내 거리 / 상대 거리의 최대 증가량."],
      ["Δ (변화량)", "그 수를 둔 뒤 값 − 두기 전 값."],
      ["행동 종류", "이동 / 공격 벽(상대 거리를 늘린 벽) / 수비 벽(둔 쪽의 위협(벽1)·위협(벽2) 중 하나 이상을 줄이고 어느 것도 늘리지 않은 벽) / 기타 벽."],
      ["국면", "두기 전 국면 기준. 종반: 누군가의 최단 거리가 3 이하이거나 한쪽 벽이 다 떨어짐(먼저 판정). 초반: 양쪽 모두 벽을 2개 이하로 씀. 그 밖은 중반."],
      ["AI 강도", "AI 알파베타 탐색 깊이(몇 수 앞까지 보는지). 그 수를 둘 때의 설정값입니다."],
      ["AI 평가 (나 기준)", "AI가 자기 수를 고를 때 본 형세를 나 기준으로 바꾼 값. 100 = 1수 차이, + 는 나에게 유리. ±99,000을 넘으면 강제 승패 수순을 찾았다는 뜻입니다."],
      ["AI 추천 수", "내 차례에 AI가 같은 강도로 계산한 '나라면 둘 수'."],
      ["추천 수 평가", "AI 추천 수를 뒀을 때의 형세(나 기준). 그때 강도(깊이)로 계산합니다."],
      ["내 수 평가", "내가 실제로 둔 수를 추천 수와 같은 깊이로 계산한 형세(나 기준)."],
      ["평가 손실", "추천 수 평가 − 내 수 평가. 0이면 AI가 보기에 최선과 같은 수준, 클수록 손해 본 수입니다. 강제 승패 수순이 걸린 경우와 강도 1은 비웁니다. 계산 순서 차이로 드물게 음수가 나올 수 있습니다."],
      ["생각 시간", "그 수를 두기까지 걸린 시간(초). 내 수는 내 차례가 된 때부터, AI 수는 AI 계산 시간입니다."],
      ["결과", "승 / 패 / 미완료(중간에 새 게임을 시작했거나 창을 닫은 판)."],
    ];
    for (const n of notes) ws4.addRow(n);
    ws4.getColumn(1).width = 26;
    ws4.getColumn(2).width = 110;
    ws4.eachRow((r, i) => { if (i > 1) r.getCell(2).alignment = { wrapText: true, vertical: "top" }; });
    return wb;
  }

  root.BR_EXCEL = { buildWorkbook, isMate };
})(typeof self !== "undefined" ? self : globalThis);
