"""PyInstaller 入口。

必须有一个"顶层"脚本来 import 包，因为 launcher 包内部用的是相对导入；
直接拿 launcher/main.py 当入口，冻结后相对导入会炸。
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from launcher.main import main  # noqa: E402

raise SystemExit(main())
