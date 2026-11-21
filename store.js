/* Sends records to Supabase. Every row first goes into an outbox kept in localStorage, so nothing is lost
 * when the network drops or the page is closed; the outbox is flushed in order and retried later. */
(function (root) {
  "use strict";
  const OUTBOX = "barricade-rec-outbox";

  class Store {
    constructor(cfg) {
      this.url = cfg.supabaseUrl.replace(/\/$/, "") + "/rest/v1/";
      this.key = cfg.supabaseKey;
      this.box = this.load();
      this.flushing = false;
      this.lastError = null;
      this.onchange = () => {};
      setInterval(() => this.flush(), 15000);
      root.addEventListener && root.addEventListener("online", () => this.flush());
    }
    headers(extra) {
      return Object.assign({ apikey: this.key, "Content-Type": "application/json" }, extra || {});
    }
    load() {
      try { const b = JSON.parse(localStorage.getItem(OUTBOX) || "[]"); return Array.isArray(b) ? b : []; }
      catch (e) { return []; }
    }
    save() {
      try { localStorage.setItem(OUTBOX, JSON.stringify(this.box)); } catch (e) { /* storage full or blocked */ }
    }
    pending() { return this.box.length; }
    enqueue(table, row) {
      this.box.push({ table, row });
      this.save();
      this.onchange();
      this.flush();
    }
    async flush() {
      if (this.flushing || !this.box.length) return;
      this.flushing = true;
      try {
        while (this.box.length) {
          const { table, row } = this.box[0];
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
            this.box.shift();
            this.save();
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
            this.box.shift();
            this.save();
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
