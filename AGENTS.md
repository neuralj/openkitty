# AGENTS.md — OpenKitty

OpenCode 插件仓库。

## 命令

```bash
npm run build          # 编译 TS → dist/
npm run typecheck      # 类型检查
```

## 目录结构

| 目录 | 用途 |
|------|------|
| `src/plugins/` | TypeScript 插件源码 |
| `dist/plugins/` | 编译产物（提交到仓库） |

## 开发规范

- 插件使用 TypeScript 编写
- 导出函数命名：`XxxPlugin`（如 `CooldownGuardPlugin`）
- 每个插件一个文件
- 编译产物 `dist/` 由 GitHub Actions 自动提交

## 插件引用

使用绝对路径引用编译后的 JS 文件：

```jsonc
{
  "plugin": [
    "/Users/travis/Developer/repos/openkitty/dist/plugins/xxx.js"
  ]
}
```
