"""ペーパートレード（仮想口座）の状態管理と日次運用ステップ。

状態は JSON ファイルに永続化する。1日1回 `step` を実行する運用を想定:
  1. 最新の日足データを取得
  2. 保有銘柄のストップロス判定・手仕舞いシグナル判定
  3. 新規エントリーシグナル判定
  4. 直近終値で仮想約定し、状態を保存

実際の発注は行わない。約定は「直近終値±スリッページ」の仮定。
"""

import json
import os
from datetime import datetime

from .backtest import BTConfig, size_position
from .indicators import atr as atr_series
from .strategy import BUY, SELL

DEFAULT_STATE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "state", "portfolio.json")


def new_state(capital):
    return {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "initial_capital": capital,
        "cash": capital,
        "positions": {},        # code -> {shares, entry_price, entry_date, stop}
        "trades": [],           # 決済済みトレード
        "equity_history": [],   # [date, equity]
        "last_run": None,
    }


def load_state(path=None, capital=3_000_000.0):
    path = path or DEFAULT_STATE_PATH
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return new_state(capital)


def save_state(state, path=None):
    path = path or DEFAULT_STATE_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def equity_of(state, prices):
    """現金＋保有評価額。prices: dict[code, 直近終値]。"""
    total = state["cash"]
    for code, pos in state["positions"].items():
        total += pos["shares"] * prices.get(code, pos["entry_price"])
    return total


def step(state, data, strategy, cfg=None):
    """日次運用ステップを1回実行し、実行したアクションのリストを返す。

    data: dict[code, list[Bar]]。各銘柄の最新バーの引け時点で判定・約定する。
    同じ日付で二重実行しても売買が重複しないよう、last_run と各バーの
    日付を突き合わせる。
    """
    cfg = cfg or BTConfig()
    actions = []
    prices = {c: bars[-1].close for c, bars in data.items() if bars}
    latest_date = max((bars[-1].date for bars in data.values() if bars), default=None)
    if latest_date is None:
        return actions
    if state.get("last_run") == latest_date:
        actions.append({"type": "skip", "detail": "既に {} 分は実行済み".format(latest_date)})
        return actions

    positions = state["positions"]

    def close_position(code, price, reason):
        pos = positions.pop(code)
        exec_price = price * (1 - cfg.slippage)
        proceeds = pos["shares"] * exec_price * (1 - cfg.commission)
        state["cash"] += proceeds
        pnl = (exec_price - pos["entry_price"]) * pos["shares"]
        trade = {
            "code": code, "shares": pos["shares"],
            "entry_date": pos["entry_date"], "entry_price": pos["entry_price"],
            "exit_date": latest_date, "exit_price": round(exec_price, 2),
            "pnl": round(pnl, 0), "reason": reason,
        }
        state["trades"].append(trade)
        actions.append({"type": "sell", **trade})

    # --- 1. 保有銘柄: ストップロス → 手仕舞いシグナル → トレーリング ---
    for code in list(positions.keys()):
        bars = data.get(code)
        if not bars:
            continue
        pos = positions[code]
        last = bars[-1]
        if last.low <= pos["stop"]:
            close_position(code, min(last.close, pos["stop"]), "stop")
            continue
        ctx = strategy.prepare(bars)
        i = len(bars) - 1
        if i >= strategy.warmup and strategy.signal(ctx, bars, i) == SELL:
            close_position(code, last.close, "signal")
            continue
        if cfg.trailing_stop:
            a = atr_series(bars, cfg.atr_period)[-1]
            if a:
                new_stop = last.close - cfg.atr_mult * a
                if new_stop > pos["stop"]:
                    pos["stop"] = round(new_stop, 2)
                    actions.append({"type": "trail", "code": code,
                                    "stop": pos["stop"]})

    # --- 2. 新規エントリー ---
    equity = equity_of(state, prices)
    for code, bars in sorted(data.items()):
        if code in positions or len(positions) >= cfg.max_positions:
            continue
        i = len(bars) - 1
        if i < strategy.warmup:
            continue
        ctx = strategy.prepare(bars)
        if strategy.signal(ctx, bars, i) != BUY:
            continue
        a = atr_series(bars, cfg.atr_period)[-1]
        price = bars[-1].close * (1 + cfg.slippage)
        shares = size_position(equity, bars[-1].close, a, cfg)
        while shares > 0 and shares * price * (1 + cfg.commission) > state["cash"]:
            shares -= cfg.unit
        if shares <= 0:
            continue
        cost = shares * price * (1 + cfg.commission)
        state["cash"] -= cost
        stop = price - cfg.atr_mult * a
        positions[code] = {
            "shares": shares,
            "entry_price": round(price, 2),
            "entry_date": latest_date,
            "stop": round(stop, 2),
        }
        actions.append({"type": "buy", "code": code, "shares": shares,
                        "price": round(price, 2), "stop": round(stop, 2)})

    # --- 3. 記録 ---
    state["last_run"] = latest_date
    state["equity_history"].append([latest_date, round(equity_of(state, prices), 0)])
    return actions
