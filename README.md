# Laya — BTC Trading Dashboard

The live command center for **Laya**, an autonomous trading bot running on an
**OKX demo account** (paper money, real market data). Every number on this
dashboard is real: market data streams from public exchange APIs, and the
bot's decisions/trades come straight from its own run logs. Nothing is mocked.

## What it shows

- **Dashboard** — live BTC price + chart (12H → 1Y), market leaders, top
  assets, trade history, demo balance
- **Trade** — Laya's live decision feed (every LONG / HOLD / SHORT with
  confidence), strategy explainer, session info
- **Market** — live spot prices, 24h change/high/low for 8 majors
- **Analytics** — decision mix, confidence stream, model card (v4 metrics),
  fee-aware backtest
- **Portfolio** — balance, realized P&L, full closed-trade history
- **OTC / About** — what Laya is, how the data pipeline works

## How the data flows

```
OKX demo (1m BTC candles)
   -> fine-tuned decision model (Kaggle notebook, self-perpetuating versions)
   -> decisions.jsonl run log
   -> GitHub Actions, every 15 min (scripts/sync_laya.py)
   -> data/laya.json (committed to this repo)
   -> this dashboard (GitHub Pages) + Binance/Coinbase public APIs in-browser
```

No server. No cost. The whole loop runs on free tiers.

## Run it locally

```bash
python3 -m http.server 8000   # must be served over http, not file://
# open http://localhost:8000
```

## Host it yourself

1. Create a GitHub repo and push this project.
2. Add two repository secrets (Settings → Secrets → Actions):
   `KAGGLE_USERNAME` and `KAGGLE_KEY` (from kaggle.com/settings/account → API).
   These let the sync job read *your own* private notebook output. They are
   never exposed to the site or committed.
3. Settings → Pages → Deploy from branch → `main` / root.
4. The `laya-sync` workflow runs every 15 minutes from then on.

To point it at your own bot, change `--kernel` in
`.github/workflows/laya-sync.yml` and the model card in `data/laya.json`.

## Data honesty

- Prices/charts: Binance public API, with Coinbase fallback for
  geo-blocked regions. If both are unreachable the page keeps the last
  values and says so.
- Bot state: `data/laya.json`, rebuilt from the run log. The footer shows
  exactly how stale it is. Trades are reconstructed from exchange fills —
  never hand-written.
- This is a **demo account**. No real money is traded, managed, or
  solicited. Not financial advice.

## License

MIT — see [LICENSE](LICENSE).
