/* Sends records to Supabase. Every row first goes into an outbox kept in localStorage, so nothing is lost
 * when the network drops or the page is closed; the outbox is flushed in order and retried later.
 * The outbox is re-read from storage on every change, so several tabs of the same browser can share it
 * (a row sent twice is ignored by the server thanks to the unique keys). */
(function (root) {
  "use strict";
  const OUTBOX = "barricade-rec-outbox";
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  class Store {
    constructor(cfg) {
      this.url = cfg.supabaseUrl.replace(/\/$/, "") + "/rest/v1/";
      this.key = cfg.supabaseKey;
      this.mem = [];            // fallback when localStorage is unavailable
      this.flushing = false;
      this.lastError = null;
      this.onchange = () => {};
      setInterval(() => this.flush(), 15000);
      if (root.addEventListener) {
        root.addEventListener("online", () => this.flush());
        root.addEventListener("storage", (e) => { if (e.key === OUTBOX) this.onchange(); });
      }
    }
    headers(extra) {
      return Object.assign({ apikey: this.key, "Content-Type": "application/json" }, extra || {});
    }
    read() {
      try {
        const raw = localStorage.getItem(OUTBOX);
        const b = raw ? JSON.parse(raw) : [];
        return Array.isArray(b) ? b : [];
      } catch (e) { return this.mem.slice(); }
    }
    write(box) {
      this.mem = box;
      try { localStorage.setItem(OUTBOX, JSON.stringify(box)); } catch (e) { /* storage full or blocked */ }
    }
    remove(id) { this.write(this.read().filter((x) => x.uid !== id)); }
    pending() { return this.read().length; }
    enqueue(table, row) {
      const box = this.read();
      box.push({ uid: uid(), table, row });
      this.write(box);
      this.onchange();
      this.flush();
    }
    async flush() {
      if (this.flushing) return;
      this.flushing = true;
      try {
        for (;;) {
          const box = this.read();
          if (!box.length) break;
          const item = box[0];
          const { table, row } = item;
          const conflict = table === "moves" ? "?on_conflict=game_id,ply" : "?on_conflict=id";
          let res;
          try {
            res = await fetch(this.url + table + conflict, {
              method: "POST",
              headers: this.headers({ Prefer: "return=minimal,resolution=ignore-duplicates" }),
              body: JSON.stringify(row),
            });
          } catch (e) {
            this.lastError = "네트워크 연결 없음 (다시 연결되면 자동 전송)";
            break;
          }
          if (res.ok) {   // duplicates are ignored by the server (resolution=ignore-duplicates) and still return 201
            this.remove(item.uid);
            this.lastError = null;
            this.onchange();
            continue;
          }
          let detail = "";
          try { detail = (await res.json()).message || ""; } catch (e) { /* no body */ }
          this.lastError = "저장 실패 (" + res.status + ") " + detail;
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
            // the row itself is rejected: keep it aside so the rest of the queue can go on
            try {
              const dead = JSON.parse(localStorage.getItem(OUTBOX + "-rejected") || "[]");
              dead.push({ table, row, status: res.status, detail });
              localStorage.setItem(OUTBOX + "-rejected", JSON.stringify(dead.slice(-200)));
            } catch (e) { /* ignore */ }
            this.remove(item.uid);
            continue;
          }
          break;
        }
      } finally {
        this.flushing = false;
        this.onchange();
      }
    }
    /** All rows of a table (paged), ordered by the given column. */
    async fetchAll(table, order) {
      const out = [];
      const page = 1000;
      for (let off = 0; ; off += page) {
        const res = await fetch(this.url + table + "?select=*&order=" + order + "&limit=" + page + "&offset=" + off,
                                { headers: this.headers() });
        if (!res.ok) {
          let detail = "";
          try { detail = (await res.json()).message || ""; } catch (e) { /* no body */ }
          throw new Error("기록을 불러오지 못했습니다 (" + res.status + ") " + detail);
        }
        const rows = await res.json();
        out.push(...rows);
        if (rows.length < page) break;
      }
      return out;
    }
  }
  root.BR_Store = Store;
})(typeof self !== "undefined" ? self : globalThis);
