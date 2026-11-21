/* Web Worker running one alpha-beta engine (its transposition table is kept between moves,
 * exactly like the single shared engine of the Python web server). */
importScripts("zobrist.js", "engine.js");

const ab = new BE.AlphaBeta({ depth: 6, nodes: 3000000, wallK: 8 });

onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === "reset") {
      ab.reset();
      postMessage({ id: m.id, ok: true });
    } else if (m.type === "search") {
      const s = Int16Array.from(m.s);
      const t0 = performance.now();
      const r = ab.search(s, m.depth);
      const ms = Math.round(performance.now() - t0);
      postMessage({ id: m.id, ok: true, a: r.a, score: r.score, depth: r.depth, nodes: r.nodes, ms });
    }
  } catch (err) {
    postMessage({ id: m.id, ok: false, error: String(err && err.message || err) });
  }
};
