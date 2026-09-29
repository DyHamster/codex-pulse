#!/usr/bin/env python3
"""Install this local build into the user's personal Codex marketplace."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

source = Path(__file__).resolve().parents[1]
home = Path.home()
target = home / 'plugins/codex-pulse'
helpers = home / '.codex/skills/.system/plugin-creator/scripts'
marketplace = home / '.agents/plugins/marketplace.json'
node = shutil.which('node')
codex = shutil.which('codex')
if not node or not codex:
    sys.exit('需要 Node.js 22+ 与 Codex CLI。')
if target.exists():
    sys.exit(f'已有安装源码，未覆盖：{target}。更新请按 README 的更新步骤执行。')
if not (helpers / 'create_basic_plugin.py').is_file():
    sys.exit('未找到 Codex plugin-creator 脚手架工具，请在 Codex 中安装此插件。')
if marketplace.exists():
    subprocess.run([sys.executable, str(helpers / 'read_marketplace_name.py')], check=True)
subprocess.run([sys.executable, str(helpers / 'create_basic_plugin.py'), 'codex-pulse', '--with-marketplace'], check=True)
shutil.copytree(source, target, dirs_exist_ok=True, ignore=shutil.ignore_patterns('.git', 'node_modules', '__pycache__', 'build'))
compat_config = {
    'mcpServers': {
        'pulse': {
            'type': 'stdio',
            'command': node,
            'args': [str(target / 'src/mcp.mjs')],
            'cwd': str(target),
        }
    }
}
portable_config = {
    '$schema': 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    **compat_config,
}
(target / '.mcp.json').write_text(json.dumps(compat_config, indent=2) + '\n')
(target / 'mcp.json').write_text(json.dumps(portable_config, indent=2) + '\n')
yaml_available = subprocess.run(
    [sys.executable, '-c', 'import yaml'],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
).returncode == 0
if yaml_available:
    subprocess.run(
        [sys.executable, str(helpers / 'validate_plugin.py'), str(target)],
        check=True,
    )
else:
    print('提示：未安装 PyYAML，跳过本机重复校验；发布源码已经过校验。', file=sys.stderr)
name = subprocess.check_output([sys.executable, str(helpers / 'read_marketplace_name.py')], text=True).strip()
subprocess.run([codex, 'plugin', 'add', f'codex-pulse@{name}', '--json'], check=True)
print(f'已安装 Codex Pulse。请在新聊天中使用插件。源码：{target}')
