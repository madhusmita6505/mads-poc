/**
 * Wingman Pre-Call Preparation Page
 * Allows FAs to search for clients, review their portfolio/goals/history,
 * and enter discussion points before starting a call.
 */

const searchInput = document.getElementById("client-search");
const searchResults = document.getElementById("search-results");
const clientDetail = document.getElementById("client-detail");
const startCallBtn = document.getElementById("start-call-btn");

let selectedClient = null;
let searchTimeout = null;

// ---------------------------------------------------------------------------
// Client Search
// ---------------------------------------------------------------------------

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  const q = searchInput.value.trim();
  if (q.length < 1) {
    searchResults.innerHTML = "";
    searchResults.classList.remove("visible");
    return;
  }
  searchTimeout = setTimeout(() => searchClients(q), 200);
});

searchInput.addEventListener("focus", () => {
  if (searchInput.value.trim().length >= 1) {
    searchClients(searchInput.value.trim());
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-section")) {
    searchResults.classList.remove("visible");
  }
});

async function searchClients(query) {
  try {
    const res = await fetch(`/api/clients?q=${encodeURIComponent(query)}`);
    const clients = await res.json();
    renderSearchResults(clients);
  } catch (err) {
    console.error("Search failed:", err);
  }
}

function renderSearchResults(clients) {
  if (clients.length === 0) {
    searchResults.innerHTML = `<div class="search-empty">No clients found</div>`;
    searchResults.classList.add("visible");
    return;
  }

  searchResults.innerHTML = clients.map(c => `
    <div class="search-result-item" data-id="${c.id}">
      <div class="result-avatar">${getInitials(c.name)}</div>
      <div class="result-info">
        <div class="result-name">${escapeHtml(c.name)}</div>
        <div class="result-meta">
          <span class="result-id">${escapeHtml(c.id)}</span>
          <span class="result-tier">${escapeHtml(c.client_tier)}</span>
          <span class="result-aum">$${formatNumber(c.total_aum)}</span>
        </div>
      </div>
      ${c.next_review_due ? `<div class="result-review">Next review: ${c.next_review_due}</div>` : ""}
    </div>
  `).join("");

  searchResults.classList.add("visible");

  searchResults.querySelectorAll(".search-result-item").forEach(item => {
    item.addEventListener("click", () => selectClient(item.dataset.id));
  });
}

// ---------------------------------------------------------------------------
// Client Detail Loading
// ---------------------------------------------------------------------------

async function selectClient(clientId) {
  searchResults.classList.remove("visible");

  try {
    const res = await fetch(`/api/clients/${clientId}`);
    const client = await res.json();

    if (client.error) {
      console.error("Client not found:", clientId);
      return;
    }

    selectedClient = client;
    searchInput.value = client.name;
    renderClientDetail(client);
    clientDetail.classList.remove("hidden");
    clientDetail.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    console.error("Failed to load client:", err);
  }
}

function renderClientDetail(client) {
  // Header card
  document.getElementById("client-avatar").textContent = getInitials(client.name);
  document.getElementById("client-name").textContent = client.name;
  document.getElementById("client-tier").textContent = client.client_tier;
  document.getElementById("client-aum").textContent = `AUM: $${formatNumber(client.total_aum)}`;
  document.getElementById("client-since").textContent = `Client since ${formatDate(client.relationship_start)}`;
  document.getElementById("client-next-review").textContent = `Next review: ${client.next_review_due || "N/A"}`;

  const riskLabels = {
    very_conservative: "Very Conservative",
    conservative: "Conservative",
    moderate_conservative: "Moderate Conservative",
    moderate: "Moderate",
    moderate_aggressive: "Moderate Aggressive",
    aggressive: "Aggressive",
  };
  document.getElementById("client-risk").textContent = riskLabels[client.risk_profile] || client.risk_profile;
  document.getElementById("client-risk").className = `risk-value risk-${client.risk_profile}`;

  renderPortfolioTab(client);
  renderGoalsTab(client);
  renderPersonalTab(client);
  renderHistoryTab(client);

  // Update discussion point placeholders based on client context
  updatePlaceholders(client);
}

// ---------------------------------------------------------------------------
// Tab Rendering
// ---------------------------------------------------------------------------

function renderPortfolioTab(client) {
  const panel = document.getElementById("panel-portfolio");
  const accounts = client.accounts || [];
  const totalAum = client.total_aum || accounts.reduce((s, a) => s + (a.value || 0), 0);

  // Color palette for account types (contrast-safe on white)
  const typeColors = {
    Advisory: "#1B5EAB",
    Brokerage: "#B45309",
    Retirement: "#15803D",
    Education: "#2563EB",
    "Cash Management": "#7C3AED",
    Trust: "#DB2777",
    Lending: "#64748B",
  };
  const defaultColors = ["#1B5EAB", "#15803D", "#B45309", "#2563EB", "#DB2777", "#7C3AED", "#64748B", "#C2410C"];

  // Assign colors to each account
  const accountColors = accounts.map((a, i) => typeColors[a.type] || defaultColors[i % defaultColors.length]);

  // --- Donut Chart (SVG) ---
  const donutSegments = buildDonutSegments(accounts, totalAum, accountColors);

  // --- YTD Performance Bar Chart ---
  const perfAccounts = accounts.filter(a => a.ytd_return !== null && a.ytd_return !== undefined);
  const maxYtd = Math.max(...perfAccounts.map(a => Math.abs(a.ytd_return)), 1);

  let perfBarsHtml = "";
  for (const acct of perfAccounts) {
    const color = accountColors[accounts.indexOf(acct)];
    const widthPct = Math.abs(acct.ytd_return) / maxYtd * 100;
    const sign = acct.ytd_return >= 0 ? "+" : "";
    const barClass = acct.ytd_return >= 0 ? "perf-positive" : "perf-negative";
    const shortName = acct.name.length > 28 ? acct.name.substring(0, 26) + "…" : acct.name;

    perfBarsHtml += `
      <div class="perf-row">
        <div class="perf-label" title="${escapeHtml(acct.name)}">${escapeHtml(shortName)}</div>
        <div class="perf-bar-track">
          <div class="perf-bar-fill ${barClass}" style="width: ${widthPct}%; background: ${color}"></div>
        </div>
        <div class="perf-value ${barClass}">${sign}${acct.ytd_return}%</div>
      </div>`;
  }

  // --- Account detail cards (compact) ---
  let cardsHtml = "";
  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];
    const color = accountColors[i];
    const pct = totalAum > 0 ? ((acct.value / totalAum) * 100).toFixed(1) : 0;
    const flags = (acct.flags || []).map(f => `<div class="account-flag">${escapeHtml(f)}</div>`).join("");
    const tt365 = acct.total_tax_365 ? `<span class="tt365-badge">Total Tax 365</span>` : "";

    cardsHtml += `
      <div class="account-card-v2">
        <div class="account-color-bar" style="background: ${color}"></div>
        <div class="account-card-body">
          <div class="account-card-top">
            <div class="account-name-v2">${escapeHtml(acct.name)}</div>
            <div class="account-value-v2">$${formatNumber(acct.value)}</div>
          </div>
          <div class="account-meta-v2">
            <span class="account-pct">${pct}%</span>
            <span class="account-type-v2">${escapeHtml(acct.type)}</span>
            <span class="account-program-v2">${escapeHtml(acct.program || "")}</span>
            ${tt365}
          </div>
          <div class="account-holdings-v2">${escapeHtml(acct.holdings_summary || "")}</div>
          ${flags}
        </div>
      </div>`;
  }

  // --- Assemble layout ---
  panel.innerHTML = `
    <div class="portfolio-charts-row">
      <div class="chart-card donut-card">
        <div class="chart-title">AUM Allocation</div>
        <div class="donut-container">
          <svg viewBox="0 0 200 200" class="donut-svg">
            ${donutSegments.arcs}
          </svg>
          <div class="donut-center">
            <div class="donut-center-value">$${formatNumber(totalAum)}</div>
            <div class="donut-center-label">Total AUM</div>
          </div>
        </div>
        <div class="donut-legend">
          ${donutSegments.legend}
        </div>
      </div>
      <div class="chart-card perf-card">
        <div class="chart-title">YTD Performance</div>
        <div class="perf-chart">
          ${perfBarsHtml || '<div class="empty-tab">No performance data</div>'}
        </div>
      </div>
    </div>
    <div class="chart-title" style="margin-top: 20px; margin-bottom: 12px;">Account Details</div>
    <div class="accounts-grid-v2">
      ${cardsHtml}
    </div>`;
}

function buildDonutSegments(accounts, totalAum, colors) {
  const cx = 100, cy = 100, radius = 80, strokeWidth = 28;
  const circumference = 2 * Math.PI * radius;
  let cumulativeOffset = 0;
  let arcs = "";
  let legend = "";

  // Background ring
  arcs += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#E8EBF0" stroke-width="${strokeWidth}" />`;

  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];
    const pct = totalAum > 0 ? acct.value / totalAum : 0;
    if (pct <= 0) continue;

    const dashLength = pct * circumference;
    const gapLength = circumference - dashLength;
    const color = colors[i];

    arcs += `<circle
      cx="${cx}" cy="${cy}" r="${radius}"
      fill="none"
      stroke="${color}"
      stroke-width="${strokeWidth}"
      stroke-dasharray="${dashLength} ${gapLength}"
      stroke-dashoffset="${-cumulativeOffset}"
      stroke-linecap="butt"
      transform="rotate(-90 ${cx} ${cy})"
      class="donut-segment"
      data-index="${i}"
    />`;

    cumulativeOffset += dashLength;

    const shortName = acct.name.length > 22 ? acct.name.substring(0, 20) + "…" : acct.name;
    legend += `
      <div class="legend-item">
        <span class="legend-dot" style="background: ${color}"></span>
        <span class="legend-text">${escapeHtml(shortName)}</span>
        <span class="legend-pct">${(pct * 100).toFixed(1)}%</span>
      </div>`;
  }

  return { arcs, legend };
}

function renderGoalsTab(client) {
  const panel = document.getElementById("panel-goals");
  if (!client.gps_goals || client.gps_goals.length === 0) {
    panel.innerHTML = `<div class="empty-tab">No GPS goals configured</div>`;
    return;
  }

  let html = `<div class="goals-grid-v2">`;
  for (const goal of client.gps_goals) {
    const progressColor = goal.on_track ? "#16A34A" : "#D97706";
    const statusClass = goal.on_track ? "on-track" : "behind";
    const statusText = goal.on_track ? "On Track" : "Behind";
    const pct = Math.min(goal.current_progress, 100);

    // Mini ring chart SVG
    const r = 30, sw = 6, circ = 2 * Math.PI * r;
    const dash = (pct / 100) * circ;
    const gap = circ - dash;

    const ringsvg = `
      <svg viewBox="0 0 72 72" class="goal-ring">
        <circle cx="36" cy="36" r="${r}" fill="none" stroke="#E8EBF0" stroke-width="${sw}" />
        <circle cx="36" cy="36" r="${r}" fill="none" stroke="${progressColor}" stroke-width="${sw}"
          stroke-dasharray="${dash} ${gap}" stroke-dashoffset="${circ * 0.25}" stroke-linecap="round"
          transform="rotate(-90 36 36)" />
        <text x="36" y="36" text-anchor="middle" dominant-baseline="central"
          fill="${progressColor}" font-size="13" font-weight="700">${pct}%</text>
      </svg>`;

    html += `
      <div class="goal-card-v2">
        <div class="goal-ring-wrap">${ringsvg}</div>
        <div class="goal-info">
          <div class="goal-name-v2">${escapeHtml(goal.name)}</div>
          <div class="goal-meta-v2">
            <span>Target: $${formatNumber(goal.target)}</span>
            <span>By ${goal.timeline}</span>
            <span class="goal-status ${statusClass}">${statusText}</span>
          </div>
        </div>
      </div>`;
  }
  html += `</div>`;
  panel.innerHTML = html;
}

function renderPersonalTab(client) {
  const panel = document.getElementById("panel-personal");
  const p = client.personal || {};

  const sections = [
    { icon: "\u{1F468}\u200D\u{1F469}\u200D\u{1F466}", label: "Family", items: p.family || [] },
    { icon: "\u{1F4BC}", label: "Career", items: p.career ? [p.career] : [] },
    { icon: "\u{1F4C5}", label: "Life Events", items: p.life_events || [] },
    { icon: "\u{2B50}", label: "Interests", items: p.interests || [] },
  ];

  let html = `<div class="personal-grid">`;
  for (const sec of sections) {
    if (sec.items.length === 0) continue;
    html += `
      <div class="personal-section">
        <div class="personal-label">${sec.icon} ${sec.label}</div>
        <ul class="personal-list">
          ${sec.items.map(i => `<li>${escapeHtml(i)}</li>`).join("")}
        </ul>
      </div>`;
  }
  html += `</div>`;

  if (client.compliance_notes) {
    html += `<div class="compliance-box">
      <div class="compliance-label">\u{1F6E1}\u{FE0F} Compliance Notes</div>
      <p>${escapeHtml(client.compliance_notes)}</p>
    </div>`;
  }

  panel.innerHTML = html;
}

function renderHistoryTab(client) {
  const panel = document.getElementById("panel-history");
  const convos = client.past_conversations || [];

  if (convos.length === 0) {
    panel.innerHTML = `<div class="empty-tab">No past conversation records</div>`;
    return;
  }

  let html = `<div class="history-timeline">`;
  for (const conv of convos) {
    const actions = (conv.action_items || []).map(a =>
      `<li>${escapeHtml(a)}</li>`
    ).join("");

    html += `
      <div class="history-entry">
        <div class="history-date">${formatDate(conv.date)}</div>
        <div class="history-summary">${escapeHtml(conv.summary)}</div>
        ${actions ? `<div class="history-actions"><strong>Action Items:</strong><ul>${actions}</ul></div>` : ""}
      </div>`;
  }
  html += `</div>`;
  panel.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Tab Switching
// ---------------------------------------------------------------------------

document.querySelectorAll(".detail-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".detail-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".detail-panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add("active");
  });
});

// ---------------------------------------------------------------------------
// Discussion Points + Start Call
// ---------------------------------------------------------------------------

function updatePlaceholders(client) {
  const inputs = document.querySelectorAll(".discussion-input");
  const goals = client.gps_goals || [];
  const convos = client.past_conversations || [];
  const lastActions = convos.length > 0 ? convos[0].action_items || [] : [];

  const suggestions = [];
  for (const g of goals) {
    if (!g.on_track) suggestions.push(`Review ${g.name} — currently behind target`);
  }
  for (const a of lastActions.slice(0, 2)) {
    suggestions.push(`Follow up: ${a}`);
  }
  const accounts = client.accounts || [];
  for (const acct of accounts) {
    if (acct.flags && acct.flags.length > 0) {
      suggestions.push(`Address: ${acct.flags[0]}`);
    }
  }

  for (let i = 0; i < Math.min(suggestions.length, 3); i++) {
    if (inputs[i]) inputs[i].placeholder = `e.g., ${suggestions[i]}`;
  }
}

startCallBtn.addEventListener("click", () => {
  if (!selectedClient) {
    alert("Please select a client first.");
    return;
  }

  const inputs = document.querySelectorAll(".discussion-input");
  const points = Array.from(inputs)
    .map(inp => inp.value.trim())
    .filter(v => v.length > 0);

  if (points.length === 0) {
    if (!confirm("You haven't entered any discussion points. Start call without the Discussion Tracker?")) {
      return;
    }
  }

  sessionStorage.setItem("wingman_client_id", selectedClient.id);
  sessionStorage.setItem("wingman_client_name", selectedClient.name);
  sessionStorage.setItem("wingman_discussion_points", JSON.stringify(points));

  window.location.href = `/?client=${encodeURIComponent(selectedClient.id)}`;
});

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

function getInitials(name) {
  return name.split(/[\s&]+/).filter(w => w.length > 0).map(w => w[0]).join("").substring(0, 2).toUpperCase();
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(0) + "K";
  return n.toLocaleString();
}

function formatDate(dateStr) {
  if (!dateStr) return "N/A";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// Auto-focus search on page load
searchInput.focus();
