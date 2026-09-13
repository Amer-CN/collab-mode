#!/usr/bin/env python3
"""sync_from_manifest.py — 从插件仓库 content/ + manifest.json 生成 skill 的产物

单一来源约定（v0.3.0 起）：
- 角色正文唯一来源 = 插件仓库 content/roles/*.md
- frontmatter 锚点 = skill 现有文件的 frontmatter（只字不动），除 tools 列表外
  tools 列表来自 manifest 的 zcode.tools（如 research 的 GitHub MCP 工具增减）
- model: 占位符、name、color 等部署元信息一律保留 skill 现有值

单一来源约定（v0.4.0 起）：
- 规则文本唯一来源 = 插件仓库 content/collab-rules.md（带平台占位符）
- 按 zcode 平台渲染后写入 references/global-agents.md

用法（以 skill 目录为 cwd）：
    python scripts/sync_from_manifest.py <插件仓库根> [--write]

不带 --write 时只做 diff 预览并 exit 1（有差异）/ 0（一致）；
带 --write 时回写 references/agent-*.md、references/global-agents.md。
VERSION 对齐由本脚本一并完成（manifest.version → skill VERSION）。

设计铁律：
- 永不丢规则：正文整段替换，不做行级合并
- 永不改 frontmatter 部署信息：只允许刷新 tools 列表
- researcher 的 toolsNote 注释行必须保留（那是部署条件的活文档）
- advisor 一份模板生成三席文件（advisor-A/B/C，仅 name 不同）
- 规则文本的占位符语义必须与 dsh-collab-mode/build.mjs 的 renderRules() 逐字一致
"""
import json
import re
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent

RULES_OUT = "global-agents.md"

# 角色 key → skill 文件名（advisor 一份模板出三席）
ROLE_FILES = {
    "executor": ["agent-executor.md"],
    "code-reviewer": ["agent-code-reviewer.md"],
    "researcher": ["agent-researcher.md"],
    "advisor": ["agent-advisor.md"],
    "vision-reader": ["agent-vision-reader.md"],
}

ADVISOR_SEATS = {
    "agent-advisor.md": "advisor-A",
    "advisor-b.md": "advisor-B",
    "advisor-c.md": "advisor-C",
}

# 平台块标记：`{{#zcode}}` / `{{/zcode}}`，各占一整行（行内无其他内容）。
_BLOCK_OPEN = re.compile(r"^\{\{#([A-Za-z0-9_-]+)\}\}$")
_BLOCK_CLOSE = re.compile(r"^\{\{/([A-Za-z0-9_-]+)\}\}$")
# 行内占位符：`{{NAME}}`
_INLINE = re.compile(r"\{\{([A-Za-z0-9_-]+)\}\}")


def render_rules(text: str, platform: str, placeholders: dict) -> str:
    """按平台渲染 collab-rules.md。

    占位符语法约定（与 dsh-collab-mode/build.mjs 的 renderRules() 语义一致）：

      `{{NAME}}`            行内替换：取 placeholders[NAME][platform]，
                            取值一律来自 manifest，本文件不写死任何角色名或文案。
      `{{#platform}}` 块    平台块：起始行与结束行各占一整行。
                            当前平台命中 → 去掉两行标记、保留块内内容；
                            未命中 → 整块删除，并连同块前的一个空行一起删掉
                            （源里用「空行 + 块」表示该块独占一段）。

    渲染后若仍残留 `{{` 一律抛错（占位符名拼错、块未闭合都会在这里暴露）。
    """
    out: list[str] = []
    skipping: str | None = None
    for line in text.split("\n"):
        m = _BLOCK_OPEN.match(line)
        if m and skipping is None:
            if m.group(1) == platform:
                continue
            skipping = m.group(1)
            if out and out[-1].strip() == "":
                out.pop()
            continue
        m = _BLOCK_CLOSE.match(line)
        if m:
            if skipping is not None:
                if m.group(1) != skipping:
                    raise ValueError(
                        f"平台块 {{{{#{skipping}}}}} 被 {{{{/{m.group(1)}}}}} 关闭，标签不匹配"
                    )
                skipping = None
                continue
            if m.group(1) == platform:
                continue
            raise ValueError(
                f"出现孤立的平台块结束标记 {{{{/{m.group(1)}}}}}（没有对应的 {{{{#{m.group(1)}}}}}）"
            )
        if skipping is not None:
            continue
        out.append(line)
    if skipping is not None:
        raise ValueError(f"平台块 {{{{#{skipping}}}}} 没有闭合的 {{{{/{skipping}}}}}")

    def sub(match: re.Match) -> str:
        name = match.group(1)
        value = (placeholders.get(name) or {}).get(platform)
        if not isinstance(value, str) or value == "":
            raise ValueError(f"占位符 {match.group(0)} 在 manifest.rules.placeholders 里没有 {platform} 取值")
        return value

    rendered = _INLINE.sub(sub, "\n".join(out))
    left = re.search(r"\{\{[^}]*\}\}", rendered)
    if left is not None:
        raise ValueError(f"渲染 {platform} 规则文本后仍有占位符残留：{left.group(0)}")
    return rendered


def split_frontmatter(text: str) -> tuple[str, str]:
    """拆 frontmatter / 正文。无 frontmatter 时返回 ('', 全文)。"""
    m = re.match(r"(?s)^(---\n.*?\n---\n)(.*)$", text)
    if not m:
        return "", text
    return m.group(1), m.group(2)


def refresh_tools(front: str, tools: list, tools_note: str | None) -> str:
    """只刷新 tools 列表，其余 frontmatter 原样。返回新 frontmatter。"""
    lines = front.split("\n")
    out: list[str] = []
    i = 0
    # 1. 拷贝 tools: 之前的所有行
    while i < len(lines) and lines[i].strip() != "tools:":
        out.append(lines[i])
        i += 1
    if i >= len(lines):
        raise ValueError("frontmatter 里没有 tools: 行，拒绝改写")
    out.append("tools:")
    i += 1
    # 2. 跳过旧 tools 块（含 research 的 toolsNote 注释行）
    while i < len(lines):
        s = lines[i]
        if s.startswith("  - ") or (s.startswith("#") and "MCP" in s.upper()):
            i += 1
            continue
        break
    # 3. 写入新 tools 列表（research 的 toolsNote 注释先行）
    if tools_note:
        out.append("# " + tools_note)
    for t in tools:
        out.append(f"  - {t}")
    # 4. 其余行原样
    out.extend(lines[i:])
    return "\n".join(out)


def render_one(role: dict, body: str, seat_name: str | None) -> str:
    """拼一个 skill 文件：现有 frontmatter（tools 刷新） + content 正文。"""
    key = role["key"]
    zc = role["zcode"]
    files = ROLE_FILES[key]
    # 现有文件：advisor 模板是 agent-advisor.md（name=advisor-A）
    existing = SKILL_DIR / "references" / files[0]
    old_text = existing.read_text(encoding="utf-8")
    front, _old_body = split_frontmatter(old_text)
    if not front:
        raise ValueError(f"{existing} 没有 frontmatter，拒绝改写")

    tools = list(zc["tools"])
    new_front = refresh_tools(front, tools, zc.get("toolsNote"))

    if seat_name is not None:
        # advisor 三席：只换 name 行的值
        new_front = re.sub(
            r'^(name:\s*")[^"]*(")',
            rf"\g<1>{seat_name}\g<2>",
            new_front,
            count=1,
            flags=re.M,
        )

    # 正文：content 原文 + 末尾单换行；frontmatter 与正文之间空一行
    body = body.rstrip("\n") + "\n"
    if not new_front.endswith("\n"):
        new_front += "\n"
    return new_front + "\n" + body


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: python scripts/sync_from_manifest.py <含 content/ 的仓库根> [--write]", file=sys.stderr)
        print(r"  例：python scripts/sync_from_manifest.py F:\AIXM\collab-mode\zcode-collab-publish", file=sys.stderr)
        return 2
    given = Path(sys.argv[1])
    write = "--write" in sys.argv

    # 防呆：传插件目录（含 build.mjs）时，其 content/ 是**构建时拷贝的副本**，
    # 可能落后于仓库根的权威 content/。若误用会静默生成过期的 skill 文件——
    # 这里自动改用仓库根并明确告知，避免"改了源没跑 build"这类静默错误。
    content_root = given
    if (given / "build.mjs").exists() and (given.parent / "content" / "manifest.json").exists():
        print(f"[提示] 传入的是插件目录，其 content/ 是构建拷贝；已自动改用仓库根：{given.parent}")
        content_root = given.parent
    manifest_path = content_root / "content" / "manifest.json"
    if not manifest_path.exists():
        print(f"[错误] 找不到 {manifest_path}", file=sys.stderr)
        return 2
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    roles = {r["key"]: r for r in manifest["roles"]}

    changed: list[str] = []
    # advisor 三席文件
    # advisor 三席由部署步骤拆分（SKILL.md 第 4 步）：references 里只留一份模板
    targets: list[tuple[str, str | None]] = [
        ("agent-executor.md", None),
        ("agent-code-reviewer.md", None),
        ("agent-researcher.md", None),
        ("agent-advisor.md", "advisor-A"),
        ("agent-vision-reader.md", None),
    ]
    key_of = {
        "agent-executor.md": "executor",
        "agent-code-reviewer.md": "code-reviewer",
        "agent-researcher.md": "researcher",
        "agent-advisor.md": "advisor",
        "agent-vision-reader.md": "vision-reader",
    }

    for fname, seat in targets:
        key = key_of[fname]
        role = roles[key]
        body = (content_root / "content" / role["file"]).read_text(encoding="utf-8")
        new_text = render_one(role, body, seat)
        path = SKILL_DIR / "references" / fname
        if not path.exists():
            print(f"[新增] {fname}")
            if write:
                path.write_text(new_text, encoding="utf-8")
            changed.append(fname)
            continue
        old_text = path.read_text(encoding="utf-8")
        if old_text != new_text:
            changed.append(fname)
            if write:
                path.write_text(new_text, encoding="utf-8")
                print(f"[更新] {fname}")
            else:
                print(f"[差异] {fname}")
        else:
            print(f"[一致] {fname}")

    # 产物二：规则文本（v0.4.0 起单一来源，按 zcode 平台渲染）
    rules_file = manifest["rules"]["file"]
    rules_src = content_root / "content" / rules_file
    # 源文本规范化与 build.mjs 的 readContent() 一致：统一 LF、去掉尾部空白、末尾恰好一个换行
    raw = rules_src.read_text(encoding="utf-8").replace("\r\n", "\n").rstrip()
    rendered = render_rules(
        raw,
        "zcode",
        manifest["rules"].get("placeholders", {}),
    ).rstrip("\n") + "\n"
    rules_path = SKILL_DIR / "references" / RULES_OUT
    if not rules_path.exists():
        print(f"[新增] {RULES_OUT}")
        changed.append(RULES_OUT)
        if write:
            rules_path.write_text(rendered, encoding="utf-8", newline="\n")
    elif rules_path.read_text(encoding="utf-8") != rendered:
        changed.append(RULES_OUT)
        if write:
            rules_path.write_text(rendered, encoding="utf-8", newline="\n")
            print(f"[更新] {RULES_OUT}")
        else:
            print(f"[差异] {RULES_OUT}")
    else:
        print(f"[一致] {RULES_OUT}")

    # VERSION 对齐
    vfile = SKILL_DIR / "VERSION"
    old_v = vfile.read_text(encoding="utf-8").strip() if vfile.exists() else ""
    new_v = manifest["version"]
    if old_v != new_v:
        changed.append("VERSION")
        if write:
            vfile.write_text(new_v + "\n", encoding="utf-8")
            print(f"[更新] VERSION {old_v} → {new_v}")
        else:
            print(f"[差异] VERSION {old_v} → {new_v}")
    else:
        print(f"[一致] VERSION {new_v}")

    if not write:
        print(f"\n预览模式：{len(changed)} 个文件有差异（未写入）。加 --write 执行。")
        return 1 if changed else 0
    print(f"\n已写入 {len(changed)} 个文件。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
