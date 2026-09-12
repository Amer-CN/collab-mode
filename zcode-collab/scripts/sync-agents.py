#!/usr/bin/env python3
"""把仓库源 content/roles/*.md 的正文同步到本机已部署的 ~/.zcode/agents/*.md

为什么要这个脚本：仓库源改了之后，本机运行时文件不会自动更新——
`~/.zcode/agents/` 里的是**部署产物**，必须手工覆盖。此前就是因为漏了这步，
v0.3.0 回补的 10 条规则从未在 ZCode 里生效。

铁律：
- **frontmatter 一字不动**（model / color / name 是用户配置，覆盖会毁掉席位表）
- 只替换正文（frontmatter 之后的内容）
- 三席 advisor 共用同一份源正文，各文件自己的 name/model/color 保留

用法：
    python sync-agents.py <仓库根> [--write]
"""
import io
import re
import sys
from pathlib import Path

AGENTS_DIR = Path.home() / ".zcode" / "agents"

# 本机文件名 → 源角色 key
LOCAL_TO_ROLE = {
    "executor.md": "executor",
    "code-reviewer.md": "code-reviewer",
    "researcher.md": "researcher",
    "vision-reader.md": "vision-reader",
    "advisor-a.md": "advisor",
    "advisor-b.md": "advisor",
    "advisor-c.md": "advisor",
}


def split_frontmatter(text: str):
    """返回 (frontmatter含结尾换行, 正文)。无 frontmatter 返回 (None, text)。"""
    m = re.match(r"(?s)^(---\n.*?\n---\n)(.*)$", text)
    if not m:
        return None, text
    return m.group(1), m.group(2)


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: python sync-agents.py <仓库根> [--write]", file=sys.stderr)
        return 2
    repo = Path(sys.argv[1])
    write = "--write" in sys.argv
    roles_dir = repo / "content" / "roles"
    if not roles_dir.is_dir():
        print(f"[错误] 找不到 {roles_dir}", file=sys.stderr)
        return 2

    if not AGENTS_DIR.is_dir():
        print(f"[错误] 找不到本机 agents 目录 {AGENTS_DIR}", file=sys.stderr)
        return 2

    changed = 0
    for fname, key in LOCAL_TO_ROLE.items():
        local = AGENTS_DIR / fname
        src = roles_dir / f"{key}.md"
        if not local.exists():
            print(f"[跳过] {fname} 不存在（未部署该角色）")
            continue
        if not src.exists():
            print(f"[错误] 源 {src} 不存在", file=sys.stderr)
            return 2

        old = local.read_text(encoding="utf-8")
        front, old_body = split_frontmatter(old)
        if front is None:
            print(f"[跳过] {fname} 没有 frontmatter，拒绝改写")
            continue

        new_body = src.read_text(encoding="utf-8").rstrip("\n") + "\n"
        if old_body.lstrip("\n") == new_body:
            print(f"[一致] {fname}")
            continue

        new_text = front + "\n" + new_body
        changed += 1
        if write:
            local.write_text(new_text, encoding="utf-8", newline="\n")
            print(f"[更新] {fname}")
        else:
            print(f"[差异] {fname}")

    if not write:
        print(f"\n预览模式：{changed} 个文件需更新（未写入）。加 --write 执行。")
        return 1 if changed else 0
    print(f"\n已更新 {changed} 个文件。**必须重启 ZCode 或新开会话**才生效"
          f"（子智能体在会话启动时发现）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
