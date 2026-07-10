#!/usr/bin/env python3
"""jptrader の起動スクリプト。`python3 trading/run.py --help` を参照。"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from jptrader.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
