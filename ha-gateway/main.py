"""打包入口：pyinstaller 以此文件为脚本。"""

from ha_gateway.__main__ import main

if __name__ == "__main__":
    raise SystemExit(main())
