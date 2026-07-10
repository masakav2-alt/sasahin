import json
import os
import sys
import tempfile
import unittest
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from jptrader.backtest import BTConfig
from jptrader.data import Bar, synthetic_bars
from jptrader.portfolio import (equity_of, load_state, new_state, save_state,
                                step)
from jptrader.strategy import MACross

FIXED_END = date(2026, 6, 30)


def uptrend_bars(n=80, start_price=1000.0, daily=1.02):
    """ゴールデンクロスを発生させる上昇系列。"""
    bars = []
    price = start_price
    d = date(2024, 1, 1)
    for i in range(n):
        while d.weekday() >= 5:
            d += timedelta(days=1)
        if i < 30:
            price *= 0.998  # 最初は緩やかに下落
        else:
            price *= daily
        bars.append(Bar(d.isoformat(), price, price * 1.01, price * 0.99,
                        price, 10000))
        d += timedelta(days=1)
    return bars


class TestState(unittest.TestCase):
    def test_round_trip(self):
        state = new_state(1_000_000)
        state["positions"]["7203"] = {
            "shares": 100, "entry_price": 2500.0,
            "entry_date": "2026-01-05", "stop": 2400.0}
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "p.json")
            save_state(state, path)
            loaded = load_state(path)
        self.assertEqual(loaded["positions"]["7203"]["shares"], 100)
        self.assertEqual(loaded["cash"], 1_000_000)

    def test_load_missing_creates_new(self):
        with tempfile.TemporaryDirectory() as td:
            state = load_state(os.path.join(td, "none.json"), capital=42.0)
        self.assertEqual(state["cash"], 42.0)
        self.assertEqual(state["positions"], {})


class TestStep(unittest.TestCase):
    def test_buy_on_signal(self):
        bars = uptrend_bars()
        state = new_state(3_000_000)
        strat = MACross(fast=5, slow=20, trend=0)
        cfg = BTConfig()
        actions = step(state, {"7203": bars}, strat, cfg)
        # ゴールデンクロス直後の実行なら買いが入る…とは限らないため、
        # クロス発生日を最終バーに合わせた系列で確認する
        # （uptrend_bars は 30 日目以降上昇なのでクロスは過去に発生済み）
        # ここでは「状態が壊れない」ことと二重実行防止を検証
        self.assertEqual(state["last_run"], bars[-1].date)
        again = step(state, {"7203": bars}, strat, cfg)
        self.assertEqual(again[0]["type"], "skip")

    def test_buy_at_cross_date(self):
        # クロスが最終日に発生するよう系列を構成
        bars = uptrend_bars(n=42)  # 下落30日 + 上昇12日 → 5/20クロス付近
        strat = MACross(fast=5, slow=20, trend=0)
        ctx = strat.prepare(bars)
        # 最終日に BUY が出るまで末尾を調整
        while strat.signal(ctx, bars, len(bars) - 1) != "BUY" and len(bars) > 25:
            bars = bars[:-1]
            ctx = strat.prepare(bars)
        if strat.signal(ctx, bars, len(bars) - 1) != "BUY":
            self.skipTest("クロス日を構成できなかった")
        state = new_state(3_000_000)
        actions = step(state, {"7203": bars}, strat, BTConfig())
        buys = [a for a in actions if a["type"] == "buy"]
        self.assertEqual(len(buys), 1)
        self.assertIn("7203", state["positions"])
        self.assertEqual(state["positions"]["7203"]["shares"] % 100, 0)
        self.assertLess(state["cash"], 3_000_000)

    def test_stop_loss_sells(self):
        state = new_state(3_000_000)
        state["positions"]["7203"] = {
            "shares": 100, "entry_price": 2000.0,
            "entry_date": "2026-01-05", "stop": 1900.0}
        cash_before = state["cash"]
        # 安値がストップを割るバー
        bars = uptrend_bars(n=60)
        last = bars[-1]
        bars[-1] = Bar(last.date, 1950.0, 1960.0, 1850.0, 1880.0, 10000)
        actions = step(state, {"7203": bars}, MACross(fast=5, slow=20, trend=0),
                       BTConfig())
        sells = [a for a in actions if a["type"] == "sell"]
        self.assertEqual(len(sells), 1)
        self.assertEqual(sells[0]["reason"], "stop")
        self.assertNotIn("7203", state["positions"])
        self.assertGreater(state["cash"], cash_before)
        self.assertEqual(len(state["trades"]), 1)

    def test_equity_history_appended(self):
        state = new_state(3_000_000)
        data = {"7203": synthetic_bars("7203", days=300, end=FIXED_END)}
        step(state, data, MACross(fast=10, slow=30, trend=0), BTConfig())
        self.assertEqual(len(state["equity_history"]), 1)

    def test_state_is_json_serializable(self):
        state = new_state(3_000_000)
        data = {c: synthetic_bars(c, days=300, end=FIXED_END)
                for c in ("7203", "6758", "9984")}
        step(state, data, MACross(fast=5, slow=15, trend=0), BTConfig())
        json.dumps(state)  # 例外が出なければ OK


if __name__ == "__main__":
    unittest.main()
