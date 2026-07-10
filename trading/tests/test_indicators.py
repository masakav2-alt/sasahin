import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from jptrader.data import Bar
from jptrader.indicators import atr, ema, rsi, sma


class TestSMA(unittest.TestCase):
    def test_basic(self):
        out = sma([1, 2, 3, 4, 5], 3)
        self.assertEqual(out, [None, None, 2.0, 3.0, 4.0])

    def test_short_input(self):
        self.assertEqual(sma([1, 2], 3), [None, None])

    def test_invalid_period(self):
        with self.assertRaises(ValueError):
            sma([1, 2, 3], 0)


class TestEMA(unittest.TestCase):
    def test_seed_is_sma(self):
        out = ema([2, 4, 6, 8], 3)
        self.assertIsNone(out[0])
        self.assertIsNone(out[1])
        self.assertAlmostEqual(out[2], 4.0)  # (2+4+6)/3
        # k = 2/(3+1) = 0.5 → 8*0.5 + 4*0.5 = 6
        self.assertAlmostEqual(out[3], 6.0)

    def test_length(self):
        self.assertEqual(len(ema(list(range(10)), 5)), 10)


class TestRSI(unittest.TestCase):
    def test_all_gains_is_100(self):
        values = list(range(1, 30))
        out = rsi(values, 14)
        self.assertIsNone(out[13])
        self.assertAlmostEqual(out[14], 100.0)
        self.assertAlmostEqual(out[-1], 100.0)

    def test_all_losses_is_0(self):
        values = list(range(30, 1, -1))
        out = rsi(values, 14)
        self.assertAlmostEqual(out[-1], 0.0)

    def test_range(self):
        import random
        rnd = random.Random(42)
        values = [100.0]
        for _ in range(200):
            values.append(values[-1] * (1 + rnd.gauss(0, 0.02)))
        for v in rsi(values, 14):
            if v is not None:
                self.assertGreaterEqual(v, 0.0)
                self.assertLessEqual(v, 100.0)


class TestATR(unittest.TestCase):
    def _bars(self, rows):
        return [Bar("2024-01-{:02d}".format(i + 1), o, h, l, c, 1000)
                for i, (o, h, l, c) in enumerate(rows)]

    def test_constant_range(self):
        # 毎日 high-low=10、ギャップなし → ATR は 10 に一致
        bars = self._bars([(100, 105, 95, 100)] * 20)
        out = atr(bars, 14)
        self.assertIsNone(out[12])
        self.assertAlmostEqual(out[13], 10.0)
        self.assertAlmostEqual(out[-1], 10.0)

    def test_short_input(self):
        bars = self._bars([(100, 105, 95, 100)] * 5)
        self.assertEqual(atr(bars, 14), [None] * 5)


if __name__ == "__main__":
    unittest.main()
