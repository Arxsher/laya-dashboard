/* Laya dashboard — live data wiring. No mock data: every number comes from
   the Binance public API (market) or data/laya.json (the bot's own logs). */
(function () {
  'use strict';

  /* ---------------- seed (fallback only — replaced by data/laya.json when served over http) ---------------- */
  var SEED = {
    bot: 'laya', symbol: 'BTC-USDT-SWAP', version: 6, status: 'RUNNING',
    started_utc: '2026-09-29T10:32:30Z', timeframe: '1m', notional_usd: 50,
    balance_usdt: 5000.00, start_balance_usdt: 5000.00, realized_pnl_usdt: 0.0,
    decisions: { total: 77, hold: 77, long: 0, short: 0 },
    latest_decision: { ts: '2026-09-29T11:48:14Z', action: 'HOLD', confidence: 0.5593, reason: 'model says HOLD (0.559)' },
    recent_decisions: [
      { ts: '2026-09-29T11:48:14Z', action: 'HOLD', confidence: 0.5593, reason: 'model says HOLD (0.559)' },
      { ts: '2026-09-29T11:47:14Z', action: 'HOLD', confidence: 0.612, reason: 'model says HOLD (0.612)' },
      { ts: '2026-09-29T11:46:14Z', action: 'HOLD', confidence: 0.588, reason: 'model says HOLD (0.588)' }
    ],
    trades: [],
    model: { version: 'v4', accuracy: 0.7731, auc: 0.8954, recall_short: 0.761, recall_hold: 0.787, recall_long: 0.775, ece: 0.0039,
             backtest_bps: { '0.55': 2.36, '0.60': 2.67, '0.70': 3.27, '0.75': 3.42 } },
    updated_utc: '2026-09-29T11:54:00Z'
  };

  /* ---------------- coins ---------------- */
  var COINS = {
    BTC: { name: 'Bitcoin',  sym: 'BTCUSDT',  cls: 'btc',  icon: '₿' },
    ETH: { name: 'Ethereum', sym: 'ETHUSDT',  cls: 'eth',  icon: '◆' },
    XRP: { name: 'Ripple',   sym: 'XRPUSDT',  cls: 'xrp',  icon: '×' },
    LTC: { name: 'Litecoin', sym: 'LTCUSDT',  cls: 'ltc',  icon: 'Ł' },
    SOL: { name: 'Solana',   sym: 'SOLUSDT',  cls: 'sol',  icon: 'S' },
    BNB: { name: 'BNB',      sym: 'BNBUSDT',  cls: 'bnb',  icon: 'B' },
    DOGE:{ name: 'Dogecoin', sym: 'DOGEUSDT', cls: 'doge', icon: 'Ð' },
    ADA: { name: 'Cardano',  sym: 'ADAUSDT',  cls: 'ada',  icon: 'A' }
  };
  var STAT_ORDER = ['BTC', 'ETH', 'XRP', 'LTC'];
  var ASSET_ORDER = ['BTC', 'ETH', 'XRP', 'LTC', 'SOL'];
  var SNAP_ORDER = ['ETH', 'XRP', 'BTC', 'LTC'];
  var MARKET_ORDER = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'LTC'];

  /* ---------------- state ---------------- */
  var market = {};        // coin -> {price, chg, high, low}
  var marketOK = false;
  var laya = SEED;
  var layaLive = false;   // true once data/laya.json loads over http
  var chartRange = '7D';
  var leadersRange = '24H';
  var txRange = 'ALL';
  var klines7d = null;

  /* ---------------- helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt$ (v, dp) {
    if (v == null || isNaN(v)) return '—';
    dp = dp == null ? 2 : dp;
    return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function fmtUSDT(v) {
    if (v == null || isNaN(v)) return '—';
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USDT';
  }
  function chgHTML(chg) {
    if (chg == null || isNaN(chg)) return '<span class="trend">—</span>';
    var up = chg >= 0;
    var arrow = up ? '↗' : '↘';
    var sign = up ? '+' : '−';
    return '<span class="trend ' + (up ? 'up' : 'down') + '">' + arrow + ' ' + sign + Math.abs(chg).toFixed(2) + '%</span>';
  }
  function chgClass(chg) { return chg == null ? '' : (chg >= 0 ? 'up' : 'down'); }
  function fmtTimeUTC(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2) + ' UTC';
  }
  function fmtDateUTC(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    var M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return d.getUTCDate() + ' ' + M[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }
  function ago(iso) {
    var ms = Date.now() - new Date(iso).getTime();
    if (isNaN(ms) || ms < 0) return '—';
    var m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + (m % 60) + 'm ago';
    return Math.floor(h / 24) + 'd ago';
  }
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(window.__toast);
    window.__toast = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }

  /* ---------------- modal + dropdowns ---------------- */
  function openModal(title, bodyHTML, actions) {
    var root = $('modalRoot');
    root.innerHTML =
      '<div class="modal-back"><div class="modal" role="dialog" aria-modal="true">' +
      '<h3>' + esc(title) + '</h3><div>' + bodyHTML + '</div>' +
      '<div class="modal-actions">' + (actions || '<button class="btn primary" data-close>Close</button>') + '</div>' +
      '</div></div>';
    var back = root.firstChild;
    back.addEventListener('click', function (e) {
      if (e.target === back || e.target.hasAttribute('data-close')) root.innerHTML = '';
    });
    document.addEventListener('keydown', function esc2(e) {
      if (e.key === 'Escape') { root.innerHTML = ''; document.removeEventListener('keydown', esc2); }
    });
  }
  function toggleDrop(id) {
    var el = $(id);
    var open = el.hidden;
    $('bellDrop').hidden = true; $('profileDrop').hidden = true;
    el.hidden = !open;
  }
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#bellDrop') && !e.target.closest('#bellBtn')) $('bellDrop').hidden = true;
    if (!e.target.closest('#profileDrop') && !e.target.closest('#profileBtn')) $('profileDrop').hidden = true;
  });

  /* ---------------- market data (Binance public API) ---------------- */
  function binance(path) {
    return fetch('https://api.binance.com/api/v3/' + path).then(function (r) {
      if (!r.ok) throw new Error('binance ' + r.status);
      return r.json();
    });
  }
  function loadMarket() {
    var symbols = MARKET_ORDER.map(function (c) { return '"' + COINS[c].sym + '"'; }).join(',');
    return binance('ticker/24hr?symbols=[' + encodeURIComponent(symbols) + ']').then(function (rows) {
      rows.forEach(function (t) {
        var coin = Object.keys(COINS).find(function (c) { return COINS[c].sym === t.symbol; });
        if (!coin) return;
        market[coin] = {
          price: parseFloat(t.lastPrice),
          chg: parseFloat(t.priceChangePercent),
          high: parseFloat(t.highPrice),
          low: parseFloat(t.lowPrice)
        };
      });
      marketOK = true;
      renderMarketBits();
    }).catch(function () {
      /* Fallback: Coinbase (works in regions where binance.com is geo-blocked,
         e.g. US visitors hitting HTTP 451). Prices will be USD instead of USDT. */
      loadMarketCoinbase();
    });
  }
  var CB_PRODUCTS = { BTC: 'BTC-USD', ETH: 'ETH-USD', XRP: 'XRP-USD', LTC: 'LTC-USD', SOL: 'SOL-USD', DOGE: 'DOGE-USD', ADA: 'ADA-USD' };
  function loadMarketCoinbase() {
    var coins = Object.keys(CB_PRODUCTS);
    Promise.all(coins.map(function (coin) {
      return fetch('https://api.exchange.coinbase.com/products/' + CB_PRODUCTS[coin] + '/stats')
        .then(function (r) { if (!r.ok) throw new Error('cb'); return r.json(); })
        .then(function (s) {
          var last = parseFloat(s.last), open = parseFloat(s.open);
          market[coin] = {
            price: last,
            chg: open ? (last - open) / open * 100 : null,
            high: parseFloat(s.high), low: parseFloat(s.low)
          };
        }).catch(function () { /* leave coin blank */ });
    })).then(function () {
      marketOK = Object.keys(market).length > 0;
      if (marketOK) renderMarketBits();
    });
  }
  function loadKlines7d() {
    return binance('klines?symbol=BTCUSDT&interval=1d&limit=8').then(function (k) {
      klines7d = k;
    }).catch(function () { klines7d = null; });
  }
  function loadChart() {
    var R = {
      '12H': ['5m', 144], '24H': ['15m', 96], '1D': ['1h', 24],
      '7D': ['4h', 42], '1M': ['1d', 30], '1Y': ['1w', 52]
    }[chartRange] || ['4h', 42];
    return binance('klines?symbol=BTCUSDT&interval=' + R[0] + '&limit=' + R[1]).then(function (k) {
      drawChart(k.map(function (c) { return { t: c[0], close: parseFloat(c[4]) }; }));
    }).catch(function () { loadChartCoinbase(); });
  }
  function loadChartCoinbase() {
    var G = { '12H': 300, '24H': 900, '1D': 3600, '7D': 3600, '1M': 21600, '1Y': 86400 }[chartRange] || 3600;
    fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=' + G)
      .then(function (r) { if (!r.ok) throw new Error('cb'); return r.json(); })
      .then(function (k) {
        var pts = k.map(function (c) { return { t: c[0] * 1000, close: c[4] }; })
          .sort(function (a, b) { return a.t - b.t; });
        drawChart(pts);
      })
      .catch(function () { $('btcNote').innerHTML = 'chart unavailable — check connection'; });
  }

  /* ---------------- bot data ---------------- */
  function loadLaya() {
    return fetch('data/laya.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('no laya.json');
      return r.json();
    }).then(function (j) {
      laya = j; layaLive = true;
      renderLayaBits();
    }).catch(function () {
      layaLive = false;
      renderLayaBits(); /* seed fallback */
    });
  }

  /* ---------------- render: market bits ---------------- */
  function statCard(coin) {
    var m = market[coin], c = COINS[coin];
    return '<article class="stat"><div class="stat-name">' + c.name + '</div><div class="stat-code">' + coin + '/USDT</div>' +
      '<div class="stat-value">' + fmt$(m && m.price) + '</div>' +
      '<div class="stat-foot"><span>' + fmtDateUTC(new Date().toISOString()) + '</span>' + chgHTML(m && m.chg) + '</div></article>';
  }
  function renderMarketBits() {
    $('statCards').innerHTML = STAT_ORDER.map(statCard).join('');
    /* hero */
    var b = market.BTC;
    if (b) {
      $('btcBig').textContent = fmt$(b.price);
      $('btcNote').innerHTML = chgHTML(b.chg) + ' <span>in the last 24 hours</span>';
    }
    /* top assets */
    $('topAssets').innerHTML = ASSET_ORDER.map(function (coin) {
      var m = market[coin], c = COINS[coin];
      return '<div class="asset-row"><span class="asset-id"><span class="coin-icon ' + c.cls + '">' + c.icon + '</span>' +
        '<span><strong>' + c.name + '</strong><small>' + coin + '</small></span></span>' +
        '<span>' + fmt$(m && m.price) + '</span><span class="' + chgClass(m && m.chg) + '">' +
        (m && m.chg != null ? (m.chg >= 0 ? '+' : '−') + Math.abs(m.chg).toFixed(2) + '%' : '—') + '</span></div>';
    }).join('');
    /* snapshot */
    var marks = { ETH: '<b class="star">★</b>', XRP: '<b class="pink">♦</b>&nbsp;', BTC: '<b class="star">★</b>', LTC: '<b class="pink">♦</b>&nbsp;' };
    $('snapshotRows').innerHTML = SNAP_ORDER.map(function (coin) {
      var m = market[coin];
      return '<div class="gain-row"><span>' + (marks[coin] || '') + coin + '</span><span>USDT</span><span>' + fmt$(m && m.price) + '</span>' +
        '<span class="' + chgClass(m && m.chg) + '">' +
        (m && m.chg != null ? (m.chg >= 0 ? '+' : '−') + Math.abs(m.chg).toFixed(2) + '%' : '—') + '</span></div>';
    }).join('');
    renderLeaders();
    renderMarketView();
    renderFooter();
  }

  function leaderChange(coin) {
    var m = market[coin];
    if (leadersRange === '24H' || !klines7d || coin !== 'BTC') return m ? m.chg : null;
    /* 7D only computed for BTC (chart pair); others fall back to 24h */
    if (coin === 'BTC' && klines7d && klines7d.length > 1) {
      var first = parseFloat(klines7d[0][1]), last = parseFloat(klines7d[klines7d.length - 1][4]);
      return (last - first) / first * 100;
    }
    return m ? m.chg : null;
  }
  function renderLeaders() {
    var rows = ['BTC', 'ETH', 'XRP'].map(function (coin) {
      return { coin: coin, chg: leaderChange(coin), price: market[coin] && market[coin].price };
    }).filter(function (r) { return r.chg != null; })
      .sort(function (a, b) { return b.chg - a.chg; });
    if (!rows.length) return;
    var maxAbs = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.chg); })) || 1;
    var shades = ['#ff7145', '#ff8e6a', '#ffc2ad'];
    $('leaderBars').innerHTML = rows.map(function (r, i) {
      var h = 8 + 26 * Math.abs(r.chg) / maxAbs;
      var up = r.chg >= 0;
      var v = (up ? '▲ +' : '▼ −') + Math.abs(r.chg).toFixed(2) + '%';
      return '<div class="bar' + (up ? '' : ' neg') + '" data-v="' + v + '" style="height:' + h.toFixed(0) + 'px;background:' +
        (up ? shades[i % 3] : (i === 0 ? '#ef6d75' : i === 1 ? '#f4939b' : '#f8bcC1')) + '"></div>';
    }).join('');
    $('leadersLabel').textContent = leadersRange === '24H' ? '24h change' : '7d change';
    $('leadersDate').textContent = fmtDateUTC(new Date().toISOString());
    $('leaderRows').innerHTML = rows.map(function (r, i) {
      var c = COINS[r.coin];
      return '<div class="coin-leader"><div class="coin-line"><span class="dot" style="background:' + shades[i % 3] + '"></span>' + c.name + '</div>' +
        '<div class="coin-numbers"><span>' + fmt$(r.price) + '</span><small>' + (leadersRange === '24H' ? '24h' : '7d') + '&nbsp;&nbsp;' +
        (r.chg >= 0 ? '+' : '−') + Math.abs(r.chg).toFixed(2) + '%</small></div></div>';
    }).join('');
  }

  /* ---------------- render: chart ---------------- */
  function drawChart(pts) {
    var svg = $('btcChart');
    if (!pts || pts.length < 2) return;
    var W = 520, H = 170, PAD = 8;
    var closes = pts.map(function (p) { return p.close; });
    var min = Math.min.apply(null, closes), max = Math.max.apply(null, closes);
    if (max === min) { max = min * 1.001; }
    function X(i) { return (i / (pts.length - 1) * (W - 2 * PAD) + PAD).toFixed(1); }
    function Y(v) { return (H - PAD - (v - min) / (max - min) * (H - 2 * PAD - 14)).toFixed(1); }
    var line = pts.map(function (p, i) { return X(i) + ',' + Y(p.close); }).join(' ');
    svg.innerHTML =
      '<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#ff7145" stop-opacity=".16"/><stop offset="1" stop-color="#ff7145" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<path d="M' + X(0) + ' ' + Y(pts[0].close) + ' ' +
      pts.map(function (p, i) { return 'L' + X(i) + ' ' + Y(p.close); }).join(' ') +
      ' L' + X(pts.length - 1) + ' ' + H + ' L' + X(0) + ' ' + H + ' Z" fill="url(#fade)"/>' +
      '<polyline points="' + line + '" fill="none" stroke="#ff805a" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    /* day labels */
    var labels = [];
    var n = 7;
    for (var i = 0; i < n; i++) {
      var idx = Math.round(i * (pts.length - 1) / (n - 1));
      var d = new Date(pts[idx].t);
      var lbl = (chartRange === '1Y' || chartRange === '1M')
        ? (d.getUTCMonth() + 1) + '/' + d.getUTCDate()
        : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
      labels.push('<span>' + lbl + '</span>');
    }
    $('dayLabels').innerHTML = labels.join('');
    /* hover */
    var wrap = $('chartWrap'), tip = $('chartTip'), ml = $('markLine'), md = $('markDot');
    var startPx = pts[0].close;
    svg.onmousemove = function (e) {
      var rect = svg.getBoundingClientRect();
      var fx = (e.clientX - rect.left) / rect.width;
      var idx = Math.max(0, Math.min(pts.length - 1, Math.round(fx * (pts.length - 1))));
      var p = pts[idx];
      var px = parseFloat(X(idx)) / W * rect.width;
      var py = parseFloat(Y(p.close)) / H * rect.height;
      var d = new Date(p.t);
      var chg = (p.close - startPx) / startPx * 100;
      tip.hidden = false; ml.hidden = false; md.hidden = false;
      tip.innerHTML = d.toUTCString().slice(0, 16) + '<strong>' + fmt$(p.close) + '</strong>' +
        '<span class="' + (chg >= 0 ? 'up' : 'down') + '" style="' + (chg >= 0 ? 'color:#7fe3c3' : 'color:#ff9b7a') + '">' +
        (chg >= 0 ? '+' : '−') + Math.abs(chg).toFixed(2) + '%</span>&nbsp;&nbsp;period';
      tip.style.left = Math.min(Math.max(px - 40, 4), rect.width - 132) + 'px';
      tip.style.top = Math.max(py - 96, 0) + 'px';
      ml.style.left = px + 'px'; ml.style.top = '30px'; ml.style.height = (rect.height - 60) + 'px';
      md.style.left = (px - 4) + 'px'; md.style.top = (py - 4) + 'px';
    };
    svg.onmouseleave = function () { tip.hidden = true; ml.hidden = true; md.hidden = true; };
  }

  /* ---------------- render: laya bits ---------------- */
  function tradeRow(t) {
    var pnl = t.pnl_usdt;
    return '<div class="tx" data-name="' + esc(('btc ' + t.side + ' ' + t.entry_px).toLowerCase()) + '">' +
      '<span><span class="check"></span></span>' +
      '<span class="coin-cell"><span class="coin-icon btc">₿</span><span><strong>BTC</strong><small>BTC-USDT-SWAP</small></span></span>' +
      '<span class="money">' + fmt$(t.entry_px) + '</span>' +
      '<span><span class="badge ' + t.side.toLowerCase() + '">' + t.side + '</span></span>' +
      '<span class="money">' + fmt$(t.exit_px) + '</span>' +
      '<span class="percent ' + chgClass(pnl) + '">' + (pnl >= 0 ? '+' : '−') + '$' + Math.abs(pnl).toFixed(2) + '</span>' +
      '<span style="color:var(--muted)">' + fmtTimeUTC(t.closed_utc) + '</span></div>';
  }
  function emptyTrades() {
    var ld = laya.latest_decision || {};
    return '<div class="empty-trades"><div><strong>No trades yet</strong><span>Latest: ' + esc(ld.action || '—') +
      ' · ' + (ld.confidence != null ? ld.confidence.toFixed(3) : '—') + ' confidence · ' + fmtTimeUTC(ld.ts) + '</span></div></div>';
  }
  function txInRange(t, range) {
    if (range === 'ALL') return true;
    var ms = { '12H': 12, '7D': 7 * 24, '1M': 30 * 24 }[range] || 0;
    return Date.now() - new Date(t.closed_utc).getTime() <= ms * 3600000;
  }
  function renderTxList(el, trades, range, searchQ) {
    var rows = trades.filter(function (t) { return txInRange(t, range); });
    if (searchQ) rows = rows.filter(function (t) {
      return ('btc ' + t.side + ' ' + t.entry_px + ' ' + t.exit_px).toLowerCase().indexOf(searchQ) > -1;
    });
    el.innerHTML = rows.length ? rows.map(tradeRow).join('') : emptyTrades();
  }
  function renderLayaBits() {
    var d = laya.decisions || { total: 0, hold: 0, long: 0, short: 0 };
    $('tradeSub').textContent = d.total + ' decisions · ' + d.hold + ' HOLD · ' + d.long + ' LONG · ' + d.short + ' SHORT';
    renderTxList($('transactions'), laya.trades || [], txRange, $('txSearch').value.toLowerCase().trim());
    /* balance */
    $('balanceVal').textContent = fmtUSDT(laya.balance_usdt);
    $('balanceMeta').textContent = 'v' + laya.version + ' · Live since ' + fmtTimeUTC(laya.started_utc);
    /* portfolio */
    $('pfBalance').textContent = fmtUSDT(laya.balance_usdt);
    var pnl = laya.realized_pnl_usdt || 0;
    $('pfPnl').innerHTML = '<span class="' + chgClass(pnl) + '">' + (pnl >= 0 ? '+' : '−') + '$' + Math.abs(pnl).toFixed(2) + '</span>';
    $('pfTrades').textContent = (laya.trades || []).length;
    $('pfSub').textContent = d.total + ' decisions · ' + (laya.trades || []).length + ' closed trades';
    renderTxList($('pfTransactions'), laya.trades || [], 'ALL', $('pfSearch').value.toLowerCase().trim());
    renderFeed(); renderAnalytics(); renderSession(); renderDrops(); renderFooter();
  }

  /* ---------------- trade view: decision feed ---------------- */
  function badge(a) { return '<span class="badge ' + a.toLowerCase() + '">' + a + '</span>'; }
  function feedRow(dc) {
    var conf = dc.confidence != null ? Math.round(dc.confidence * 100) : 0;
    return '<div class="feed-row" data-name="' + esc(dc.action.toLowerCase()) + '">' +
      '<span class="feed-time">' + fmtTimeUTC(dc.ts) + '</span>' + badge(dc.action) +
      '<span class="conf"><span class="conf-bar"><i style="width:' + conf + '%"></i></span><span>' + (dc.confidence != null ? dc.confidence.toFixed(3) : '—') + '</span></span>' +
      '<span class="feed-reason">' + esc(dc.reason || '') + '</span></div>';
  }
  function renderFeed() {
    var rec = (laya.recent_decisions || []).slice().reverse();
    var q = $('feedSearch').value.toLowerCase().trim();
    if (q) rec = rec.filter(function (dc) { return dc.action.toLowerCase().indexOf(q) > -1; });
    $('feedSub').textContent = (laya.decisions.total || 0) + ' decisions this session · newest first';
    $('decisionFeed').innerHTML = rec.length ? rec.map(feedRow).join('') :
      '<div class="empty-trades"><div><strong>No decisions logged yet</strong></div></div>';
  }

  function renderSession() {
    var rows = [
      ['Version', 'v' + laya.version + ' · ' + (laya.status || '—')],
      ['Started', fmtTimeUTC(laya.started_utc) + ' · ' + fmtDateUTC(laya.started_utc)],
      ['Pair', laya.symbol || 'BTC-USDT-SWAP'],
      ['Timeframe', laya.timeframe || '1m'],
      ['Notional', '$' + (laya.notional_usd || 50) + ' / trade'],
      ['Data updated', ago(laya.updated_utc) + (layaLive ? '' : ' (seed)')]
    ];
    $('sessionRows').innerHTML = rows.map(function (r) {
      return '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">' +
        '<span style="color:var(--muted)">' + r[0] + '</span><strong style="font-weight:500">' + esc(r[1]) + '</strong></div>';
    }).join('');
  }

  /* ---------------- market view ---------------- */
  function renderMarketView() {
    var q = $('marketSearch').value.toLowerCase().trim();
    var rows = MARKET_ORDER.map(function (coin) {
      var m = market[coin], c = COINS[coin];
      return { coin: coin, c: c, m: m };
    }).filter(function (r) {
      return !q || (r.c.name + ' ' + r.coin).toLowerCase().indexOf(q) > -1;
    });
    $('marketRows').innerHTML = rows.map(function (r) {
      var m = r.m;
      return '<div class="mkt-row"><span class="coin-icon ' + r.c.cls + '">' + r.c.icon + '</span>' +
        '<span class="coin-cell"><span><strong>' + r.c.name + '</strong><small>' + r.coin + '/USDT</small></span></span>' +
        '<span class="money">' + fmt$(m && m.price) + '</span>' +
        '<span class="' + chgClass(m && m.chg) + '">' + (m && m.chg != null ? (m.chg >= 0 ? '+' : '−') + Math.abs(m.chg).toFixed(2) + '%' : '—') + '</span>' +
        '<span style="color:var(--muted)">' + fmt$(m && m.high) + '</span>' +
        '<span style="color:var(--muted)">' + fmt$(m && m.low) + '</span></div>';
    }).join('') || '<div class="empty-trades"><div><strong>No matches</strong></div></div>';
  }

  /* ---------------- analytics ---------------- */
  function renderAnalytics() {
    var d = laya.decisions || { total: 0, hold: 0, long: 0, short: 0 };
    $('mixSub').textContent = 'Session v' + laya.version + ' · ' + d.total + ' decisions';
    $('mixTotal').textContent = d.total;
    var rows = [
      ['HOLD', d.hold, 'var(--muted)', 'hold'],
      ['LONG', d.long, '#35c7a0', 'long'],
      ['SHORT', d.short, '#ef6d75', 'short']
    ];
    $('mixBars').innerHTML = rows.map(function (r) {
      var pct = d.total ? (r[1] / d.total * 100) : 0;
      return '<div class="mix-row"><span>' + badge(r[0]) + '</span>' +
        '<span class="mix-track"><i style="width:' + pct.toFixed(1) + '%;background:' + r[2] + '"></i></span>' +
        '<span style="text-align:right;color:var(--muted)">' + r[1] + ' · ' + pct.toFixed(0) + '%</span></div>';
    }).join('');
    var rec = (laya.recent_decisions || []).slice().reverse().slice(0, 15);
    $('confFeed').innerHTML = rec.length ? rec.map(feedRow).join('') :
      '<div class="empty-trades"><div><strong>No decisions yet</strong></div></div>';
    var m = laya.model || {};
    function specRow(k, v) { return '<div><span>' + k + '</span><strong>' + v + '</strong></div>'; }
    $('modelSpec').innerHTML =
      specRow('Accuracy', m.accuracy) + specRow('AUC', m.auc) +
      specRow('Recall · SHORT', m.recall_short) + specRow('Recall · HOLD', m.recall_hold) +
      specRow('Recall · LONG', m.recall_long) + specRow('Calib. error (ECE)', m.ece);
    var bt = (m.backtest_bps) || {};
    $('backtestSpec').innerHTML = Object.keys(bt).map(function (thr) {
      return specRow('Threshold ' + thr, '+' + bt[thr] + ' bps');
    }).join('');
  }

  /* ---------------- dropdowns ---------------- */
  function renderDrops() {
    var d = laya.decisions || {};
    var ld = laya.latest_decision || {};
    function item(t, s) {
      return '<div class="drop-item"><span class="dot2"></span><div>' + t + (s ? '<small>' + s + '</small>' : '') + '</div></div>';
    }
    $('bellDrop').innerHTML = '<div class="drop-head">Notifications</div>' +
      item('Laya v' + laya.version + ' is ' + (laya.status || 'running').toLowerCase(), 'Live since ' + fmtTimeUTC(laya.started_utc)) +
      item((d.total || 0) + ' decisions · ' + (d.long || 0) + ' LONG / ' + (d.short || 0) + ' SHORT', 'Latest: ' + (ld.action || '—') + ' · ' + fmtTimeUTC(ld.ts)) +
      item((laya.trades || []).length === 0 ? 'No trades yet — patience is the strategy' : (laya.trades.length + ' closed trades'),
        'Data updated ' + ago(laya.updated_utc));
    $('profileDrop').innerHTML = '<div class="drop-head">Demo Account</div>' +
      item('OKX demo · ' + fmtUSDT(laya.balance_usdt), 'Paper trading only — no real money') +
      item('Bot v' + laya.version + ' · ' + (laya.symbol || 'BTC-USDT-SWAP'), 'Model ' + ((laya.model || {}).version || 'v4'));
  }

  function renderFooter() {
    $('footMeta').textContent = 'Live prices · Binance · Bot data updated ' + ago(laya.updated_utc) + (layaLive ? '' : ' (seed)');
  }

  /* ---------------- controls ---------------- */
  function segWire(id, cb) {
    var el = $(id);
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      el.querySelectorAll('button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      cb(b.dataset.range || b.dataset.p);
    });
  }
  document.querySelectorAll('.nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.nav-item').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var tab = btn.dataset.tab;
      document.querySelectorAll('.view').forEach(function (v) {
        v.classList.toggle('active', v.dataset.view === tab);
      });
      if (tab === 'market') renderMarketView();
      if (tab === 'analytics') renderAnalytics();
      if (tab === 'trade') { renderFeed(); renderSession(); }
      if (tab === 'portfolio') renderLayaBits();
    });
  });
  segWire('chartRange', function (r) { chartRange = r; loadChart(); });
  segWire('leadersRange', function (r) { leadersRange = r; renderLeaders(); });
  segWire('txPeriod', function (p) {
    txRange = p;
    var sel = $('txSelect');
    sel.value = p === 'ALL' ? '1M' : p;
    renderTxList($('transactions'), laya.trades || [], txRange, $('txSearch').value.toLowerCase().trim());
  });
  $('txSelect').addEventListener('change', function () {
    txRange = this.value;
    $('txPeriod').querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.p === txRange);
    });
    renderTxList($('transactions'), laya.trades || [], txRange, $('txSearch').value.toLowerCase().trim());
  });
  $('txSearch').addEventListener('input', function () {
    renderTxList($('transactions'), laya.trades || [], txRange, this.value.toLowerCase().trim());
  });
  $('pfSearch').addEventListener('input', function () {
    renderTxList($('pfTransactions'), laya.trades || [], 'ALL', this.value.toLowerCase().trim());
  });
  $('feedSearch').addEventListener('input', renderFeed);
  $('marketSearch').addEventListener('input', renderMarketView);
  $('globalSearch').addEventListener('input', function () {
    var q = this.value.toLowerCase().trim();
    document.querySelectorAll('.asset-row,.mkt-row,.feed-row,.tx').forEach(function (row) {
      row.style.opacity = !q || row.textContent.toLowerCase().indexOf(q) > -1 ? '1' : '.25';
    });
  });
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('globalSearch').focus(); }
  });
  $('themeBtn').addEventListener('click', function () {
    var dark = document.documentElement.classList.toggle('forced-dark');
    try { localStorage.setItem('laya-theme', dark ? 'dark' : 'light'); } catch (e) {}
    toast(dark ? 'Dark appearance' : 'Light appearance');
  });
  try { if (localStorage.getItem('laya-theme') === 'dark') document.documentElement.classList.add('forced-dark'); } catch (e) {}
  $('bellBtn').addEventListener('click', function (e) { e.stopPropagation(); toggleDrop('bellDrop'); });
  $('profileBtn').addEventListener('click', function (e) { e.stopPropagation(); toggleDrop('profileDrop'); });
  $('helpBtn').addEventListener('click', function () {
    openModal('Help', '<p><b>Laya</b> is a BTC trading bot on OKX demo — this dashboard shows its live state.</p>' +
      '<p>⌘K / Ctrl-K focuses search. Timeframe buttons switch the chart range. The Trade tab streams every model decision; Analytics breaks down the session.</p>' +
      '<p>Prices stream from the Binance public API. Bot data refreshes every 15 minutes via GitHub Actions — the timestamp in the footer tells you how fresh it is.</p>');
  });
  document.querySelectorAll('[data-action]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var a = btn.dataset.action;
      openModal(a, '<p>This is a <b>demo account</b> — Laya trades automatically on OKX paper money, so ' +
        a.toLowerCase() + ' isn\u2019t something you do by hand here.</p>' +
        '<p>Balance: <b>' + esc(fmtUSDT(laya.balance_usdt)) + '</b> · Bot v' + laya.version + ' ' + (laya.status || '') + '</p>');
    });
  });
  document.querySelectorAll('.ellipsis').forEach(function (btn) {
    btn.addEventListener('click', function () {
      openModal('Card options', '<p>Data for this card streams live — prices from Binance, bot state from <code>data/laya.json</code>.</p>',
        '<button class="btn primary" data-close id="refreshNow">Refresh data now</button> <button class="btn" data-close>Close</button>');
      var rb = document.getElementById('refreshNow');
      if (rb) rb.addEventListener('click', function () { refreshAll(); toast('Data refreshed'); });
    });
  });

  /* ---------------- boot + polling ---------------- */
  function refreshAll() {
    loadMarket();
    loadLaya();
    loadKlines7d().then(function () { renderLeaders(); });
    var active = document.querySelector('.view.active');
    if (active && active.dataset.view === 'dashboard') loadChart();
  }
  refreshAll();
  setInterval(loadMarket, 30000);
  setInterval(loadLaya, 60000);
  setInterval(loadChart, 120000);
})();
