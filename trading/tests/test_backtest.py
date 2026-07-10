import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from jptrader.backtest import Backtester, BTConfig, size_position
from jptrader.data import Bar, synthetic_bars
from jptrader.strategy import MACross

FIXED_END = date(2026, 6, 30)


def make_cfg(**kw):
    base = dict(initial_capital=3_000_000.0)
    base.update(kw)
    return BTConfig(**base)


class TestSizePosition(unittest.TestCase):
    def test_risk_based_size(self):
        cfg = make_cfg(risk_per_trade=0.01, atr_mult=2.0, unit=100,
                       max_weight=1.0)
        # リスク許容 30,000円 / ストップ幅 100円 = 300株
        self.assertEqual(size_position(3_000_000, 500, 50, cfg), 300)

    def test_max_weight_cap(self):
        cfg = make_cfg(risk_per_trade=0.5, atr_mult=1.0, unit=100,
                       max_weight=0.1)
        # 資産の10% = 30万円 / 株価3000円 = 100株が上限
        self.assertEqual(size_position(3_000_000, 3000, 10, cfg), 100)

    def test_zero_atr(self):
        cfg = make_cfg()
        self.assertEqual(size_position(3_000_000, 500, 0, cfg), 0)
        self.assertEqual(size_position(3_000_000, 500, None, cfg), 0)


class TestBacktester(unittest.TestCase):
    def _synthetic_data(self, codes, days=600):
        return {c: synthetic_bars(c, days=days, end=FIXED_END) for c in codes}

    def test_runs_and_is_deterministic(self):
        data = self._synthetic_data(["7203", "6758", "9984", "8035"])
        cfg = make_cfg()
        strat = MACross(fast=10, slow=30, trend=0)
        r1 = Backtester(strat, data, cfg).run()
        r2 = Backtester(MACross(fast=10, slow=30, trend=0), data, cfg).run()
        self.assertEqual(len(r1.equity_curve), len(r2.equity_curve))
        self.assertEqual(r1.equity_curve[-1], r2.equity_curve[-1])
        self.assertEqual(len(r1.trades), len(r2.trades))
        self.assertGreater(len(r1.equity_curve), 0)

    def test_equity_consistency(self):
        # 最終資産 = 現金 + 保有評価額（終値ベース）
        data = self._synthetic_data(["7203", "6758", "9984"])
        cfg = make_cfg()
        result = Backtester(MACross(fast=10, slow=30, trend=0), data, cfg).run()
        last_closes = {c: bars[-1].close for c, bars in data.items()}
        expected = result.final_cash + sum(
            p.shares * last_closes[c] for c, p in result.open_positions.items())
        self.assertAlmostEqual(result.equity_curve[-1][1], expected, places=4)

    def test_shares_are_unit_multiples(self):
        data = self._synthetic_data(["7203", "6758", "9984", "8035", "6501"])
        result = Backtester(MACross(fast=10, slow=30, trend=0), data,
                            make_cfg()).run()
        for t in result.trades:
            self.assertEqual(t.shares % 100, 0)
            self.assertGreater(t.shares, 0)

    def test_stop_loss_triggers_on_crash(self):
        # 上昇トレンド後に暴落する銘柄でストップロスが発動すること
        bars = []
        price = 1000.0
        d = date(2024, 1, 1)
        from datetime import timedelta
        for i in range(120):
            while d.weekday() >= 5:
                d += timedelta(days=1)
            if i < 30:
                price *= 0.997  # 下落（クロスの前提を作る）
            elif i < 100:
                price *= 1.01   # 上昇 → ゴールデンクロスで買い
            else:
                price *= 0.90   # 暴落 → ストップロス発動
            bars.append(Bar(d.isoformat(), price, price * 1.01,
                            price * 0.985, price, 10000))
            d += timedelta(days=1)
        cfg = make_cfg(trailing_stop=True)
        result = Backtester(MACross(fast=5, slow=20, trend=0),
                            {"9999": bars}, cfg).run()
        reasons = {t.reason for t in result.trades}
        self.assertIn("stop", reasons)
        # 暴落後に建玉が残っていない
        self.assertEqual(result.open_positions, {})

    def test_max_positions_respected(self):
        codes = ["7203", "6758", "9984", "8035", "6501", "8058", "9432",
                 "4063", "6861", "7974"]
        data = self._synthetic_data(codes)
        cfg = make_cfg(max_positions=3)
        strat = MACross(fast=5, slow=15, trend=0)
        bt = Backtester(strat, data, cfg)
        result = bt.run()
        # どの時点でも保有は3銘柄以下（終了時点で確認）
        self.assertLessEqual(len(result.open_positions), 3)

    def test_metrics_present(self):
        data = self._synthetic_data(["7203", "6758"])
        result = Backtester(MACross(fast=10, slow=30, trend=0), data,
                            make_cfg()).run()
        m = result.metrics
        for key in ("total_return", "cagr", "max_drawdown", "sharpe",
                    "num_trades"):
            self.assertIn(key, m)
        self.assertGreaterEqual(m["max_drawdown"], 0.0)
        self.assertLessEqual(m["max_drawdown"], 1.0)

    def test_cash_never_negative(self):
        data = self._synthetic_data(["7203", "6758", "9984", "8035", "6501"])
        cfg = make_cfg(initial_capital=500_000.0)  # 少額でも破綻しない
        result = Backtester(MACross(fast=5, slow=15, trend=0), data, cfg).run()
        self.assertGreaterEqual(result.final_cash, 0.0)


if __name__ == "__main__":
    unittest.main()
