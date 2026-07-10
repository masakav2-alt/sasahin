"""CLI エントリポイント。

使い方:
    python3 trading/run.py universe
    python3 trading/run.py fetch [--codes 7203,6758] [--refresh]
    python3 trading/run.py backtest [--strategy ma_cross] [--offline] ...
    python3 trading/run.py trade [--strategy ma_cross] [--offline] ...
    python3 trading/run.py report
"""

import argparse
import sys

from . import data as datamod
from .backtest import Backtester, BTConfig
from .portfolio import (DEFAULT_STATE_PATH, load_state, save_state, step)
from .report import (format_actions, format_backtest, format_portfolio,
                     format_trades)
from .strategy import STRATEGIES, make_strategy
from .universe import UNIVERSE, default_codes, name_of


def _parse_params(pairs):
    """"key=value" のリストを dict に変換（数値は自動変換）。"""
    params = {}
    for p in pairs or []:
        if "=" not in p:
            raise SystemExit("--param は key=value 形式で指定: {}".format(p))
        k, v = p.split("=", 1)
        try:
            params[k] = int(v)
        except ValueError:
            try:
                params[k] = float(v)
            except ValueError:
                params[k] = v
    return params


def _codes_from(args):
    if args.codes:
        return [c.strip() for c in args.codes.split(",") if c.strip()]
    return default_codes()


def _load_data(args, codes):
    def on_error(code, e):
        print("警告: {} の取得に失敗: {}".format(code, e), file=sys.stderr)

    return datamod.load_universe_bars(
        codes, offline=args.offline, refresh=getattr(args, "refresh", False),
        data_dir=args.data_dir, start=getattr(args, "start", None),
        end=getattr(args, "end", None), on_error=on_error)


def _make_config(args):
    cfg = BTConfig()
    if getattr(args, "capital", None):
        cfg.initial_capital = args.capital
    return cfg


def cmd_universe(_args):
    print("売買対象ユニバース（{}銘柄）:".format(len(UNIVERSE)))
    for code, (name, sector) in UNIVERSE.items():
        print("  {}  {:<16} {}".format(code, name, sector))
    return 0


def cmd_fetch(args):
    codes = _codes_from(args)
    ok = 0
    for code in codes:
        try:
            bars = datamod.get_bars(code, refresh=args.refresh,
                                    data_dir=args.data_dir)
            print("{} {:<16} {}本 ({}〜{})".format(
                code, name_of(code), len(bars), bars[0].date, bars[-1].date))
            ok += 1
        except Exception as e:
            print("{} {:<16} 取得失敗: {}".format(code, name_of(code), e),
                  file=sys.stderr)
    print("{}/{} 銘柄を取得".format(ok, len(codes)))
    return 0 if ok else 1


def cmd_backtest(args):
    codes = _codes_from(args)
    data = _load_data(args, codes)
    if not data:
        print("エラー: データがありません。まず fetch するか --offline を"
              "指定してください。", file=sys.stderr)
        return 1
    strategy = make_strategy(args.strategy, **_parse_params(args.param))
    cfg = _make_config(args)
    result = Backtester(strategy, data, cfg).run()
    print(format_backtest(result, strategy.describe()))
    print("-" * 60)
    print(format_trades(result.trades, limit=args.show_trades))
    if args.offline:
        print("\n※ --offline は合成データによるエンジン検証です。"
              "実データでの検証には fetch 後に再実行してください。")
    return 0


def cmd_trade(args):
    codes = _codes_from(args)
    data = _load_data(args, codes)
    if not data:
        print("エラー: データがありません。", file=sys.stderr)
        return 1
    strategy = make_strategy(args.strategy, **_parse_params(args.param))
    cfg = _make_config(args)
    state = load_state(args.state_file, capital=cfg.initial_capital)
    actions = step(state, data, strategy, cfg)
    if not args.dry_run:
        save_state(state, args.state_file)
    prices = {c: bars[-1].close for c, bars in data.items()}
    print(format_actions(actions))
    print()
    print(format_portfolio(state, prices))
    if args.dry_run:
        print("\n※ --dry-run のため状態は保存していません。")
    return 0


def cmd_report(args):
    codes = _codes_from(args)
    state = load_state(args.state_file)
    data = _load_data(args, codes)
    prices = {c: bars[-1].close for c, bars in data.items() if bars}
    print(format_portfolio(state, prices))
    return 0


def build_parser():
    p = argparse.ArgumentParser(
        prog="jptrader",
        description="日本株ペーパートレード・ボット（教育・検証用。投資助言ではありません）")
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp, with_period=False):
        sp.add_argument("--codes", help="対象銘柄（カンマ区切り。省略時はユニバース全体）")
        sp.add_argument("--offline", action="store_true",
                        help="合成データを使う（ネット不要・検証用）")
        sp.add_argument("--data-dir", default=None, help="価格キャッシュのディレクトリ")
        if with_period:
            sp.add_argument("--start", help="開始日 YYYY-MM-DD")
            sp.add_argument("--end", help="終了日 YYYY-MM-DD")

    def strategy_opts(sp):
        sp.add_argument("--strategy", default="ma_cross",
                        choices=sorted(STRATEGIES),
                        help="戦略（デフォルト: ma_cross）")
        sp.add_argument("--param", action="append", metavar="KEY=VALUE",
                        help="戦略パラメータ上書き（例: --param fast=10）")
        sp.add_argument("--capital", type=float, default=None,
                        help="初期資金（デフォルト: 300万円）")

    sp = sub.add_parser("universe", help="売買対象銘柄の一覧")
    sp.set_defaults(func=cmd_universe)

    sp = sub.add_parser("fetch", help="日足データを取得してキャッシュ")
    common(sp)
    sp.add_argument("--refresh", action="store_true", help="キャッシュを無視して再取得")
    sp.set_defaults(func=cmd_fetch)

    sp = sub.add_parser("backtest", help="過去データで戦略を検証")
    common(sp, with_period=True)
    strategy_opts(sp)
    sp.add_argument("--show-trades", type=int, default=15,
                    help="表示するトレード履歴の件数")
    sp.set_defaults(func=cmd_backtest)

    sp = sub.add_parser("trade", help="ペーパートレードの日次ステップを実行")
    common(sp)
    strategy_opts(sp)
    sp.add_argument("--state-file", default=DEFAULT_STATE_PATH,
                    help="口座状態の JSON ファイル")
    sp.add_argument("--dry-run", action="store_true", help="状態を保存しない")
    sp.set_defaults(func=cmd_trade)

    sp = sub.add_parser("report", help="口座状態のレポート")
    common(sp)
    sp.add_argument("--state-file", default=DEFAULT_STATE_PATH)
    sp.set_defaults(func=cmd_report)

    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except BrokenPipeError:
        # 出力先が head 等で先に閉じられた場合は正常終了扱い
        return 0
