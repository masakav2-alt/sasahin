"""株価データの取得・キャッシュ・合成データ生成。

データソース:
  1. stooq.com の日足 CSV（無認証・無料）
  2. Yahoo Finance chart API（フォールバック）

ネットワークが使えない環境では ``offline=True`` で決定論的な合成データを
生成できる（バックテストエンジンの検証・デモ用。実運用判断には使わない）。
"""

import csv
import json
import math
import os
import random
import urllib.error
import urllib.request
import zlib
from collections import namedtuple
from datetime import date, timedelta

Bar = namedtuple("Bar", ["date", "open", "high", "low", "close", "volume"])

_UA = "Mozilla/5.0 (compatible; jptrader/0.1)"
_TIMEOUT = 30

DEFAULT_DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


class DataFetchError(Exception):
    """株価データ取得の失敗。"""


def _http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return resp.read().decode("utf-8", errors="replace")


def fetch_stooq(code):
    """stooq から日足を取得する。code は 4桁の証券コード（例 "7203"）。"""
    url = "https://stooq.com/q/d/l/?s={}.jp&i=d".format(code.lower())
    text = _http_get(url)
    bars = _parse_ohlcv_csv(text)
    if not bars:
        raise DataFetchError("stooq returned no data for {}".format(code))
    return bars


def fetch_yahoo(code):
    """Yahoo Finance chart API から日足を取得する（フォールバック）。"""
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/{}.T"
           "?range=10y&interval=1d").format(code)
    payload = json.loads(_http_get(url))
    try:
        result = payload["chart"]["result"][0]
        ts = result["timestamp"]
        q = result["indicators"]["quote"][0]
    except (KeyError, IndexError, TypeError):
        raise DataFetchError("yahoo returned unexpected payload for {}".format(code))
    bars = []
    for i, t in enumerate(ts):
        o, h, l, c, v = (q["open"][i], q["high"][i], q["low"][i],
                         q["close"][i], q["volume"][i])
        if None in (o, h, l, c):
            continue
        d = date.fromtimestamp(t).isoformat()
        bars.append(Bar(d, float(o), float(h), float(l), float(c), int(v or 0)))
    if not bars:
        raise DataFetchError("yahoo returned no data for {}".format(code))
    return bars


def _parse_ohlcv_csv(text):
    """Date,Open,High,Low,Close,Volume 形式の CSV をパースする。"""
    bars = []
    reader = csv.DictReader(text.splitlines())
    for row in reader:
        try:
            bars.append(Bar(
                row["Date"],
                float(row["Open"]), float(row["High"]),
                float(row["Low"]), float(row["Close"]),
                int(float(row.get("Volume") or 0)),
            ))
        except (KeyError, ValueError, TypeError):
            continue
    bars.sort(key=lambda b: b.date)
    return bars


def cache_path(code, data_dir=None):
    return os.path.join(data_dir or DEFAULT_DATA_DIR, "{}.csv".format(code))


def save_cache(code, bars, data_dir=None):
    path = cache_path(code, data_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date", "Open", "High", "Low", "Close", "Volume"])
        for b in bars:
            w.writerow([b.date, b.open, b.high, b.low, b.close, b.volume])


def load_cache(code, data_dir=None):
    path = cache_path(code, data_dir)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        bars = _parse_ohlcv_csv(f.read())
    return bars or None


def fetch(code):
    """stooq → Yahoo の順で取得を試みる。"""
    errors = []
    for fn in (fetch_stooq, fetch_yahoo):
        try:
            return fn(code)
        except (DataFetchError, urllib.error.URLError, OSError, ValueError) as e:
            errors.append("{}: {}".format(fn.__name__, e))
    raise DataFetchError(
        "全データソースの取得に失敗 ({}): {}".format(code, " / ".join(errors)))


def get_bars(code, offline=False, refresh=False, data_dir=None,
             synthetic_days=1500, synthetic_end=None):
    """銘柄の日足を取得する。

    offline=True なら合成データ。それ以外はキャッシュ優先で、
    refresh=True またはキャッシュ欠損時にネットから取得して保存する。
    """
    if offline:
        return synthetic_bars(code, days=synthetic_days, end=synthetic_end)
    if not refresh:
        cached = load_cache(code, data_dir)
        if cached:
            return cached
    bars = fetch(code)
    save_cache(code, bars, data_dir)
    return bars


def filter_bars(bars, start=None, end=None):
    """ISO 日付文字列 start/end で期間を絞り込む。"""
    return [b for b in bars
            if (start is None or b.date >= start) and (end is None or b.date <= end)]


# ---------------------------------------------------------------------------
# 合成データ（オフラインモード）
# ---------------------------------------------------------------------------

def _seed_for(code):
    return zlib.crc32(code.encode("utf-8"))


def _weekdays_back(end, n):
    """end から遡って n 営業日（土日除く）の日付リストを昇順で返す。"""
    days = []
    d = end
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d -= timedelta(days=1)
    days.reverse()
    return days


def synthetic_bars(code, days=1500, end=None, seed=None):
    """決定論的な合成日足を生成する（幾何ブラウン運動＋トレンドレジーム）。

    同じ code・days・end なら常に同じ系列を返すのでテストに使える。
    """
    rnd = random.Random(seed if seed is not None else _seed_for(code))
    end = end or date.today()
    dates = _weekdays_back(end, days)

    price = rnd.uniform(800, 12000)
    base_mu = rnd.uniform(-0.0001, 0.0004)
    vol = rnd.uniform(0.012, 0.025)
    drift = 0.0
    regime_left = 0

    bars = []
    prev_close = price
    for d in dates:
        if regime_left <= 0:
            regime_left = rnd.randint(60, 180)
            drift = rnd.uniform(-0.0015, 0.002)
        regime_left -= 1

        ret = base_mu + drift + rnd.gauss(0, vol)
        close = max(prev_close * math.exp(ret), 1.0)
        opn = max(prev_close * (1 + rnd.gauss(0, vol * 0.3)), 1.0)
        hi = max(opn, close) * (1 + abs(rnd.gauss(0, vol * 0.4)))
        lo = min(opn, close) * (1 - abs(rnd.gauss(0, vol * 0.4)))
        volume = int(rnd.uniform(2e5, 8e6))
        bars.append(Bar(d.isoformat(),
                        round(opn, 1), round(hi, 1), round(lo, 1),
                        round(close, 1), volume))
        prev_close = close
    return bars


def load_universe_bars(codes, offline=False, refresh=False, data_dir=None,
                       start=None, end=None, synthetic_end=None,
                       on_error=None):
    """複数銘柄の日足を dict[code, list[Bar]] で返す。

    取得に失敗した銘柄はスキップし、on_error(code, exc) を呼ぶ。
    """
    data = {}
    for code in codes:
        try:
            bars = get_bars(code, offline=offline, refresh=refresh,
                            data_dir=data_dir, synthetic_end=synthetic_end)
        except (DataFetchError, OSError) as e:
            if on_error:
                on_error(code, e)
            continue
        bars = filter_bars(bars, start, end)
        if bars:
            data[code] = bars
    return data
