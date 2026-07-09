# OpenKitty

OpenCode 插件集合。

## 安装

```bash
git clone https://github.com/neuralj/openkitty ~/Developer/repos/openkitty
cd ~/Developer/repos/openkitty
npm install
npm run build
```

## 使用

在 `opencode.jsonc` 中引用插件：

```jsonc
{
  "plugin": [
    "~/Developer/repos/openkitty/dist/plugins/cooldown-guard.js"
  ]
}
```

## 更新

```bash
cd ~/Developer/repos/openkitty
git pull
npm install
npm run build
```

## 开发

```bash
# 编辑 src/plugins/*.ts
npm run build
# 测试插件
```

## 目录结构

```
openkitty/
├── src/plugins/     # TypeScript 源码
├── dist/plugins/    # 编译产物
└── package.json
```
