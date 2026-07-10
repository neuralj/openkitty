# 必应搜索 MCP 配置说明

本文档指导您配置必应搜索 MCP 服务。

## 获取 MCP URL

1. 访问 [京东云 JoyAgent](https://joyagent.jd.com)
2. 登录后进入"资源"页面
3. 找到"必应搜索"服务，点击"已开通"
4. 在"MCP 服务 URL"区域复制您的专属 URL
5. URL 格式：`https://agentrs.jd.com/mcp/YOUR_TOKEN/sse`

**注意**：URL 包含敏感 token，请勿泄露给他人。

## 配置 MCP

安装本组件后（见 `scripts/install.sh`），MCP 配置会被自动合并进您的 `opencode.jsonc`。你也可以手动编辑该文件，添加如下配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "bing-search": {
      "type": "remote",
      "url": "{env:BING_SEARCH_URL}"
    }
  }
}
```

将 `BING_SEARCH_URL` 环境变量设置为您从京东云获取的实际 URL（含 token）。

## 验证配置

1. 确保 `opencode.jsonc` 中已添加 MCP 配置
2. 启动 OpenCode：`opencode`
3. 在对话中测试搜索功能：
   - "帮我搜索 OpenCode AI 的最新资讯"
   - "查一下 2026 年 AI 芯片市场趋势"

## 计费说明

- 必应搜索按次计费：15 积分/次（0.015 元/次）
- 可在京东云 JoyAgent 平台购买积分
- 余额可自动抵扣 API 调用费用

## 故障排查

### 搜索无响应

- 检查 `opencode.jsonc` 中是否包含 MCP 配置
- 确认 URL 格式正确
- 验证 URL 中的 token 是否有效

### 连接失败

- 检查网络连接
- 确认京东云服务未过期
- 尝试在浏览器中访问 URL 验证连通性

### 配置未生效

- 重启 OpenCode 以重新加载配置
- 检查 JSON 格式是否正确（无语法错误）

## 安全建议

- 将真实 token 放入环境变量，不要写死在配置文件中
- 不要将包含真实 token 的配置文件提交到版本控制系统
- 定期轮换 token（如京东云支持）
- 监控积分使用情况，避免意外消费

## 相关链接

- [京东云 JoyAgent 平台](https://joyagent.jd.com)
- [必应搜索 MCP 文档](https://joyagent.jd.com/docs/bing-search)
- [OpenCode MCP 配置指南](https://opencode.ai/docs/mcp)
