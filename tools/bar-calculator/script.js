const EPSILON = 0.000001;
// The laser can't reach the last 10in of a steel bar, regardless of the cut list.
const STEEL_RESERVE_IN = 10;
// Standard unistrut saw kerf.
const UNISTRUT_KERF_IN = 1 / 16;
// Trim cuts (splitting a raw bar down to fit the machine) land on whole-foot
// marks - practical to measure and mark on the shop floor, unlike the exact
// fractional-inch points that would come out of pure math. The actual part
// cuts within each segment still use the user's exact requested lengths.
const TRIM_ROUNDING_IN = 12;

// Shop-floor progress tracking: pattern index -> bars marked used so far.
// Reset on every fresh calculation; never persisted (mirrors the rest of
// the page's "always start fresh" behavior).
let progress = {};
// Cached args from the last renderResults() call, so adjustProgress() can
// re-render without recomputing the bin-packing.
let lastRender = null;

function groupPatterns(sticks) {
  const patterns = {};
  sticks.forEach((stick) => {
    const key =
      stick.parts.map((p) => `${p.item}:${p.length}`).join("|") +
      `|REM:${stick.remaining.toFixed(3)}` +
      `|STOCK:${stick.stock.nominalLength.toFixed(3)}`;

    if (!patterns[key]) {
      patterns[key] = { count: 0, stick };
    }
    patterns[key].count++;
  });
  return patterns;
}

// Builds one raw bar's segments given a chosen first-segment length: the
// first segment is `firstLength`, everything after is filled max-first
// (full-capacity segments, then whatever's left). Varying firstLength is
// how different trim strategies get generated and compared - see
// findBestSegmentation().
function buildSegmentsFrom(usableAfterTrim, maxLoad, firstLength) {
  const segments = [];
  let remaining = usableAfterTrim;
  let isFirst = true;

  while (remaining > EPSILON) {
    const segLen = isFirst ? Math.min(firstLength, remaining) : Math.min(maxLoad, remaining);
    segments.push({ nominalLength: segLen, label: `Segment ${segments.length + 1}` });
    remaining -= segLen;
    isFirst = false;
  }

  return segments;
}

function findBestFit(sticks, required) {
  let bestStick = null;
  for (const stick of sticks) {
    if (
      required <= stick.remaining + EPSILON &&
      (bestStick === null || stick.remaining < bestStick.remaining)
    ) {
      bestStick = stick;
    }
  }
  return bestStick;
}

// Best-fit decreasing: place each part (largest first) onto the stock
// piece that leaves the least leftover space, opening a new raw bar's
// worth of segments only when none of the existing ones fit. Assumes
// `parts` is already sorted largest-first.
function packParts(parts, kerf, usableSegments) {
  const sticks = [];
  let rawBarsUsed = 0;

  for (const part of parts) {
    const required = part.length + kerf;
    let bestStick = findBestFit(sticks, required);

    if (!bestStick) {
      const batch = usableSegments.map((s) => ({
        parts: [],
        remaining: s.effectiveLength,
        stock: s,
      }));
      sticks.push(...batch);
      rawBarsUsed++;
      bestStick = findBestFit(batch, required);
    }

    bestStick.parts.push(part);
    bestStick.remaining -= required;
  }

  return { sticks, rawBarsUsed };
}

// A raw bar always gets trimmed into the same number of segments (n),
// determined purely by how many maxLoad-sized pieces it takes to cover
// rawLength - but *where* the cuts land within that budget can matter a
// lot for how well the segments end up fitting the actual parts list
// (e.g. an even split can beat a "biggest piece first" split, or vice
// versa, depending on part lengths). Rather than committing to one fixed
// strategy, this tries a handful of candidate first-segment lengths -
// max-first, an even split, and lengths that let some segment hold an
// exact whole number of a given part length - and keeps whichever
// actually needs the fewest raw bars for this parts list (ties broken by
// least total remainder).
function findBestSegmentation(rawLength, maxLoad, kerf, reserve, parts) {
  const n = Math.ceil(rawLength / maxLoad);
  const usableAfterTrim = rawLength - (n - 1) * kerf;
  const upperBound = Math.min(maxLoad, usableAfterTrim);
  const lowerBound = Math.max(EPSILON, usableAfterTrim - maxLoad * (n - 1));

  // Trim cuts should land on whole feet (TRIM_ROUNDING_IN) so they're
  // practical to mark and cut - narrow the valid range to whole-foot marks,
  // falling back to the exact fractional bounds only on the rare input
  // where no whole-foot cut is actually achievable.
  const roundedLowerBound = Math.ceil(lowerBound / TRIM_ROUNDING_IN) * TRIM_ROUNDING_IN;
  const roundedUpperBound = Math.floor(upperBound / TRIM_ROUNDING_IN) * TRIM_ROUNDING_IN;
  const canRoundToFoot = roundedLowerBound <= roundedUpperBound + EPSILON;
  const clampLower = canRoundToFoot ? roundedLowerBound : lowerBound;
  const clampUpper = canRoundToFoot ? roundedUpperBound : upperBound;

  const candidateFirstLengths = new Set([upperBound, lowerBound, usableAfterTrim / n]);

  const distinctLengths = [...new Set(parts.map((p) => p.length))];
  distinctLengths.forEach((length) => {
    const unit = length + kerf;
    const maxK = Math.floor((upperBound + EPSILON) / unit);
    for (let k = 1; k <= maxK; k++) {
      candidateFirstLengths.add(k * unit);
      candidateFirstLengths.add(usableAfterTrim - k * unit);
    }
  });

  let best = null;
  const tried = new Set();

  candidateFirstLengths.forEach((raw) => {
    const rounded = canRoundToFoot ? Math.round(raw / TRIM_ROUNDING_IN) * TRIM_ROUNDING_IN : raw;
    const firstLength = Math.min(clampUpper, Math.max(clampLower, rounded));
    const key = firstLength.toFixed(6);
    if (tried.has(key)) return;
    tried.add(key);

    const segments = buildSegmentsFrom(usableAfterTrim, maxLoad, firstLength);
    if (segments.length !== n) return; // kerf loss made this split impossible; skip it

    segments.forEach((s) => {
      s.effectiveLength = Math.max(0, s.nominalLength - reserve);
      s.usable = s.effectiveLength > EPSILON;
    });
    const usableSegments = segments.filter((s) => s.usable);
    if (usableSegments.length === 0) return;

    const { sticks, rawBarsUsed } = packParts(parts, kerf, usableSegments);
    const totalRemaining = sticks.reduce((sum, s) => sum + s.remaining, 0);

    if (
      !best ||
      rawBarsUsed < best.rawBarsUsed ||
      (rawBarsUsed === best.rawBarsUsed && totalRemaining < best.totalRemaining)
    ) {
      best = { segments, sticks, rawBarsUsed, totalRemaining };
    }
  });

  return best;
}

function adjustProgress(index, delta) {
  if (!lastRender) return;

  const patterns = groupPatterns(lastRender.sticks);
  const pattern = Object.values(patterns)[index];
  if (!pattern) return;

  progress[index] = Math.min(pattern.count, Math.max(0, (progress[index] || 0) + delta));

  renderResults(lastRender.rawLength, lastRender.kerf, lastRender.cutMode, lastRender.sticks, lastRender.skippedRows, lastRender.alreadyHaveByItem, lastRender.segments, lastRender.rawBarsUsed);
}

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
}

function addPart(item = "", length = "", qty = "1", have = "0") {
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
    <td data-label="Already Have">
      <input type="number" step="1" min="0" class="partHave" value="${escapeHtml(have)}" placeholder="0">
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
  progress = {};
  lastRender = null;
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
  setFieldError("maxLoad", false);
}

function readParts() {
  const items = document.querySelectorAll(".itemNumber");
  const lengths = document.querySelectorAll(".partLength");
  const qtys = document.querySelectorAll(".partQty");
  const haves = document.querySelectorAll(".partHave");

  const parts = [];
  const skippedRows = [];
  const alreadyHaveByItem = {};

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

    const have = Math.max(0, parseInt(haves[i].value, 10) || 0);
    const item = itemRaw || length.toString();

    alreadyHaveByItem[item] = (alreadyHaveByItem[item] || 0) + have;

    const remaining = Math.max(0, qty - have);
    for (let q = 0; q < remaining; q++) {
      parts.push({ item, length });
    }
  }

  return { parts, skippedRows, alreadyHaveByItem };
}

function calculate() {
  clearFieldErrors();

  const rawLengthInput = document.getElementById("rawLength");
  const kerfInput = document.getElementById("kerf");
  const maxLoadInput = document.getElementById("maxLoad");

  const rawLength = parseFloat(rawLengthInput.value);
  const kerf = parseFloat(kerfInput.value) || 0;
  const cutMode = getCutMode();
  const reserve = cutMode === "steel" ? STEEL_RESERVE_IN : 0;

  const maxLoadRaw = maxLoadInput.value.trim();
  const maxLoad = maxLoadRaw === "" ? null : parseFloat(maxLoadRaw);

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

  if (maxLoad !== null && (isNaN(maxLoad) || maxLoad <= 0)) {
    setFieldError("maxLoad", true);
    showError("Machine Max Load Length must be greater than zero, or left blank for no limit.");
    return;
  }

  const trimming = maxLoad !== null && maxLoad < rawLength;
  const n = trimming ? Math.ceil(rawLength / maxLoad) : 1;
  const usableAfterTrim = trimming ? rawLength - (n - 1) * kerf : rawLength;

  if (usableAfterTrim <= EPSILON) {
    setFieldError("maxLoad", true);
    showError("Trimming to that max load length loses too much material to kerf. Increase the max load length or reduce kerf.");
    return;
  }

  // The largest segment any trim strategy could possibly produce is capped
  // at maxLoad (or the whole bar, if not trimming) - used below to reject
  // parts that couldn't fit no matter how the bar gets split.
  const bestCaseSegment = trimming ? Math.min(maxLoad, usableAfterTrim) : usableAfterTrim;
  const maxUsableLength = bestCaseSegment - reserve;

  if (maxUsableLength <= EPSILON) {
    showError(
      trimming
        ? "This raw bar produces no usable material after trimming and the reserved end."
        : `Raw material length must be greater than the ${STEEL_RESERVE_IN} in reserved for laser cuts.`
    );
    return;
  }

  const { parts, skippedRows, alreadyHaveByItem } = readParts();

  if (parts.length === 0 && Object.keys(alreadyHaveByItem).length === 0) {
    showError("Enter at least one part with a length and quantity.");
    return;
  }

  // Kerf is charged once per part removed from a stick (one saw cut per
  // part), not once per gap between parts. This is a deliberately
  // conservative convention: the rare case where a stick's last part lands
  // exactly on the end (no scrap, no final cut needed) gets over-charged by
  // one kerf width, but material requirements are never under-counted.
  const oversizedLengths = new Set(
    parts.filter((p) => p.length + kerf > maxUsableLength + EPSILON).map((p) => p.length)
  );

  if (oversizedLengths.size > 0) {
    showError(
      `These part lengths (plus kerf) don't fit within the raw material length: ${[...oversizedLengths].join(", ")}.`
    );
    return;
  }

  parts.sort((a, b) => b.length - a.length);

  let result;

  if (!trimming) {
    const segments = [{
      nominalLength: rawLength,
      label: null,
      effectiveLength: Math.max(0, rawLength - reserve),
      usable: true,
    }];
    result = { segments, ...packParts(parts, kerf, segments) };
  } else {
    result = findBestSegmentation(rawLength, maxLoad, kerf, reserve, parts);

    if (!result) {
      showError("Could not find a valid way to trim this raw bar. Try adjusting kerf, raw length, or max load length.");
      return;
    }
  }

  progress = {};
  renderResults(rawLength, kerf, cutMode, result.sticks, skippedRows, alreadyHaveByItem, result.segments, result.rawBarsUsed);
}

function renderResults(rawLength, kerf, cutMode, sticks, skippedRows, alreadyHaveByItem, segments, rawBarsUsed) {
  const isSteel = cutMode === "steel";
  let totalRemaining = 0;
  let totalParts = 0;

  sticks.forEach((stick) => {
    totalRemaining += stick.remaining;
    totalParts += stick.parts.length;
  });

  const patterns = groupPatterns(sticks);

  let totalBarsUsed = 0;
  const itemTotals = {};

  Object.entries(alreadyHaveByItem).forEach(([item, have]) => {
    itemTotals[item] = { needed: have, completed: have };
  });

  Object.values(patterns).forEach((pattern, index) => {
    const barsUsed = progress[index] || 0;
    totalBarsUsed += barsUsed;

    const countsPerBar = {};
    pattern.stick.parts.forEach((p) => {
      countsPerBar[p.item] = (countsPerBar[p.item] || 0) + 1;
    });

    Object.entries(countsPerBar).forEach(([item, n]) => {
      if (!itemTotals[item]) itemTotals[item] = { needed: 0, completed: 0 };
      itemTotals[item].needed += n * pattern.count;
      itemTotals[item].completed += n * barsUsed;
    });
  });

  let html = "";

  if (skippedRows.length > 0) {
    html += `<div class="error-banner">Skipped row${skippedRows.length > 1 ? "s" : ""} ${skippedRows.join(", ")}: length and quantity must both be positive numbers.</div>`;
  }

  const modeLabel = isSteel ? "Steel/Laser" : "Unistrut";
  const isTrimmed = segments.length > 1;

  if (isTrimmed) {
    const segmentText = segments.map((s) => `${s.label} — ${s.nominalLength.toFixed(3)} in${s.usable ? "" : " (unusable after reserve)"}`).join(", ");
    html += `
      <div class="trim-breakdown">
        Each ${rawLength} in raw bar trims into: ${segmentText}
      </div>
    `;
  }

  html += `
    <div class="print-summary">
      Raw length: ${rawLength} in &nbsp;|&nbsp; Kerf: ${kerf} in &nbsp;|&nbsp; Mode: ${modeLabel} &nbsp;|&nbsp; Sticks needed: ${sticks.length} &nbsp;|&nbsp; Bars used: ${totalBarsUsed} / ${sticks.length}${isTrimmed ? ` &nbsp;|&nbsp; Raw bars needed: ${rawBarsUsed}` : ""}
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
      <div class="summary-card">
        <span>Bars used</span>
        <strong>${totalBarsUsed} / ${sticks.length}</strong>
      </div>
      ${isTrimmed ? `
      <div class="summary-card">
        <span>Raw bars needed</span>
        <strong>${rawBarsUsed}</strong>
      </div>
      ` : ""}
    </div>
  `;

  html += `
    <div class="parts-progress">
      <h3>Parts Progress</h3>
      <table class="progress-table">
        <tr>
          <th>Item Number</th>
          <th>Completed</th>
        </tr>
        ${Object.entries(itemTotals).map(([item, t]) => `
        <tr>
          <td data-label="Item Number">${escapeHtml(item)}</td>
          <td data-label="Completed">${t.completed} / ${t.needed}</td>
        </tr>
        `).join("")}
      </table>
    </div>
  `;

  let patternNumber = 0;

  Object.values(patterns).forEach((pattern, index) => {
    const stick = pattern.stick;
    const stockLength = stick.stock.nominalLength;
    const used = stockLength - stick.remaining;
    const barsUsed = progress[index] || 0;
    const isComplete = barsUsed >= pattern.count;
    // A pattern with no parts on it is the "other half" of a raw bar that
    // had to be bought to reach a smaller segment for some other part -
    // it's leftover stock, not an actual cut instruction, so it gets
    // labeled distinctly and skips the cut-tracking controls entirely.
    const isUnused = stick.parts.length === 0;

    if (!isUnused) patternNumber++;

    html += `
      <div class="pattern${isComplete ? " pattern-complete" : ""}${isUnused ? " pattern-unused" : ""}">
        <div class="pattern-header">
          <span>${isUnused ? "Unused Segment" : `Pattern ${patternNumber}`}</span>
          ${stick.stock.label ? `<span class="badge badge-secondary">${stick.stock.label}</span>` : ""}
          <span class="badge">&times; ${pattern.count}</span>
          <span>Remainder: ${stick.remaining.toFixed(3)} in</span>
        </div>

        <div class="bar">
    `;

    stick.parts.forEach((part) => {
      const width = (part.length / stockLength) * 100;
      html += `
        <div class="cut" style="width:${width}%">
          ${escapeHtml(part.item)}
        </div>
      `;
    });

    const remainderWidth = (stick.remaining / stockLength) * 100;

    html += `
          <div class="remainder" style="width:${remainderWidth}%">
            ${stick.remaining.toFixed(1)}
          </div>
        </div>

        <div class="pattern-details">
    `;

    html += isUnused
      ? `Not needed for any part in this list &mdash; comes along with a raw bar bought for its other segment. Leftover stock for next time.`
      : `
          Cuts: ${stick.parts.map((p) => escapeHtml(p.item)).join(", ")}<br>
          Lengths: ${stick.parts.map((p) => `${p.length} in`).join(", ")}<br>
          Parts per stick: ${stick.parts.length}<br>
          Material used per stick: ${used.toFixed(3)} in
      `;

    html += `</div>`;

    if (!isUnused) {
      html += `
        <div class="pattern-progress">
          <button class="btn-secondary" onclick="adjustProgress(${index}, -1)" ${barsUsed <= 0 ? "disabled" : ""}>&minus;1</button>
          <span class="progress-count">${barsUsed} / ${pattern.count} bars used</span>
          <button class="btn-primary" onclick="adjustProgress(${index}, 1)" ${isComplete ? "disabled" : ""}>+1 Bar Used</button>
        </div>
      `;
    }

    html += `</div>`;
  });

  document.getElementById("results").innerHTML = html;
  lastRender = { rawLength, kerf, cutMode, sticks, skippedRows, alreadyHaveByItem, segments, rawBarsUsed };
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
  const haves = document.querySelectorAll(".partHave");

  const rows = [];
  for (let i = 0; i < lengths.length; i++) {
    rows.push({
      item: items[i].value,
      length: lengths[i].value,
      qty: qtys[i].value,
      have: haves[i].value,
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
    rows.forEach((row) => addPart(row.item, row.length, row.qty, row.have));
  } else {
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

  const lines = ["Item Number,Length,Quantity,Already Have"];
  rows.forEach((r) => {
    lines.push([r.item, r.length, r.qty, r.have].map(csvEscapeField).join(","));
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
      const [item = "", length = "", qty = "1", have = "0"] = parseCsvLine(lines[i]);
      rows.push({ item, length, qty, have });
    }

    if (rows.length === 0) {
      showError("No data rows found in the CSV file.");
      return;
    }

    setRowsData(rows);
    document.getElementById("results").innerHTML = "";
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

// One-time cleanup of the old auto-save blob from before persistence was removed.
localStorage.removeItem("barCalculator.state");

addPart();
