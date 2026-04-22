/**
 * SPXer Dashboard — Live SPX Chart (lightweight-charts v5).
 *
 * - Loads initial bars from dashboard /api/bars proxy
 * - Connects directly to data service WebSocket for real-time spx_bar updates
 * - Draws HMA fast/slow + EMA 9/21 overlays from bar indicators
 * - Timeframe switching (1m/5m/15m/1h)
 */

var spxChart = null;
var spxCandleSeries = null;
var hmaFastSeries = null;
var hmaSlowSeries = null;
var ema9Series = null;
var ema21Series = null;
var chartWs = null;
var chartReconnectTimer = null;
var chartReconnectDelay = 1000;
var currentTf = '1m';

// ET offset: UTC -> ET display. lightweight-charts treats times as UTC,
// so we shift timestamps to make ET times display correctly.
function isDSTChart(dateStr) {
  var d = new Date(dateStr + 'T12:00:00Z');
  var year = d.getUTCFullYear();
  var mar1 = new Date(Date.UTC(year, 2, 1));
  var dstStart = new Date(Date.UTC(year, 2, 14 - mar1.getUTCDay()));
  var nov1 = new Date(Date.UTC(year, 10, 1));
  var dstEnd = new Date(Date.UTC(year, 10, 7 - nov1.getUTCDay()));
  return d >= dstStart && d < dstEnd;
}

var etOffsetSec = (function() {
  var today = new Date().toISOString().slice(0, 10);
  return isDSTChart(today) ? -4 * 3600 : -5 * 3600;
})();

function toEt(utcTs) {
  return utcTs + etOffsetSec;
}

// ── Chart creation ────────────────────────────────────────────────────────

function initChart() {
  var container = document.getElementById('chartContainer');
  if (!container || typeof LightweightCharts === 'undefined') return;

  if (spxChart) {
    spxChart.remove();
    spxChart = null;
  }

  spxChart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight || 380,
    layout: { background: { color: '#0a0e17' }, textColor: '#64748b' },
    grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#1e293b' },
    rightPriceScale: { borderColor: '#1e293b', autoScale: true },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
    handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
  });

  spxCandleSeries = spxChart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#4ade80', downColor: '#f87171',
    borderUpColor: '#4ade80', borderDownColor: '#f87171',
    wickUpColor: '#4ade8088', wickDownColor: '#f8717188',
  });

  // HMA 3 (fast) — warm orange
  hmaFastSeries = spxChart.addSeries(LightweightCharts.LineSeries, {
    color: '#f59e0b', lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  // HMA 12 (slow) — purple
  hmaSlowSeries = spxChart.addSeries(LightweightCharts.LineSeries, {
    color: '#8b5cf6', lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  // EMA 9 — cyan
  ema9Series = spxChart.addSeries(LightweightCharts.LineSeries, {
    color: '#06b6d4', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  // EMA 21 — muted slate
  ema21Series = spxChart.addSeries(LightweightCharts.LineSeries, {
    color: '#475569', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  // Resize
  var ro = new ResizeObserver(function() {
    if (spxChart) {
      spxChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    }
  });
  ro.observe(container);

  loadBars(currentTf);
}

// ── Load historical bars via REST ─────────────────────────────────────────

function loadBars(tf) {
  var n = tf === '1m' ? 390 : tf === '5m' ? 200 : tf === '15m' ? 100 : 50;
  fetch(apiUrl('/api/bars?tf=' + tf + '&n=' + n))
    .then(function(r) { return r.json(); })
    .then(function(bars) {
      if (!Array.isArray(bars) || !bars.length) return;
      setChartData(bars);
    })
    .catch(function(e) { console.error('Chart load failed:', e); });
}

function setChartData(bars) {
  if (!spxCandleSeries) return;

  var candles = [];
  var hmaF = [];
  var hmaS = [];
  var e9 = [];
  var e21 = [];

  for (var i = 0; i < bars.length; i++) {
    var b = bars[i];
    var t = toEt(b.ts);
    candles.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close });

    var ind = b.indicators || {};
    if (ind.hma3 != null) hmaF.push({ time: t, value: ind.hma3 });
    if (ind.hma12 != null) hmaS.push({ time: t, value: ind.hma12 });
    if (ind.ema9 != null) e9.push({ time: t, value: ind.ema9 });
    if (ind.ema21 != null) e21.push({ time: t, value: ind.ema21 });
  }

  spxCandleSeries.setData(candles);
  hmaFastSeries.setData(hmaF);
  hmaSlowSeries.setData(hmaS);
  ema9Series.setData(e9);
  ema21Series.setData(e21);

  spxChart.timeScale().fitContent();
}

// ── WebSocket for live bar updates ────────────────────────────────────────

function connectChartWs() {
  if (chartWs && chartWs.readyState <= 1) return;

  // Connect to data service WS (port 3600) directly or via nginx proxy
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl;
  if (location.protocol === 'https:') {
    wsUrl = proto + '//' + location.host + '/spxer-ws';
  } else {
    wsUrl = 'ws://' + location.hostname + ':3600/ws';
  }

  chartWs = new WebSocket(wsUrl);

  chartWs.onopen = function() {
    chartReconnectDelay = 1000;
    chartWs.send(JSON.stringify({ action: 'subscribe', channel: 'spx' }));
  };

  chartWs.onmessage = function(evt) {
    try {
      var msg = JSON.parse(evt.data);
      if (msg.type === 'spx_bar' && currentTf === '1m') {
        handleLiveBar(msg.data || msg);
      }
    } catch (e) {}
  };

  chartWs.onclose = function() {
    chartReconnectTimer = setTimeout(function() {
      chartReconnectDelay = Math.min(chartReconnectDelay * 2, 30000);
      connectChartWs();
    }, chartReconnectDelay);
  };

  chartWs.onerror = function() { chartWs.close(); };
}

function handleLiveBar(d) {
  if (!spxCandleSeries) return;

  var t = toEt(d.ts);
  var candle = {
    time: t,
    open: d.open != null ? d.open : d.o,
    high: d.high != null ? d.high : d.h,
    low: d.low != null ? d.low : d.l,
    close: d.close != null ? d.close : d.c,
  };

  if (!candle.time || !candle.open) return;

  spxCandleSeries.update(candle);

  // Update indicator overlays from the bar
  var ind = d.indicators || {};
  if (ind.hma3 != null) hmaFastSeries.update({ time: t, value: ind.hma3 });
  if (ind.hma12 != null) hmaSlowSeries.update({ time: t, value: ind.hma12 });
  if (ind.ema9 != null) ema9Series.update({ time: t, value: ind.ema9 });
  if (ind.ema21 != null) ema21Series.update({ time: t, value: ind.ema21 });

  // Auto-scroll to latest bar
  if (spxChart) spxChart.timeScale().scrollToRealTime();
}

// ── Timeframe switching ───────────────────────────────────────────────────

function switchTf(tf) {
  currentTf = tf;

  var btns = document.querySelectorAll('.tf-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].className = btns[i].getAttribute('data-tf') === tf
      ? 'tf-btn active'
      : 'tf-btn';
  }

  loadBars(tf);
}

// ── Boot ──────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    initChart();
    connectChartWs();
  });
} else {
  setTimeout(function() {
    initChart();
    connectChartWs();
  }, 100);
}
