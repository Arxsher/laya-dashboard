#!/usr/bin/env python3
"""Rebuild data/laya.json from the Laya Kaggle kernel output.

Runs in GitHub Actions every 15 minutes. It:
  1. downloads the latest kernel output (decisions.jsonl) via the Kaggle API
  2. counts decisions, extracts the latest + recent ones
  3. reconstructs closed trades + open position from OKX fills
  4. fetches the live BTC price (Binance) for unrealized P&L
  5. writes data/laya.json

Design rules:
  - Never invent data. If the kernel output is missing/unparseable, the
    previous data/laya.json is kept untouched (staleness is visible via
    `updated_utc` on the dashboard).
  - Never fails the workflow: any unexpected error -> warn, keep old file,
    exit 0.
  - No secrets in output. Only aggregate stats are written.
"""
import json
import re
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

CTVAL = {"BTC-USDT-SWAP": 0.01}  # BTC per contract


def log(msg):
    print(f"[sync] {msg}", flush=True)


def run(cmd, timeout=300):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except Exception as e:  # noqa: BLE001
        return 1, "", str(e)


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def to_iso(ts):
    """Normalize the various ts shapes we may see to an ISO UTC string."""
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        # OKX fill ts is epoch millis
        v = ts / 1000 if ts > 1e12 else ts
        return datetime.fromtimestamp(v, timezone.utc).isoformat(timespec="seconds")
    s = str(ts)
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d.astimezone(timezone.utc).isoformat(timespec="seconds")
    except ValueError:
        return None


def btc_spot():
    urls = [
        "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
        "https://api.coinbase.com/v2/prices/BTC-USD/spot",
    ]
    for u in urls:
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "laya-dashboard-sync/1.0"})
            with urllib.request.urlopen(req, timeout=20) as r:
                j = json.loads(r.read().decode())
            if "price" in j:
                return float(j["price"])
            if "data" in j and "amount" in j["data"]:
                return float(j["data"]["amount"])
        except Exception as e:  # noqa: BLE001
            log(f"spot fetch failed ({u}): {e}")
    return None


def parse_events(path):
    events = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return events


def reconstruct_trades(fills, symbol):
    """Pair fills into closed round-trip trades. Returns (trades, open_position)."""
    ctval = CTVAL.get(symbol, 0.01)
    fills = sorted(fills, key=lambda f: f.get("ts") or 0)
    trades = []
    pos = 0.0
    avg_entry = 0.0
    trade = None

    def new_trade(side, opened):
        return {"side": side, "opened_utc": opened, "entry_qty": 0.0,
                "entry_val": 0.0, "exit_qty": 0.0, "exit_val": 0.0,
                "realized": 0.0}

    for f in fills:
        try:
            px = float(f["fillPx"])
            sz = float(f["fillSz"])
        except (TypeError, ValueError):
            continue
        if sz <= 0 or px <= 0:
            continue
        sq = sz if f.get("side") == "buy" else -sz
        fee = float(f.get("fee") or 0) if f.get("feeCcy") == "USDT" else 0.0
        ts_iso = to_iso(f.get("ts"))

        if abs(pos) < 1e-9:
            pos = sq
            avg_entry = px
            trade = new_trade("LONG" if sq > 0 else "SHORT", ts_iso)
            trade["entry_qty"] += abs(sq)
            trade["entry_val"] += px * abs(sq)
            trade["realized"] -= fee
        elif (sq > 0) == (pos > 0):
            new_pos = pos + sq
            avg_entry = (avg_entry * abs(pos) + px * abs(sq)) / abs(new_pos)
            pos = new_pos
            trade["entry_qty"] += abs(sq)
            trade["entry_val"] += px * abs(sq)
            trade["realized"] -= fee
        else:
            close_qty = min(abs(pos), abs(sq))
            direction = 1 if pos > 0 else -1
            trade["realized"] += (px - avg_entry) * direction * close_qty * ctval
            trade["realized"] -= fee
            trade["exit_qty"] += close_qty
            trade["exit_val"] += px * close_qty
            pos = pos - direction * close_qty
            rem = abs(sq) - close_qty
            if abs(pos) < 1e-9:
                pos = 0.0
                trade["closed_utc"] = ts_iso
                trade["entry_px"] = round(trade["entry_val"] / trade["entry_qty"], 2)
                trade["exit_px"] = round(trade["exit_val"] / trade["exit_qty"], 2)
                trade["qty_contracts"] = round(trade["entry_qty"], 2)
                trade["pnl_usdt"] = round(trade["realized"], 2)
                del trade["entry_val"], trade["exit_val"], trade["realized"]
                del trade["entry_qty"], trade["exit_qty"]
                trades.append(trade)
                trade = None
            if rem > 1e-9:
                rsq = rem if sq > 0 else -rem
                pos = rsq
                avg_entry = px
                trade = new_trade("LONG" if rsq > 0 else "SHORT", ts_iso)
                trade["entry_qty"] = rem
                trade["entry_val"] = px * rem

    open_position = None
    if abs(pos) > 1e-9 and trade is not None:
        open_position = {
            "side": trade["side"],
            "entry_px": round(avg_entry, 2),
            "contracts": round(abs(pos), 2),
            "opened_utc": trade["opened_utc"],
        }
    return trades, open_position


def kernel_status(kernel):
    rc, out, _ = run(["kaggle", "kernels", "status", "-k", kernel], timeout=120)
    if rc != 0:
        return None, None
    status = None
    version = None
    m = re.search(r"\b(running|complete|error|queued|failed)\b", out, re.I)
    if m:
        status = m.group(1).upper()
    m = re.search(r"[Vv]ersion\D*(\d+)", out)
    if m:
        version = int(m.group(1))
    return status, version


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--kernel", default="arxsher/laya-demo-trader")
    ap.add_argument("--prev", default="data/laya.json")
    ap.add_argument("--out", default="data/laya.json")
    ap.add_argument("--self-test", action="store_true",
                    help="parse a local decisions.jsonl given via --input instead of Kaggle")
    ap.add_argument("--input", default=None)
    args = ap.parse_args()

    prev_path = Path(args.prev)
    try:
        prev = json.loads(prev_path.read_text()) if prev_path.exists() else {}
    except Exception:  # noqa: BLE001
        prev = {}

    events = []
    status, version = None, None
    if args.self_test and args.input:
        events = parse_events(args.input)
    else:
        with tempfile.TemporaryDirectory() as tmp:
            rc, out, err = run(
                ["kaggle", "kernels", "output", "-k", args.kernel, "-p", tmp],
                timeout=300)
            if rc != 0:
                log(f"kaggle kernels output failed (rc={rc}): {err.strip()[:300]}")
                log("keeping previous data file")
                return 0
            found = list(Path(tmp).rglob("decisions.jsonl"))
            if not found:
                log("decisions.jsonl not in kernel output; keeping previous data file")
                return 0
            events = parse_events(found[0])
            log(f"parsed {len(events)} log lines")
        status, version = kernel_status(args.kernel)
        log(f"kernel status={status} version={version}")

    if not events:
        log("no events parsed; keeping previous data file")
        return 0

    # --- decisions ---
    decided = [e for e in events if e.get("action") in ("HOLD", "LONG", "SHORT")]
    counts = {"total": len(decided),
              "hold": sum(1 for e in decided if e["action"] == "HOLD"),
              "long": sum(1 for e in decided if e["action"] == "LONG"),
              "short": sum(1 for e in decided if e["action"] == "SHORT")}
    latest = decided[-1] if decided else {}
    recent = [
        {"ts": to_iso(e.get("ts")), "action": e.get("action"),
         "confidence": e.get("confidence"), "reason": e.get("reason")}
        for e in decided[-50:]
    ]

    # --- trades from fills ---
    fills = []
    for e in events:
        for f in e.get("fills") or []:
            fills.append(f)
    symbol = (decided[0].get("symbol") if decided else prev.get("symbol")) or "BTC-USDT-SWAP"
    trades, open_position = reconstruct_trades(fills, symbol)
    realized = round(sum(t["pnl_usdt"] for t in trades), 2)

    # cross-check against the bot's own close_pnl_usd events
    bot_closes = [e for e in events if e.get("close_pnl_usd") is not None]
    if bot_closes and abs(len(bot_closes) - len(trades)) > 0:
        log(f"note: bot logged {len(bot_closes)} closes, reconstructed {len(trades)} trades")

    spot = btc_spot()
    if open_position and spot:
        direction = 1 if open_position["side"] == "LONG" else -1
        open_position["unrealized_usdt"] = round(
            (spot - open_position["entry_px"]) * direction
            * open_position["contracts"] * CTVAL.get(symbol, 0.01), 2)
        open_position["mark_px"] = round(spot, 2)

    start_balance = float(prev.get("start_balance_usdt", 5000.0))
    data = {
        "bot": "laya",
        "symbol": symbol,
        "version": version or prev.get("version", 6),
        "status": status or prev.get("status", "RUNNING"),
        "started_utc": to_iso(decided[0].get("ts")) if decided else prev.get("started_utc"),
        "timeframe": prev.get("timeframe", "1m"),
        "notional_usd": prev.get("notional_usd", 50),
        "balance_usdt": round(start_balance + realized, 2),
        "start_balance_usdt": start_balance,
        "realized_pnl_usdt": realized,
        "open_position": open_position,
        "decisions": counts,
        "latest_decision": {
            "ts": to_iso(latest.get("ts")),
            "action": latest.get("action"),
            "confidence": latest.get("confidence"),
            "reason": latest.get("reason"),
        },
        "recent_decisions": recent,
        "trades": [
            {"side": t["side"], "entry_px": t["entry_px"], "exit_px": t["exit_px"],
             "qty_contracts": t["qty_contracts"], "pnl_usdt": t["pnl_usdt"],
             "opened_utc": t["opened_utc"], "closed_utc": t["closed_utc"]}
            for t in trades
        ],
        "model": prev.get("model", {}),
        "updated_utc": iso_now(),
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    before = out_path.read_text() if out_path.exists() else ""
    after = json.dumps(data, indent=2) + "\n"
    if after != before:
        out_path.write_text(after)
        log(f"wrote {args.out}: {counts['total']} decisions, {len(trades)} trades, "
            f"realized ${realized:.2f}")
    else:
        log("no changes; file left untouched")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        log(f"UNEXPECTED ERROR (keeping previous file): {e!r}")
        sys.exit(0)
