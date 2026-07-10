"""バックテスト結果・ポートフォリオ状態の整形出力。"""

from .universe import name_of


def _yen(v):
    return "{:,.0f}円".format(v)


def _pct(v):
    return "{:+.2f}%".format(v * 100)


def format_backtest(result, strategy_desc=""):
    m = result.metrics
    lines = []
    lines.append("=" * 60)
    lines.append("バックテスト結果  {}".format(strategy_desc))
    lines.append("=" * 60)
    if not result.equity_curve:
        lines.append("データなし")
        return "\n".join(lines)
    lines.append("期間          : {} 〜 {}（{:.1f}年）".format(
        result.equity_curve[0][0], result.equity_curve[-1][0],
        m.get("years", 0)))
    lines.append("初期資金      : {}".format(_yen(m["initial_capital"])))
    lines.append("最終資産      : {}".format(_yen(m["final_equity"])))
    lines.append("累積リターン  : {}".format(_pct(m["total_return"])))
    lines.append("年率リターン  : {}".format(_pct(m["cagr"])))
    lines.append("最大DD        : -{:.2f}%".format(m["max_drawdown"] * 100))
    lines.append("シャープレシオ: {:.2f}".format(m["sharpe"]))
    lines.append("トレード数    : {}".format(m["num_trades"]))
    if m.get("num_trades"):
        lines.append("勝率          : {:.1f}%".format(m["win_rate"] * 100))
        pf = m["profit_factor"]
        lines.append("PF            : {}".format(
            "∞" if pf == float("inf") else "{:.2f}".format(pf)))
        lines.append("平均損益      : {}".format(_yen(m["avg_trade_pnl"])))
    if result.open_positions:
        lines.append("-" * 60)
        lines.append("バックテスト終了時の保有:")
        for code, pos in sorted(result.open_positions.items()):
            lines.append("  {} {}  {}株 @{:,.1f}".format(
                code, name_of(code), pos.shares, pos.entry_price))
    return "\n".join(lines)


def format_trades(trades, limit=15):
    if not trades:
        return "(トレードなし)"
    lines = ["直近のトレード（最大{}件）:".format(limit)]
    header = "  {:<6} {:<14} {:>6} {:>10} {:>10} {:>12} {:<6}".format(
        "code", "銘柄", "株数", "IN", "OUT", "損益", "理由")
    lines.append(header)
    for t in trades[-limit:]:
        if isinstance(t, dict):
            code, shares = t["code"], t["shares"]
            ein, eout, pnl, reason = (t["entry_price"], t["exit_price"],
                                      t["pnl"], t["reason"])
        else:
            code, shares = t.code, t.shares
            ein, eout, pnl, reason = t.entry_price, t.exit_price, t.pnl, t.reason
        lines.append("  {:<6} {:<14} {:>6} {:>10,.1f} {:>10,.1f} {:>+12,.0f} {:<6}".format(
            code, name_of(code)[:7], shares, ein, eout, pnl, reason))
    return "\n".join(lines)


def format_portfolio(state, prices):
    from .portfolio import equity_of
    lines = []
    lines.append("=" * 60)
    lines.append("ペーパートレード口座")
    lines.append("=" * 60)
    equity = equity_of(state, prices)
    initial = state["initial_capital"]
    lines.append("初期資金      : {}".format(_yen(initial)))
    lines.append("現在資産      : {}（{}）".format(
        _yen(equity), _pct(equity / initial - 1)))
    lines.append("現金          : {}".format(_yen(state["cash"])))
    lines.append("最終実行日    : {}".format(state.get("last_run") or "未実行"))
    positions = state["positions"]
    if positions:
        lines.append("-" * 60)
        lines.append("保有ポジション:")
        for code, pos in sorted(positions.items()):
            price = prices.get(code, pos["entry_price"])
            pnl = (price - pos["entry_price"]) * pos["shares"]
            lines.append(
                "  {} {:<10} {:>6}株  取得 {:>9,.1f}  現値 {:>9,.1f}"
                "  損益 {:>+11,.0f}  逆指値 {:>9,.1f}".format(
                    code, name_of(code)[:6], pos["shares"],
                    pos["entry_price"], price, pnl, pos["stop"]))
    else:
        lines.append("保有ポジションなし")
    if state["trades"]:
        lines.append("-" * 60)
        lines.append(format_trades(state["trades"]))
    return "\n".join(lines)


def format_actions(actions):
    if not actions:
        return "本日のアクション: なし"
    lines = ["本日のアクション:"]
    for a in actions:
        if a["type"] == "buy":
            lines.append("  [買] {} {}  {}株 @{:,.1f}（逆指値 {:,.1f}）".format(
                a["code"], name_of(a["code"]), a["shares"], a["price"], a["stop"]))
        elif a["type"] == "sell":
            lines.append("  [売] {} {}  {}株 @{:,.1f}  損益 {:+,.0f}円（{}）".format(
                a["code"], name_of(a["code"]), a["shares"], a["exit_price"],
                a["pnl"], a["reason"]))
        elif a["type"] == "trail":
            lines.append("  [更新] {} {} の逆指値を {:,.1f} に引き上げ".format(
                a["code"], name_of(a["code"]), a["stop"]))
        elif a["type"] == "skip":
            lines.append("  [スキップ] {}".format(a["detail"]))
    return "\n".join(lines)
