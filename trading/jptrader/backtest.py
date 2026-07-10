"""バックテストエンジン。

執行モデル:
  - i 日目の引けでシグナル判定 → 翌営業日の寄付で執行（ルックアヘッド防止）
  - 買いは寄付×(1+スリッページ)、売りは寄付×(1-スリッページ)
  - 手数料は約定代金×手数料率
  - 株数は単元（100株）に切り捨て

リスク管理:
  - 1トレードのリスク（エントリー〜ストップの想定損失）を総資産の
    risk_per_trade 以内に抑える ATR ベースのポジションサイジング
  - ATR×atr_mult のストップロス（トレーリング可）
  - 同時保有数・1銘柄あたり資産比率の上限
"""

import math
from dataclasses import dataclass, field

from .indicators import atr as atr_series
from .strategy import BUY, SELL


@dataclass
class BTConfig:
    initial_capital: float = 3_000_000.0
    commission: float = 0.0005     # 手数料率（片道）
    slippage: float = 0.001        # スリッページ率（片道）
    unit: int = 100                # 単元株数
    risk_per_trade: float = 0.01   # 1トレードで許容するリスク（資産比）
    atr_period: int = 14
    atr_mult: float = 2.5          # ストップ幅 = ATR × この倍率
    max_positions: int = 8
    max_weight: float = 0.2        # 1銘柄の最大資産比率
    trailing_stop: bool = True
    order_ttl: int = 5             # 未執行注文の有効日数（営業日）


@dataclass
class Position:
    code: str
    shares: int
    entry_price: float
    entry_date: str
    stop: float


@dataclass
class Trade:
    code: str
    shares: int
    entry_date: str
    entry_price: float
    exit_date: str
    exit_price: float
    reason: str  # "signal" | "stop" | "eod"

    @property
    def pnl(self):
        return (self.exit_price - self.entry_price) * self.shares

    @property
    def ret(self):
        return self.exit_price / self.entry_price - 1.0


@dataclass
class Result:
    equity_curve: list = field(default_factory=list)  # [(date, equity)]
    trades: list = field(default_factory=list)
    final_cash: float = 0.0
    open_positions: dict = field(default_factory=dict)
    metrics: dict = field(default_factory=dict)


def size_position(equity, price, atr_value, cfg):
    """ATR ベースのポジションサイズ（株数、単元切り捨て）を返す。"""
    if atr_value is None or atr_value <= 0 or price <= 0:
        return 0
    stop_dist = cfg.atr_mult * atr_value
    risk_amount = equity * cfg.risk_per_trade
    shares = int(risk_amount / stop_dist / cfg.unit) * cfg.unit
    cap = int(equity * cfg.max_weight / price / cfg.unit) * cfg.unit
    return max(min(shares, cap), 0)


class Backtester:
    def __init__(self, strategy, data, config=None):
        """data: dict[code, list[Bar]]（日付昇順）。"""
        self.strategy = strategy
        self.data = {c: bars for c, bars in data.items() if bars}
        self.cfg = config or BTConfig()

    def run(self):
        cfg = self.cfg
        data = self.data
        idx = {c: {b.date: i for i, b in enumerate(bars)}
               for c, bars in data.items()}
        ctxs = {c: self.strategy.prepare(bars) for c, bars in data.items()}
        atrs = {c: atr_series(bars, cfg.atr_period) for c, bars in data.items()}
        calendar = sorted({b.date for bars in data.values() for b in bars})

        cash = cfg.initial_capital
        positions = {}   # code -> Position
        pending = []     # {code, side, shares, age}
        last_close = {}
        trades = []
        equity_curve = []

        def mark_to_market():
            return cash + sum(p.shares * last_close.get(p.code, p.entry_price)
                              for p in positions.values())

        for d in calendar:
            # --- 1. 寄付で保留注文を執行（売り→買いの順で資金を確保） ---
            next_pending = []
            for order in sorted(pending, key=lambda o: 0 if o["side"] == SELL else 1):
                i = idx[order["code"]].get(d)
                if i is None:
                    order["age"] += 1
                    if order["age"] <= cfg.order_ttl:
                        next_pending.append(order)
                    continue
                bar = data[order["code"]][i]
                code = order["code"]
                if order["side"] == SELL:
                    pos = positions.get(code)
                    if pos is None:
                        continue
                    price = bar.open * (1 - cfg.slippage)
                    cash += pos.shares * price * (1 - cfg.commission)
                    trades.append(Trade(code, pos.shares, pos.entry_date,
                                        pos.entry_price, d, price, "signal"))
                    del positions[code]
                else:  # BUY
                    if code in positions or len(positions) >= cfg.max_positions:
                        continue
                    price = bar.open * (1 + cfg.slippage)
                    shares = order["shares"]
                    while shares > 0 and shares * price * (1 + cfg.commission) > cash:
                        shares -= cfg.unit
                    if shares <= 0:
                        continue
                    cash -= shares * price * (1 + cfg.commission)
                    stop = price - cfg.atr_mult * order["atr"]
                    positions[code] = Position(code, shares, price, d, stop)
            pending = next_pending

            # --- 2. ストップロス判定（ザラ場中に安値がストップに到達） ---
            for code, pos in list(positions.items()):
                i = idx[code].get(d)
                if i is None:
                    continue
                bar = data[code][i]
                if bar.low <= pos.stop:
                    # 寄付から窓を開けて下落した場合は寄付で成行決済
                    exit_price = min(bar.open, pos.stop) * (1 - cfg.slippage)
                    cash += pos.shares * exit_price * (1 - cfg.commission)
                    trades.append(Trade(code, pos.shares, pos.entry_date,
                                        pos.entry_price, d, exit_price, "stop"))
                    del positions[code]

            # --- 3. 終値を記録 ---
            for code in data:
                i = idx[code].get(d)
                if i is not None:
                    last_close[code] = data[code][i].close

            # --- 4. 引けでシグナル判定 → 翌日執行の注文を生成 ---
            equity = mark_to_market()
            pending_codes = {o["code"] for o in pending}
            for code, bars in data.items():
                i = idx[code].get(d)
                if i is None or i < self.strategy.warmup or code in pending_codes:
                    continue
                sig = self.strategy.signal(ctxs[code], bars, i)
                if sig == SELL and code in positions:
                    pending.append({"code": code, "side": SELL,
                                    "shares": None, "age": 0})
                elif sig == BUY and code not in positions:
                    if len(positions) + sum(1 for o in pending if o["side"] == BUY) \
                            >= cfg.max_positions:
                        continue
                    a = atrs[code][i]
                    shares = size_position(equity, bars[i].close, a, cfg)
                    if shares > 0:
                        pending.append({"code": code, "side": BUY,
                                        "shares": shares, "atr": a, "age": 0})

            # --- 5. トレーリングストップの引き上げ ---
            if cfg.trailing_stop:
                for code, pos in positions.items():
                    i = idx[code].get(d)
                    if i is None:
                        continue
                    a = atrs[code][i]
                    if a:
                        new_stop = data[code][i].close - cfg.atr_mult * a
                        if new_stop > pos.stop:
                            pos.stop = new_stop

            equity_curve.append((d, mark_to_market()))

        result = Result(equity_curve=equity_curve, trades=trades,
                        final_cash=cash,
                        open_positions={c: p for c, p in positions.items()})
        result.metrics = compute_metrics(result, cfg)
        return result


def compute_metrics(result, cfg):
    """バックテスト結果から評価指標を計算する。"""
    curve = result.equity_curve
    m = {"num_trades": len(result.trades)}
    if not curve:
        return m
    start_eq = cfg.initial_capital
    end_eq = curve[-1][1]
    m["initial_capital"] = start_eq
    m["final_equity"] = end_eq
    m["total_return"] = end_eq / start_eq - 1.0

    # CAGR（暦日ベース）
    from datetime import date as _date
    d0 = _date.fromisoformat(curve[0][0])
    d1 = _date.fromisoformat(curve[-1][0])
    years = max((d1 - d0).days / 365.25, 1e-9)
    m["years"] = years
    if end_eq > 0:
        m["cagr"] = (end_eq / start_eq) ** (1 / years) - 1.0
    else:
        m["cagr"] = -1.0

    # 最大ドローダウン
    peak = -float("inf")
    max_dd = 0.0
    for _, eq in curve:
        peak = max(peak, eq)
        if peak > 0:
            max_dd = max(max_dd, 1.0 - eq / peak)
    m["max_drawdown"] = max_dd

    # シャープレシオ（日次リターン、年率換算、無リスク金利0と仮定）
    rets = []
    for i in range(1, len(curve)):
        prev = curve[i - 1][1]
        if prev > 0:
            rets.append(curve[i][1] / prev - 1.0)
    if len(rets) >= 2:
        mean = sum(rets) / len(rets)
        var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
        sd = math.sqrt(var)
        m["sharpe"] = (mean / sd) * math.sqrt(252) if sd > 0 else 0.0
    else:
        m["sharpe"] = 0.0

    # トレード統計
    trades = result.trades
    if trades:
        wins = [t for t in trades if t.pnl > 0]
        losses = [t for t in trades if t.pnl <= 0]
        m["win_rate"] = len(wins) / len(trades)
        gross_win = sum(t.pnl for t in wins)
        gross_loss = -sum(t.pnl for t in losses)
        m["profit_factor"] = (gross_win / gross_loss) if gross_loss > 0 else float("inf")
        m["avg_trade_pnl"] = sum(t.pnl for t in trades) / len(trades)
    return m
