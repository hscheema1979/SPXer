/**
 * SPXer Dashboard — Frontend JavaScript.
 * Connects via WebSocket for real-time updates, falls back to REST polling.
 */

let ws = null;
let reconnectDelay = 1000;
let paused = false;

// Path prefix for reverse proxy (e.g. '/spxer/dashboard' behind bitloom.cloud)
const BASE = (document.querySelector('meta[name="base-path"]')?.content || '') || '';

// ── API Calls ──────────────────────────────────────────────────────────────

function apiUrl(path) { return BASE + path; }

async function apiCall(endpoint, method = 'GET') {
  try {
    const resp = await fetch(apiUrl(endpoint), { method });
    return await resp.json();
  } catch (e) {
    console.error('API call failed:', endpoint, e);
    return null;
  }
}

async function pauseTrading() {
  const result = await apiCall('/api/pause', 'POST');
  if (result) fetchState();
}

async function resumeTrading() {
  const result = await apiCall('/api/resume', 'POST');
  if (result) fetchState();
}

async function killAll() {
  if (!confirm('⚠️ Kill all agents and cancel all orders?')) return;
  const result = await apiCall('/api/kill', 'POST');
  if (result) {
    alert(`Killed agents. Cancelled ${result.cancelledOrders || 0} orders.`);
    fetchState();
  }
}

// ── State Fetch ────────────────────────────────────────────────────────────

async function fetchState() {
  const state = await apiCall('/api/status');
  if (state) renderState(state);
}

// ── Rendering ──────────────────────────────────────────────────────────────

function renderState(state) {
  // Time
  document.getElementById('timeET').textContent = state.timeET || '--:--:-- ET';

  // Pause banner
  paused = state.tradingPaused;
  const banner = document.getElementById('pausedBanner');
  banner.className = paused ? 'paused-banner active' : 'paused-banner';
  document.getElementById('btnPause').disabled = paused;
  document.getElementById('btnResume').disabled = !paused;

  // System status
  const ds = state.dataService;
  renderStatus('dsStatus', ds.healthy, ds.status || '—', ds.healthy);
  
  const spxPrice = ds.lastSpxPrice;
  document.getElementById('spxPrice').textContent = spxPrice ? `$${spxPrice.toFixed(2)}` : '—';
  document.getElementById('spxPrice').className = 'status-value';
  
  const wd = state.watchdog;
  if (wd) {
    renderStatus('wdStatus', wd.healthy, wd.healthy ? 'OK' : 'ALERT', wd.healthy);
  } else {
    document.getElementById('wdStatus').innerHTML = '<span class="dot gray"></span>Not running';
  }
  
  document.getElementById('contracts').textContent = state.dataService.trackedContracts ?? '—';

  // Agents
  if (state.agents.spx) {
    const agent = state.agents.spx;
    const age = agent.heartbeatAgeSec;
    const healthy = agent.healthy;
    renderStatus('spxAgent', healthy, healthy ? `OK (${age}s)` : `STALE (${age}s)`, healthy);
    
    // Daily P&L from agent status
    const pnl = agent.status?.dailyPnL;
    const pnlEl = document.getElementById('dailyPnl');
    if (pnl != null) {
      pnlEl.textContent = `$${pnl.toFixed(0)}`;
      pnlEl.className = `status-value ${pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`;
    }
    
    const trades = agent.status?.cycle;
    document.getElementById('tradesToday').textContent = trades ?? '—';
  }
  
  if (state.agents.xsp) {
    const agent = state.agents.xsp;
    const age = agent.heartbeatAgeSec;
    const healthy = agent.healthy;
    // XSP shares status file with SPX for now
    renderStatus('xspAgent', healthy, healthy ? `OK (${age}s)` : `STALE (${age}s)`, healthy);
  }

  // Positions
  const posEl = document.getElementById('positions');
  if (state.positions && state.positions.length > 0) {
    posEl.innerHTML = state.positions.map(p => `
      <div class="position-card">
        <div class="pos-header">
          <span class="pos-symbol">${p.symbol}</span>
          <span class="pos-side ${p.side}">${p.side.toUpperCase()}</span>
        </div>
        <div class="pos-details">
          <span class="status-label">Qty: ${p.quantity}</span>
          <span class="status-label">Entry: $${p.entryPrice.toFixed(2)}</span>
          ${p.currentPrice ? `<span>Current: $${p.currentPrice.toFixed(2)}</span>` : ''}
          ${p.pnl != null ? `<span class="${p.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">P&L: $${p.pnl.toFixed(0)}</span>` : ''}
        </div>
      </div>
    `).join('');
  } else {
    posEl.innerHTML = '<span class="status-label">No positions</span>';
  }

  // Recent trades
  const tradesEl = document.getElementById('recentTrades');
  const header = '<div class="trade-row trade-header"><span>Time</span><span>Symbol</span><span>Side</span><span>Qty</span><span>Fill</span><span>P&L</span></div>';
  if (state.recentTrades && state.recentTrades.length > 0) {
    const rows = state.recentTrades.map(t => {
      const pnlClass = t.pnl != null ? (t.pnl >= 0 ? 'pnl-positive' : 'pnl-negative') : '';
      const pnlStr = t.pnl != null ? `$${t.pnl.toFixed(0)}` : '—';
      return `<div class="trade-row">
        <span>${t.timeET}</span>
        <span>${t.symbol.slice(-13)}</span>
        <span>${t.side.slice(0,1).toUpperCase()}</span>
        <span>${t.qty}x</span>
        <span>$${t.fillPrice.toFixed(2)}</span>
        <span class="${pnlClass}">${pnlStr}</span>
      </div>`;
    }).join('');
    tradesEl.innerHTML = header + rows;
  } else {
    tradesEl.innerHTML = header + '<div class="trade-row"><span class="status-label" style="grid-column:1/-1">No recent trades</span></div>';
  }
}

function renderStatus(elementId, healthy, text, isHealthy) {
  const el = document.getElementById(elementId);
  const dotClass = isHealthy ? 'green' : 'red';
  const textClass = isHealthy ? 'healthy' : 'unhealthy';
  el.innerHTML = `<span class="dot ${dotClass}"></span><span class="${textClass}">${text}</span>`;
}

// ── WebSocket ──────────────────────────────────────────────────────────────

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}${BASE}/ws`;
  
  ws = new WebSocket(url);
  
  ws.onopen = () => {
    console.log('WebSocket connected');
    reconnectDelay = 1000;
  };
  
  ws.onmessage = (event) => {
    try {
      const state = JSON.parse(event.data);
      renderState(state);
    } catch (e) {
      console.error('WS parse error:', e);
    }
  };
  
  ws.onclose = () => {
    console.log(`WebSocket closed, reconnecting in ${reconnectDelay}ms`);
    setTimeout(connectWS, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };
  
  ws.onerror = () => ws.close();
}

// ── Init ───────────────────────────────────────────────────────────────────

// Fetch initial state via REST, then connect WebSocket
fetchState();
connectWS();

// Fallback: poll every 10s even with WS (in case WS drops silently)
setInterval(fetchState, 10000);
