const STORAGE_KEY = "barCalculator.state";
const EPSILON = 0.000001;
// The laser can't reach the last 10in of a steel bar, regardless of the cut list.
const STEEL_RESERVE_IN = 10;
// Standard unistrut saw kerf.
const UNISTRUT_KERF_IN = 1 / 16;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function getCutMode() {
  return document.getElementById("cutMode").value;
}

function onCutModeChange() {
  if (getCutMode() === "unistrut") {
    document.getElementById("kerf").value = UNISTRUT_KERF_IN;
  }
  saveState();
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
  setRowsData([]);
  document.getElementById("results").innerHTML = "";
  saveState();
}

function showError(message) {
  document.getElementById("results").innerHTML =
    `<div class="error-banner">${message}</div>`;
}

function setFieldError(id, hasError) {
  document.getElementById(id).classList.toggle("field-error", hasError);
}

function clearFieldErrors() {
  setFieldError("rawLength", false);
  setFieldError("kerf", false);
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
  clearFieldErrors();

  const rawLengthInput = document.getElementById("rawLength");
  const kerfInput = document.getElementById("kerf");

  const rawLength = parseFloat(rawLengthInput.value);
  const kerf = parseFloat(kerfInput.value) || 0;
  const cutMode = getCutMode();
  const reserve = cutMode === "steel" ? STEEL_RESERVE_IN : 0;

  if (isNaN(rawLength) || rawLength <= 0) {
    setFieldError("rawLength", true);
    showError("Enter a raw material length greater than zero.");
    return;
  }

  if (kerf < 0) {
    setFieldError("kerf", true);
    showError("Kerf width cannot be negative.");
    return;
  }

  const effectiveRawLength = rawLength - reserve;

  if (effectiveRawLength <= EPSILON) {
    setFieldError("rawLength", true);
    showError(`Raw material length must be greater than the ${STEEL_RESERVE_IN} in reserved for laser cuts.`);
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
    parts.filter((p) => p.length + kerf > effectiveRawLength + EPSILON).map((p) => p.length)
  );

  if (oversizedLengths.size > 0) {
    showError(
      `These part lengths (plus kerf) don't fit within the raw material length: ${[...oversizedLengths].join(", ")}.`
    );
    return;
  }

  parts.sort((a, b) => b.length - a.length);

  const sticks = [];

  // Best-fit decreasing: place each part (largest first) onto the stick
  // that leaves the least leftover space, opening a new stick only when
  // none of the existing ones fit. This packs tighter than first-fit and
  // never does worse, at the same O(parts * sticks) cost.
  for (const part of parts) {
    const required = part.length + kerf;
    let bestStick = null;

    for (const stick of sticks) {
      if (
        required <= stick.remaining + EPSILON &&
        (bestStick === null || stick.remaining < bestStick.remaining)
      ) {
        bestStick = stick;
      }
    }

    if (bestStick) {
      bestStick.parts.push(part);
      bestStick.remaining -= required;
    } else {
      sticks.push({
        parts: [part],
        remaining: effectiveRawLength - required,
      });
    }
  }

  renderResults(rawLength, kerf, cutMode, sticks, skippedRows);
  saveState();
}

function renderResults(rawLength, kerf, cutMode, sticks, skippedRows) {
  const isSteel = cutMode === "steel";
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

  const modeLabel = isSteel ? "Steel/Laser" : "Unistrut";

  html += `
    <div class="print-summary">
      Raw length: ${rawLength} in &nbsp;|&nbsp; Kerf: ${kerf} in &nbsp;|&nbsp; Mode: ${modeLabel} &nbsp;|&nbsp; Sticks needed: ${sticks.length}
    </div>
  `;

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
        <strong>${totalRemaining.toFixed(3)} in</strong>
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
          <span>Remainder: ${stick.remaining.toFixed(3)} in</span>
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
          Lengths: ${stick.parts.map((p) => `${p.length} in`).join(", ")}<br>
          Parts per stick: ${stick.parts.length}<br>
          Material used per stick: ${used.toFixed(3)} in
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

function getRowsData() {
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
  return rows;
}

function setRowsData(rows) {
  const table = document.getElementById("partsTable");
  while (table.rows.length > 1) {
    table.deleteRow(1);
  }

  if (Array.isArray(rows) && rows.length > 0) {
    rows.forEach((row) => addPart(row.item, row.length, row.qty));
  } else {
    addPart();
  }
}

function saveState() {
  const state = {
    rawLength: document.getElementById("rawLength").value,
    kerf: document.getElementById("kerf").value,
    cutMode: getCutMode(),
    rows: getRowsData(),
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
    document.getElementById("cutMode").value = state.cutMode === "steel" ? "steel" : "unistrut";
    // Unistrut always uses the standard kerf, same as switching modes via
    // the dropdown - don't restore a stale saved value from Steel mode
    // (or from before this default existed).
    document.getElementById("kerf").value =
      getCutMode() === "unistrut" ? UNISTRUT_KERF_IN : (state.kerf ?? 0);
    setRowsData(state.rows);
  } catch {
    addPart();
  }
}

function csvEscapeField(value) {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function exportCsv() {
  const rows = getRowsData().filter((r) => r.item || r.length || r.qty);
  if (rows.length === 0) {
    showError("No parts to export.");
    return;
  }

  const lines = ["Item Number,Length,Quantity"];
  rows.forEach((r) => {
    lines.push([r.item, r.length, r.qty].map(csvEscapeField).join(","));
  });

  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "bar-calculator-parts.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function importCsv(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;

  const reader = new FileReader();

  reader.onload = () => {
    const lines = String(reader.result)
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "");

    if (lines.length === 0) {
      showError("The CSV file is empty.");
      return;
    }

    // Skip a header row if it looks like one (non-numeric length column).
    let start = 0;
    const first = parseCsvLine(lines[0]);
    if (first.length >= 2 && isNaN(parseFloat(first[1]))) {
      start = 1;
    }

    const rows = [];
    for (let i = start; i < lines.length; i++) {
      const [item = "", length = "", qty = "1"] = parseCsvLine(lines[i]);
      rows.push({ item, length, qty });
    }

    if (rows.length === 0) {
      showError("No data rows found in the CSV file.");
      return;
    }

    setRowsData(rows);
    document.getElementById("results").innerHTML = "";
    saveState();
  };

  reader.onerror = () => showError("Could not read the CSV file.");
  reader.readAsText(file);
}

(function initTheme() {
  if (localStorage.getItem("theme") === "light") {
    document.body.classList.add("light-theme");
  }
  updateThemeButton();
})();

loadState();
