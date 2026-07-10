# 小宿科技智能搜索 MCP 配置说明

## 获取 MCP URL

1. 访问 [京东云 JoyAgent](https://joyagent.jd.com)
2. 登录后进入"资源"页面
3. 找到"小宿科技智能搜索"服务，点击"已开通"
4. 在"MCP 服务 URL"区域复制您的专属 URL
5. URL 格式：`https://agentrs.jd.com/mcp/YOUR_TOKEN/sse`

**注意**：URL 包含敏感 token，请勿泄露给他人。

## 配置 MCP

安装本组件后（见 `scripts/install.sh`），MCP 配置会被自动合并进您的 `opencode.jsonc`。你也可以手动编辑该文件，添加如下配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cloudsway": {
      "type": "remote",
      "url": "{env:CLOUDSWAY_SEARCH_URL}",
      "enabled": true
    }
  }
}
```

将 `CLOUDSWAY_SEARCH_URL` 环境变量设置为您从京东云获取的实际 URL。

## 工具参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| q | String | 是 | 搜索查询词 |
| count | Integer | 否 | 返回结果数量，默认 10，最大 50 |
| offset | Integer | 否 | 偏移量，默认 0 |
| freshness | String | 否 | 时间筛选：Day/Week/Month |
| enableContent | Boolean | 否 | 是否返回长摘要，默认 false |
| contentTimeout | Number | 否 | 长摘要读取超时(秒)，默认 0，最大 10 |
| contentType | String | 否 | 长摘要格式：HTML/MARKDOWN/TEXT(默认) |
| mainText | Boolean | 否 | 是否返回关键片段，默认 false |
| sites | String | 否 | 仅返回指定站点结果（host 格式） |
| blockWebsites | String | 否 | 排除指定站点（host 格式） |

## 计费

- 按次计费：40 积分/次（0.04 元/次）
- 可在京东云 JoyAgent 平台购买积分
