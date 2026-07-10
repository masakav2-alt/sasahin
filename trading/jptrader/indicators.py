"""テクニカル指標（純粋関数）。

すべて入力と同じ長さのリストを返し、計算に必要なデータが揃わない
先頭部分は None で埋める。
"""


def sma(values, period):
    """単純移動平均。"""
    if period <= 0:
        raise ValueError("period must be positive")
    out = [None] * len(values)
    s = 0.0
    for i, v in enumerate(values):
        s += v
        if i >= period:
            s -= values[i - period]
        if i >= period - 1:
            out[i] = s / period
    return out


def ema(values, period):
    """指数移動平均（最初の値は SMA でシード）。"""
    if period <= 0:
        raise ValueError("period must be positive")
    out = [None] * len(values)
    if len(values) < period:
        return out
    out[period - 1] = sum(values[:period]) / period
    k = 2.0 / (period + 1)
    for i in range(period, len(values)):
        out[i] = values[i] * k + out[i - 1] * (1 - k)
    return out


def rsi(values, period=14):
    """RSI（Wilder 平滑）。0-100。"""
    n = len(values)
    out = [None] * n
    if n <= period:
        return out
    gains = losses = 0.0
    for i in range(1, period + 1):
        d = values[i] - values[i - 1]
        if d >= 0:
            gains += d
        else:
            losses -= d
    avg_g = gains / period
    avg_l = losses / period

    def _rsi(g, l):
        if l == 0:
            return 100.0
        return 100.0 - 100.0 / (1.0 + g / l)

    out[period] = _rsi(avg_g, avg_l)
    for i in range(period + 1, n):
        d = values[i] - values[i - 1]
        g = d if d > 0 else 0.0
        l = -d if d < 0 else 0.0
        avg_g = (avg_g * (period - 1) + g) / period
        avg_l = (avg_l * (period - 1) + l) / period
        out[i] = _rsi(avg_g, avg_l)
    return out


def atr(bars, period=14):
    """ATR（Average True Range、Wilder 平滑）。bars は Bar のリスト。"""
    n = len(bars)
    out = [None] * n
    if n < period:
        return out
    trs = []
    for i, b in enumerate(bars):
        if i == 0:
            tr = b.high - b.low
        else:
            pc = bars[i - 1].close
            tr = max(b.high - b.low, abs(b.high - pc), abs(b.low - pc))
        trs.append(tr)
    a = sum(trs[:period]) / period
    out[period - 1] = a
    for i in range(period, n):
        a = (a * (period - 1) + trs[i]) / period
        out[i] = a
    return out
