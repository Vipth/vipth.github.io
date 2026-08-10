const STORAGE_KEY = "barCalculator.state";
const EPSILON = 0.000001;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function addPart(item = "", length = "", qty = "1") {
  const table = document.getElementById("partsTable");
  const row = table.insertRow();

  row.innerHTML = `
    <td data-label="Item Number">
      <input type="text" class="itemNumber" value="${escapeHtml(item)}" placeholder="Item #">
    </td>
    <td data-label="Part Length">
      <input type="number" step="0.001" class="partLength" value="${escapeHtml(length)}" placeholder="Length">
    </td>
    <td data-label="Quantity">
      <input type="number" step="1" min="1" class="partQty" value="${escapeHtml(qty)}" placeholder="Qty">
    </td>
    <td>
      <button class="btn-danger" onclick="this.closest('tr').remove()">Remove</button>
    </td>
  `;

  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      calculate();
    }
  });
}

function clearAllParts() {
  const table = document.getElementById("partsTable");
  // Remove every row except the header row.
  while (table.rows.length > 1) {
    table.deleteRow(1);
  }
  document.getElementById("results").innerHTML = "";
  addPart();
  saveState();
}

function showError(message) {
  document.getElementById("results").innerHTML =
    `<div class="error-banner">${message}</div>`;
}

function readParts() {
  const items = document.querySelectorAll(".itemNumber");
  const lengths = document.querySelectorAll(".partLength");
  const qtys = document.querySelectorAll(".partQty");

  const parts = [];
  const skippedRows = [];

  for (let i = 0; i < lengths.length; i++) {
    const itemRaw = items[i].value.trim();
    const lengthRaw = lengths[i].value.trim();
    const qtyRaw = qtys[i].value.trim();

    // A fully blank row is just an unused row, not an error.
    if (!itemRaw && !lengthRaw && !qtyRaw) continue;

    const length = parseFloat(lengthRaw);
    const qty = parseInt(qtyRaw, 10);

    if (isNaN(length) || length <= 0 || isNaN(qty) || qty <= 0) {
      skippedRows.push(i + 1);
      continue;
    }

    const item = itemRaw || length.toString();
    for (let q = 0; q < qty; q++) {
      parts.push({ item, length });
    }
  }

  return { parts, skippedRows };
}

function calculate() {
  const rawLength = parseFloat(document.getElementById("rawLength").value);
  const kerf = parseFloat(document.getElementById("kerf").value) || 0;

  if (!rawLength || rawLength <= 0) {
    showError("Enter a raw material length greater than zero.");
    return;
  }

  if (kerf < 0) {
    showError("Kerf width cannot be negative.");
    return;
  }

  const { parts, skippedRows } = readParts();

  if (parts.length === 0) {
    showError("Enter at least one part with a length and quantity.");
    return;
  }

  // Kerf is charged once per part removed from a stick (one saw cut per
  // part), not once per gap between parts. This is a deliberately
  // conservative convention: the rare case where a stick's last part lands
  // exactly on the end (no scrap, no final cut needed) gets over-charged by
  // one kerf width, but material requirements are never under-counted.
  const oversizedLengths = new Set(
    parts.filter((p) => p.length + kerf > rawLength).map((p) => p.length)
  );

  if (oversizedLengths.size > 0) {
    showError(
      `These part lengths (plus kerf) don't fit within the raw material length: ${[...oversizedLengths].join(", ")}.`
    );
    return;
  }

  parts.sort((a, b) => b.length - a.length);

  const sticks = [];

  for (const part of parts) {
    const required = part.length + kerf;
    let placed = false;

    for (const stick of sticks) {
      if (required <= stick.remaining + EPSILON) {
        stick.parts.push(part);
        stick.remaining -= required;
        placed = true;
        break;
      }
    }

    if (!placed) {
      sticks.push({
        parts: [part],
        remaining: rawLength - required,
      });
    }
  }

  renderResults(rawLength, sticks, skippedRows);
  saveState();
}

function renderResults(rawLength, sticks, skippedRows) {
  let totalRemaining = 0;
  let totalParts = 0;

  sticks.forEach((stick) => {
    totalRemaining += stick.remaining;
    totalParts += stick.parts.length;
  });

  const patterns = {};

  sticks.forEach((stick) => {
    const key =
      stick.parts.map((p) => `${p.item}:${p.length}`).join("|") +
      `|REM:${stick.remaining.toFixed(3)}`;

    if (!patterns[key]) {
      patterns[key] = { count: 0, stick };
    }
    patterns[key].count++;
  });

  let html = "";

  if (skippedRows.length > 0) {
    html += `<div class="error-banner">Skipped row${skippedRows.length > 1 ? "s" : ""} ${skippedRows.join(", ")}: length and quantity must both be positive numbers.</div>`;
  }

  html += `
    <div class="summary">
      <div class="summary-card">
        <span>Total sticks needed</span>
        <strong>${sticks.length}</strong>
      </div>
      <div class="summary-card">
        <span>Unique cut patterns</span>
        <strong>${Object.keys(patterns).length}</strong>
      </div>
      <div class="summary-card">
        <span>Total parts cut</span>
        <strong>${totalParts}</strong>
      </div>
      <div class="summary-card">
        <span>Total remainder</span>
        <strong>${totalRemaining.toFixed(3)}</strong>
      </div>
    </div>
  `;

  Object.values(patterns).forEach((pattern, index) => {
    const stick = pattern.stick;
    const used = rawLength - stick.remaining;

    html += `
      <div class="pattern">
        <div class="pattern-header">
          <span>Pattern ${index + 1}</span>
          <span class="badge">&times; ${pattern.count}</span>
          <span>Remainder: ${stick.remaining.toFixed(3)}</span>
        </div>

        <div class="bar">
    `;

    stick.parts.forEach((part) => {
      const width = (part.length / rawLength) * 100;
      html += `
        <div class="cut" style="width:${width}%">
          ${escapeHtml(part.item)}
        </div>
      `;
    });

    const remainderWidth = (stick.remaining / rawLength) * 100;

    html += `
          <div class="remainder" style="width:${remainderWidth}%">
            ${stick.remaining.toFixed(1)}
          </div>
        </div>

        <div class="pattern-details">
          Cuts: ${stick.parts.map((p) => escapeHtml(p.item)).join(", ")}<br>
          Lengths: ${stick.parts.map((p) => p.length).join(", ")}<br>
          Parts per stick: ${stick.parts.length}<br>
          Material used per stick: ${used.toFixed(3)}
        </div>
      </div>
    `;
  });

  document.getElementById("results").innerHTML = html;
}

function toggleTheme() {
  document.body.classList.toggle("light-theme");
  const isLight = document.body.classList.contains("light-theme");
  localStorage.setItem("theme", isLight ? "light" : "dark");
  updateThemeButton();
}

function updateThemeButton() {
  const btn = document.getElementById("themeBtn");
  btn.innerHTML = document.body.classList.contains("light-theme")
    ? "🌙 Dark Mode"
    : "☀️ Light Mode";
}

function saveState() {
  const items = document.querySelectorAll(".itemNumber");
  const lengths = document.querySelectorAll(".partLength");
  const qtys = document.querySelectorAll(".partQty");

  const rows = [];
  for (let i = 0; i < lengths.length; i++) {
    rows.push({
      item: items[i].value,
      length: lengths[i].value,
      qty: qtys[i].value,
    });
  }

  const state = {
    rawLength: document.getElementById("rawLength").value,
    kerf: document.getElementById("kerf").value,
    rows,
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    addPart();
    return;
  }

  try {
    const state = JSON.parse(saved);
    document.getElementById("rawLength").value = state.rawLength ?? 288;
    document.getElementById("kerf").value = state.kerf ?? 0;

    if (Array.isArray(state.rows) && state.rows.length > 0) {
      state.rows.forEach((row) => addPart(row.item, row.length, row.qty));
    } else {
      addPart();
    }
  } catch {
    addPart();
  }
}

(function initTheme() {
  if (localStorage.getItem("theme") === "light") {
    document.body.classList.add("light-theme");
  }
  updateThemeButton();
})();

loadState();
