import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from jptrader.data import Bar
from jptrader.strategy import (BUY, SELL, MACross, RsiMeanReversion,
                               make_strategy)


def bars_from_closes(closes):
    return [Bar("2020-01-{:02d}".format(i % 28 + 1), c, c * 1.01, c * 0.99, c, 1000)
            for i, c in enumerate(closes)]


class TestMACross(unittest.TestCase):
    def test_golden_cross_emits_buy(self):
        # 下降→急上昇でゴールデンクロスを作る（トレンドフィルタ無効）
        closes = [100 - i * 0.1 for i in range(60)]
        closes += [95 + i * 1.5 for i in range(60)]
        bars = bars_from_closes(closes)
        strat = MACross(fast=5, slow=20, trend=0)
        ctx = strat.prepare(bars)
        signals = [strat.signal(ctx, bars, i) for i in range(len(bars))]
        self.assertIn(BUY, signals)

    def test_dead_cross_emits_sell(self):
        closes = [100 + i * 1.5 for i in range(60)]
        closes += [190 - i * 2.0 for i in range(60)]
        bars = bars_from_closes(closes)
        strat = MACross(fast=5, slow=20, trend=0)
        ctx = strat.prepare(bars)
        signals = [strat.signal(ctx, bars, i) for i in range(len(bars))]
        self.assertIn(SELL, signals)

    def test_trend_filter_blocks_buy_in_downtrend(self):
        # 長期下落中の一時的な反発クロスは、200日フィルタで棄却される
        closes = [300 - i * 0.5 for i in range(250)]
        closes += [175 + i * 0.8 for i in range(30)]
        bars = bars_from_closes(closes)
        strat = MACross(fast=5, slow=20, trend=200)
        ctx = strat.prepare(bars)
        signals = [strat.signal(ctx, bars, i) for i in range(len(bars))]
        self.assertNotIn(BUY, signals)

    def test_invalid_params(self):
        with self.assertRaises(ValueError):
            MACross(fast=50, slow=20)


class TestRsiMeanReversion(unittest.TestCase):
    def test_oversold_in_uptrend_emits_buy(self):
        # 長期上昇の後に急落 → RSI 低下、ただし 200日線より上
        closes = [100 + i * 1.0 for i in range(250)]
        closes += [closes[-1] - i * 3.0 for i in range(10)]
        bars = bars_from_closes(closes)
        strat = RsiMeanReversion(period=14, buy_th=35, sell_th=60, trend=200)
        ctx = strat.prepare(bars)
        self.assertEqual(strat.signal(ctx, bars, len(bars) - 1), BUY)

    def test_overbought_emits_sell(self):
        closes = [100.0] * 200 + [100 + i * 2.0 for i in range(20)]
        bars = bars_from_closes(closes)
        strat = RsiMeanReversion(period=14, buy_th=30, sell_th=60, trend=0)
        ctx = strat.prepare(bars)
        self.assertEqual(strat.signal(ctx, bars, len(bars) - 1), SELL)


class TestFactory(unittest.TestCase):
    def test_make_with_params(self):
        s = make_strategy("ma_cross", fast=10, slow=30, trend=0)
        self.assertEqual(s.fast, 10)
        self.assertEqual(s.slow, 30)

    def test_unknown_name(self):
        with self.assertRaises(ValueError):
            make_strategy("nope")


if __name__ == "__main__":
    unittest.main()
