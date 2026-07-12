/* Taskbot dashboard — vanilla JS, sin dependencias */
(() => {
  const $ = (sel) => document.querySelector(sel);
  let token = localStorage.getItem("taskbot_token") || "";
  let items = [];
  let tab = "tareas";
  let expandedId = null;
  let query = "";
  let collapsedCats = new Set();

  const TODAY = new Date().toISOString().slice(0, 10);

  // ---------- API ----------
  async function api(path, opts = {}) {
    const r = await fetch(`/api/${path}`, {
      ...opts,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(opts.headers || {}) },
    });
    if (r.status === 401) { logout(); throw new Error("unauthorized"); }
    return r.json();
  }

  async function load() {
    const data = await api("items");
    items = data.items || [];
    render();
  }

  // ---------- login ----------
  function logout() {
    localStorage.removeItem("taskbot_token");
    token = "";
    $("#app").classList.add("hidden");
    $("#login").classList.remove("hidden");
  }

  async function tryLogin(t) {
    token = t;
    try {
      await api("items");
      localStorage.setItem("taskbot_token", t);
      $("#login").classList.add("hidden");
      $("#app").classList.remove("hidden");
      render();
      return true;
    } catch {
      return false;
    }
  }

  // ---------- render ----------
  function visibleItems() {
    if (query) {
      const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
      const q = norm(query);
      return items.filter((i) => norm(i.text).includes(q) || norm(i.category).includes(q));
    }
    if (tab === "hechas") return items.filter((i) => i.status === "hecha");
    const pend = items.filter((i) => i.status === "pendiente");
    if (tab === "tareas") return pend.filter((i) => i.kind === "tarea");
    if (tab === "notas") return pend.filter((i) => i.kind === "nota");
    if (tab === "categorias") return pend;
    return pend.filter((i) => i.kind === "material");
  }

  function render() {
    const list = $("#list");
    const vis = visibleItems();
    list.innerHTML = "";

    if (!vis.length) {
      list.innerHTML = `<p class="empty">${tab === "tareas" ? "Nada pendiente 🎉" : "Vacío por aquí"}</p>`;
      return;
    }

    if (tab === "tareas" && !query) {
      const groups = [
        ["🔥 Urgente", vis.filter((i) => i.priority === "urgente")],
        ["📋 Pendientes", vis.filter((i) => i.priority === "normal")],
        ["🌙 Algún día", vis.filter((i) => i.priority === "algun_dia")],
      ];
      for (const [title, arr] of groups) {
        if (!arr.length) continue;
        const h = document.createElement("div");
        h.className = "group-title";
        h.textContent = title;
        list.appendChild(h);
        arr.forEach((i) => list.appendChild(renderItem(i)));
      }
    } else if (tab === "categorias" && !query) {
      const grouped = new Map();
      for (const item of vis) {
        const key = (item.category || "").trim() || "__none__";
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(item);
      }
      const sortedKeys = [...grouped.keys()].sort((a, b) => {
        if (a === "__none__") return 1;
        if (b === "__none__") return -1;
        return a.localeCompare(b);
      });
      for (const key of sortedKeys) {
        const arr = grouped.get(key);
        const label = key === "__none__" ? "Sin categoría" : key;
        const collapsed = collapsedCats.has(key);
        const h = document.createElement("div");
        h.className = "group-title group-title--clickable";
        h.innerHTML = `<span class="group-chevron">${collapsed ? "▸" : "▾"}</span> 🏷 ${esc(label)} <span class="group-count">(${arr.length})</span>`;
        h.addEventListener("click", () => {
          if (collapsedCats.has(key)) collapsedCats.delete(key);
          else collapsedCats.add(key);
          render();
        });
        list.appendChild(h);
        if (!collapsed) arr.forEach((i) => list.appendChild(renderItem(i)));
      }
    } else {
      vis.forEach((i) => list.appendChild(renderItem(i)));
    }
  }

  function renderItem(item) {
    const el = document.createElement("div");
    el.className = `item p-${item.priority}${item.status === "hecha" ? " done" : ""}`;

    const meta = [];
    if (item.due_date && item.status === "pendiente") {
      const cls = item.due_date < TODAY ? "overdue" : item.due_date === TODAY ? "today" : "";
      const label = item.due_date < TODAY ? `⚠️ ${item.due_date}` : item.due_date === TODAY ? "📅 hoy" : `📅 ${item.due_date}`;
      meta.push(`<span class="chip ${cls}">${label}</span>`);
    }
    if (item.category) meta.push(`<span class="chip">🏷 ${esc(item.category)}</span>`);
    const showAllKinds = query || tab === "categorias";
    if (showAllKinds) {
      const kindIcon = { tarea: "📌", nota: "📝", material: "📎" };
      if (kindIcon[item.kind]) meta.push(`<span class="chip">${kindIcon[item.kind]}</span>`);
    } else if (tab !== "tareas" && item.kind === "tarea") {
      meta.push(`<span class="chip">📌</span>`);
    }

    const thumbs = (item.attachments || []).map((a) => {
      const src = `/files/${encodeURIComponent(a.r2_key)}?t=${encodeURIComponent(token)}`;
      if ((a.mime || "").startsWith("image/")) return `<a href="${src}" target="_blank"><img src="${src}" loading="lazy" alt=""></a>`;
      if ((a.mime || "").startsWith("audio/")) return `<audio controls preload="none" src="${src}"></audio>`;
      return `<a class="file-chip" href="${src}" target="_blank">📄 archivo</a>`;
    }).join("");

    el.innerHTML = `
      <div class="item-row">
        <button class="check" data-act="toggle">${item.status === "hecha" ? "✓" : ""}</button>
        <div class="item-body">
          <div class="item-text">${esc(item.text || "(sin texto)")}</div>
          ${meta.length ? `<div class="item-meta">${meta.join("")}</div>` : ""}
          ${thumbs ? `<div class="thumbs">${thumbs}</div>` : ""}
        </div>
      </div>
      ${expandedId === item.id ? renderActions(item) : ""}
    `;

    el.querySelector('[data-act="toggle"]').addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDone(item);
    });

    el.addEventListener("click", (e) => {
      if (e.target.closest("a, audio, button, input, select")) return;
      expandedId = expandedId === item.id ? null : item.id;
      render();
    });

    if (expandedId === item.id) bindActions(el, item);
    return el;
  }

  function renderActions(item) {
    const prio = { urgente: "🔥", normal: "📋", algun_dia: "🌙" };
    return `
      <div class="actions">
        <select data-act="priority">
          ${Object.entries(prio).map(([k, v]) =>
            `<option value="${k}" ${item.priority === k ? "selected" : ""}>${v} ${k.replace("_", " ")}</option>`).join("")}
        </select>
        <select data-act="kind">
          <option value="tarea" ${item.kind === "tarea" ? "selected" : ""}>📌 tarea</option>
          <option value="nota" ${item.kind === "nota" ? "selected" : ""}>📝 nota</option>
          <option value="material" ${item.kind === "material" ? "selected" : ""}>📎 material</option>
        </select>
        <input type="date" data-act="due" value="${item.due_date || ""}" />
        <input type="text" data-act="category" placeholder="categoría" value="${esc(item.category || "")}" size="10" />
        <button class="danger" data-act="delete">🗑 Borrar</button>
      </div>`;
  }

  function bindActions(el, item) {
    el.querySelector('[data-act="priority"]').addEventListener("change", (e) => patch(item.id, { priority: e.target.value }));
    el.querySelector('[data-act="kind"]').addEventListener("change", (e) => patch(item.id, { kind: e.target.value }));
    el.querySelector('[data-act="due"]').addEventListener("change", (e) => patch(item.id, { due_date: e.target.value }));
    el.querySelector('[data-act="category"]').addEventListener("change", (e) => patch(item.id, { category: e.target.value.trim() }));
    el.querySelector('[data-act="delete"]').addEventListener("click", async () => {
      if (!confirm("¿Borrar definitivamente?")) return;
      await api(`items/${item.id}`, { method: "DELETE" });
      items = items.filter((i) => i.id !== item.id);
      expandedId = null;
      render();
    });
  }

  async function patch(id, fields) {
    const data = await api(`items/${id}`, { method: "PATCH", body: JSON.stringify(fields) });
    const idx = items.findIndex((i) => i.id === id);
    if (idx >= 0) data.item.attachments = items[idx].attachments, items[idx] = data.item;
    render();
  }

  function toggleDone(item) {
    patch(item.id, { status: item.status === "hecha" ? "pendiente" : "hecha" });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- eventos ----------
  $("#quick-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#add-input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    input.blur();
    const data = await api("items", { method: "POST", body: JSON.stringify({ text }) });
    items.unshift(data.item);
    render();
  });

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      tab = btn.dataset.tab;
      expandedId = null;
      render();
    });
  });

  $("#search-input").addEventListener("input", (e) => {
    query = e.target.value.trim();
    render();
  });

  $("#login-btn").addEventListener("click", async () => {
    const ok = await tryLogin($("#token-input").value.trim());
    $("#login-error").classList.toggle("hidden", ok);
  });
  $("#token-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#login-btn").click();
  });

  // refrescar al volver a la app
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && token) load().catch(() => {});
  });

  // ---------- init ----------
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  if (token) {
    $("#app").classList.remove("hidden");
    load().catch(() => logout());
  } else {
    $("#login").classList.remove("hidden");
  }
})();
