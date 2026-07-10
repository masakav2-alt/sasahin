import os
import sys
import tempfile
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from jptrader.data import (Bar, _parse_ohlcv_csv, filter_bars, load_cache,
                           save_cache, synthetic_bars)

FIXED_END = date(2026, 6, 30)


class TestSynthetic(unittest.TestCase):
    def test_deterministic(self):
        a = synthetic_bars("7203", days=200, end=FIXED_END)
        b = synthetic_bars("7203", days=200, end=FIXED_END)
        self.assertEqual(a, b)

    def test_different_codes_differ(self):
        a = synthetic_bars("7203", days=200, end=FIXED_END)
        b = synthetic_bars("6758", days=200, end=FIXED_END)
        self.assertNotEqual(a, b)

    def test_ohlc_sanity(self):
        for b in synthetic_bars("9984", days=300, end=FIXED_END):
            self.assertGreaterEqual(b.high, max(b.open, b.close) - 1e-6)
            self.assertLessEqual(b.low, min(b.open, b.close) + 1e-6)
            self.assertGreater(b.low, 0)

    def test_dates_are_weekdays_ascending(self):
        bars = synthetic_bars("7203", days=100, end=FIXED_END)
        dates = [b.date for b in bars]
        self.assertEqual(dates, sorted(dates))
        for d in dates:
            self.assertLess(date.fromisoformat(d).weekday(), 5)


class TestCsvAndCache(unittest.TestCase):
    def test_parse_csv(self):
        text = ("Date,Open,High,Low,Close,Volume\n"
                "2026-01-06,100,110,90,105,12345\n"
                "2026-01-05,99,101,98,100,999\n"
                "bad,row,,,,\n")
        bars = _parse_ohlcv_csv(text)
        self.assertEqual(len(bars), 2)
        self.assertEqual(bars[0].date, "2026-01-05")  # ソートされる
        self.assertEqual(bars[1].volume, 12345)

    def test_cache_round_trip(self):
        bars = synthetic_bars("7203", days=50, end=FIXED_END)
        with tempfile.TemporaryDirectory() as td:
            save_cache("7203", bars, data_dir=td)
            loaded = load_cache("7203", data_dir=td)
        self.assertEqual(len(loaded), 50)
        self.assertEqual(loaded[0].date, bars[0].date)
        self.assertAlmostEqual(loaded[-1].close, bars[-1].close)

    def test_load_missing_returns_none(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertIsNone(load_cache("0000", data_dir=td))


class TestFilter(unittest.TestCase):
    def test_filter_range(self):
        bars = [Bar("2026-01-0{}".format(i), 1, 1, 1, 1, 1) for i in range(1, 8)]
        out = filter_bars(bars, start="2026-01-03", end="2026-01-05")
        self.assertEqual([b.date for b in out],
                         ["2026-01-03", "2026-01-04", "2026-01-05"])


if __name__ == "__main__":
    unittest.main()
