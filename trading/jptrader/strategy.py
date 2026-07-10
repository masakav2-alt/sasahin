"""売買戦略。

各戦略は「i 日目の引けの時点で使える情報だけ」からシグナルを返す。
翌営業日の寄付で執行する前提（ルックアヘッドバイアス防止）。

シグナル:
    BUY  — 新規買い（保有していなければ）
    SELL — 手仕舞い（保有していれば）
    None — 何もしない
"""

from .indicators import rsi, sma

BUY = "BUY"
SELL = "SELL"


class Strategy:
    """戦略の基底クラス。"""

    name = "base"
    #: この本数分のバーが揃うまではシグナルを出さない
    warmup = 0

    def prepare(self, bars):
        """銘柄ごとの指標を前計算してコンテキストを返す。"""
        return {}

    def signal(self, ctx, bars, i):
        """i 日目の引け時点のシグナルを返す。"""
        raise NotImplementedError

    def describe(self):
        return self.name


class MACross(Strategy):
    """移動平均クロスの順張り（トレンドフォロー）。

    - 買い: 短期SMAが長期SMAを上抜け、かつ終値が長期トレンドSMA
      （デフォルト200日）より上（上昇トレンド中の押し目クロスのみ拾う）
    - 売り: 短期SMAが長期SMAを下抜け
    """

    name = "ma_cross"

    def __init__(self, fast=25, slow=75, trend=200):
        if fast >= slow:
            raise ValueError("fast must be < slow")
        self.fast = int(fast)
        self.slow = int(slow)
        self.trend = int(trend) if trend else 0
        self.warmup = max(self.slow, self.trend) + 1

    def prepare(self, bars):
        closes = [b.close for b in bars]
        return {
            "fast": sma(closes, self.fast),
            "slow": sma(closes, self.slow),
            "trend": sma(closes, self.trend) if self.trend else None,
        }

    def signal(self, ctx, bars, i):
        f, s = ctx["fast"], ctx["slow"]
        if i < 1 or None in (f[i], s[i], f[i - 1], s[i - 1]):
            return None
        if f[i - 1] <= s[i - 1] and f[i] > s[i]:
            if self.trend:
                t = ctx["trend"][i]
                if t is None or bars[i].close <= t:
                    return None
            return BUY
        if f[i - 1] >= s[i - 1] and f[i] < s[i]:
            return SELL
        return None

    def describe(self):
        return "ma_cross(fast={}, slow={}, trend={})".format(
            self.fast, self.slow, self.trend)


class RsiMeanReversion(Strategy):
    """RSI 逆張り（長期上昇トレンド銘柄の押し目買い）。

    - 買い: RSI が buy_th 未満、かつ終値がトレンドSMA（200日）より上。
      トレンドフィルタがないと下落トレンドの「落ちるナイフ」を掴むため必須。
    - 売り: RSI が sell_th 超（平均回帰の完了）
    """

    name = "rsi"

    def __init__(self, period=14, buy_th=30.0, sell_th=60.0, trend=200):
        self.period = int(period)
        self.buy_th = float(buy_th)
        self.sell_th = float(sell_th)
        self.trend = int(trend) if trend else 0
        self.warmup = max(self.period + 1, self.trend)

    def prepare(self, bars):
        closes = [b.close for b in bars]
        return {
            "rsi": rsi(closes, self.period),
            "trend": sma(closes, self.trend) if self.trend else None,
        }

    def signal(self, ctx, bars, i):
        r = ctx["rsi"][i]
        if r is None:
            return None
        if r < self.buy_th:
            if self.trend:
                t = ctx["trend"][i]
                if t is None or bars[i].close <= t:
                    return None
            return BUY
        if r > self.sell_th:
            return SELL
        return None

    def describe(self):
        return "rsi(period={}, buy_th={}, sell_th={}, trend={})".format(
            self.period, self.buy_th, self.sell_th, self.trend)


STRATEGIES = {
    MACross.name: MACross,
    RsiMeanReversion.name: RsiMeanReversion,
}


def make_strategy(name, **params):
    """名前とパラメータから戦略インスタンスを作る。"""
    cls = STRATEGIES.get(name)
    if cls is None:
        raise ValueError("unknown strategy: {} (available: {})".format(
            name, ", ".join(sorted(STRATEGIES))))
    return cls(**params)
