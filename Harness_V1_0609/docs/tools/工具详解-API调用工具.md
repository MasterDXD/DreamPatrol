# 工具详解-API调用工具

> 版本：2.73.4 | 文件：src/utils/network-utils.js

---

## 模块概述

network-utils是Harness框架的网络安全工具集，提供SSRF（服务器端请求伪造）防护、私有IP检测和本地请求识别能力。该模块从多个安全相关模块（mcp-security、mcp-client、security、server、shared-infrastructure）中抽提合并，确保框架内所有出站网络请求遵循统一的安全策略。

在多Agent协作场景中，Agent可能需要调用外部API（如AI模型服务、MCP工具服务器等），network-utils为这些出站请求提供安全边界，防止Agent通过HTTP请求访问内网资源、云元数据端点或其他受保护的网络区域。

## 导出总览

| 导出 | 类型 | 说明 |
|------|------|------|
| `BLOCKED_HOSTS` | Array\<string\> | 被阻止的主机名列表 |
| `BLOCKED_HOSTS_SET` | Set\<string\> | 被阻止的主机名集合（快速查找） |
| `BLOCKED_HOST_PATTERNS` | Array\<RegExp\> | 被阻止的主机名正则模式 |
| `IPV4_PRIVATE_RANGES` | Array\<Object\> | IPv4私有地址范围定义 |
| `isPrivateIPv4` | Function | IPv4私有地址检测 |
| `isPrivateIPv6` | Function | IPv6私有地址检测 |
| `isPrivateOrReservedIp` | Function | MCP验证变体的私有IP检测 |
| `isPrivateIp` | Function | 通用私有IP检测（IPv4/IPv6） |
| `isLocalRequest` | Function | 本地请求识别 |
| `isBlockedHost` | Function | SSRF主机名阻止检测 |

---

## 被阻止的主机名

### `BLOCKED_HOSTS`

硬编码的被阻止主机名列表，覆盖常见的本地地址和云元数据端点：

| 主机名 | 阻止原因 |
|--------|---------|
| `localhost` | 本地回环 |
| `localhost.localdomain` | 本地回环（FQDN） |
| `127.0.0.1` | IPv4回环地址 |
| `0.0.0.0` | 任意地址绑定 |
| `::1` | IPv6回环地址 |
| `169.254.169.254` | AWS/GCP/Azure云元数据端点 |
| `metadata.google.internal` | GCP元数据端点 |
| `metadata.azure.com` | Azure元数据端点 |
| `100.100.100.200` | 阿里云元数据端点 |
| `fd00:ec2::254` | AWS EC2 IPv6元数据端点 |
| `ip6-localhost` | IPv6本地主机名 |

### `BLOCKED_HOSTS_SET`

基于`BLOCKED_HOSTS`构建的Set集合，用于O(1)复杂度的精确匹配查找。

### `BLOCKED_HOST_PATTERNS`

被阻止的主机名正则表达式模式列表，用于匹配私有IP段的主机名：

| 模式 | 匹配范围 |
|------|---------|
| `/^10\./` | 10.0.0.0/8 A类私有 |
| `/^172\.(1[6-9]\|2\d\|3[01])\./` | 172.16.0.0/12 B类私有 |
| `/^192\.168\./` | 192.168.0.0/16 C类私有 |
| `/^169\.254\./` | 169.254.0.0/16 链路本地 |
| `/^fc[0-9a-f]{2}:/i` | IPv6唯一本地（fc00::/7） |
| `/^fd[0-9a-f]{2}:/i` | IPv6唯一本地（fd00::/8） |
| `/^fe[89ab]:/i` | IPv6链路本地（fe80::/10） |
| `/^::ffff:/i` | IPv4映射的IPv6地址 |
| `/^0\./` | 0.0.0.0/8 当前网络 |
| `/^127\./` | 127.0.0.0/8 回环 |

---

## IPv4私有地址范围

### `IPV4_PRIVATE_RANGES`

IPv4私有/保留地址范围定义，用于高效的数值比较：

| 范围定义 | 匹配的地址段 |
|---------|------------|
| `{ a: 10 }` | 10.0.0.0/8 |
| `{ a: 172, bMin: 16, bMax: 31 }` | 172.16.0.0/12 |
| `{ a: 192, b: 168 }` | 192.168.0.0/16 |
| `{ a: 169, b: 254 }` | 169.254.0.0/16 |
| `{ a: 100, bMin: 64, bMax: 127 }` | 100.64.0.0/10（运营商级NAT） |

---

## IP检测函数

### `isPrivateIPv4(a, b)`

检查IPv4地址的前两个八位组是否属于私有或保留范围。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `a` | number | 是 | 第一个八位组（0-255） |
| `b` | number | 是 | 第二个八位组（0-255） |

**返回值**：`boolean`

**检测规则**：
- 第一八位组为0、127或≥224（组播/保留）时返回`true`
- 遍历`IPV4_PRIVATE_RANGES`进行范围匹配

### `isPrivateIPv6(addr)`

检查IPv6地址是否为私有、回环或保留地址。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `addr` | string | 是 | IPv6地址字符串 |

**返回值**：`boolean`

**检测覆盖**：
- 回环地址：`::1`、`::`、`0:0:0:0:0:0:0:1`、完整形式
- 唯一本地地址：`fc00::/7`（fc和fd前缀）
- 链路本地地址：`fe80::/10`（fe8-feb前缀）
- 文档地址：`2001:db8::/32`
- 丢弃前缀：`0100::/64`

### `isPrivateOrReservedIp(a, b)`

MCP验证变体的私有IP检测，在`isPrivateIPv4`基础上增加基准测试地址范围检测。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `a` | number | 是 | 第一个八位组 |
| `b` | number | 是 | 第二个八位组 |

**返回值**：`boolean`

**额外检测**：198.18.0.0/15和198.19.0.0/16（RFC 2544基准测试地址）

### `isPrivateIp(ip, depth)`

通用私有IP检测函数，同时支持IPv4和IPv6地址。处理IPv4映射的IPv6地址时支持递归解包。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `ip` | string | 是 | — | IP地址字符串 |
| `depth` | number | 否 | 0 | 递归深度保护（最大3） |

**返回值**：`boolean`

**处理逻辑**：
1. 直接匹配常见回环地址（`127.0.0.1`、`0.0.0.0`、`::1`、`::`）
2. IPv4映射的IPv6地址（`::ffff:`前缀）递归解包
3. IPv6唯一本地和链路本地前缀匹配
4. IPv4地址按点分拆后调用`isPrivateIPv4`
5. 递归深度超过3时返回`false`（防止无限递归）

---

## 请求检测函数

### `isLocalRequest(req)`

判断HTTP请求是否来自本地（回环）地址，用于开发模式认证绕过和CORS策略决策。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `req` | http.IncomingMessage | 是 | Node.js HTTP请求对象 |

**返回值**：`boolean`

**检测的IP地址形式**：

| IP形式 | 说明 |
|--------|------|
| `127.0.0.1` | IPv4回环 |
| `::1` | IPv6回环 |
| `localhost` | 主机名字符串 |
| `0:0:0:0:0:0:0:1` | IPv6回环完整形式 |
| `[::1]` | IPv6回环带方括号 |
| `::ffff:127.0.0.1` | IPv4映射的IPv6回环 |
| `::ffff:127.*` | IPv4映射的IPv6回环段 |
| `127.*` | IPv4回环段 |

### `isBlockedHost(hostname)`

检查主机名是否被SSRF防护策略阻止。结合精确匹配和模式匹配实现全面覆盖。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `hostname` | string | 是 | 待检查的主机名 |

**返回值**：`boolean`

**检测流程**：
1. 将主机名转为小写
2. 在`BLOCKED_HOSTS_SET`中精确匹配
3. 遍历`BLOCKED_HOST_PATTERNS`进行正则匹配
4. 任一匹配即返回`true`

---

## 安全策略详解

### SSRF防护体系

```
出站HTTP请求
    │
    ▼
┌─────────────────┐
│  URL解析         │  提取hostname
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  isBlockedHost   │  精确匹配 + 模式匹配
│  (hostname)      │
└────────┬────────┘
         │
    ┌────┴────┐
    │ 通过    │ 被阻止
    ▼         ▼
  DNS解析   拒绝请求
    │
    ▼
┌─────────────────┐
│  isPrivateIp     │  解析后IP验证
│  (resolvedIp)    │
└────────┬────────┘
         │
    ┌────┴────┐
    │ 通过    │ 被阻止
    ▼         ▼
  发送请求   拒绝请求
```

### 双重验证策略

框架采用"主机名+IP"双重验证策略：
1. **主机名验证**：在DNS解析前检查hostname是否被阻止
2. **IP验证**：DNS解析后检查实际IP是否为私有地址

这种策略防止以下攻击：
- 直接使用IP地址绕过主机名黑名单
- DNS重绑定攻击（hostname合法但解析到内网IP）
- IPv4映射的IPv6地址绕过

### 云元数据端点防护

`BLOCKED_HOSTS`包含主流云服务商的元数据端点，防止Agent通过HTTP请求获取云实例的敏感信息（如IAM凭证、实例元数据等）：

| 云服务商 | 端点 | 阻止的地址 |
|---------|------|-----------|
| AWS | EC2元数据 | 169.254.169.254 |
| GCP | 元数据服务 | metadata.google.internal |
| Azure | 元数据服务 | metadata.azure.com |
| 阿里云 | 元数据服务 | 100.100.100.200 |

---

## 使用示例

### MCP客户端出站请求验证

```javascript
const { isBlockedHost, isPrivateIp } = require('./src/utils/network-utils');

function validateOutboundRequest(url) {
  const parsed = new URL(url);
  const hostname = parsed.hostname;

  if (isBlockedHost(hostname)) {
    throw new Error(`SSRF防护: 主机名 ${hostname} 被阻止`);
  }

  return true;
}
```

### Web服务器本地请求识别

```javascript
const { isLocalRequest } = require('./src/utils/network-utils');

function handleRequest(req, res) {
  if (isLocalRequest(req)) {
    console.log('本地请求，允许开发模式访问');
  } else {
    console.log('远程请求，需要完整认证');
  }
}
```

### 完整SSRF防护

```javascript
const dns = require('dns').promises;
const { isBlockedHost, isPrivateIp } = require('./src/utils/network-utils');

async function safeHttpRequest(url) {
  const parsed = new URL(url);

  if (isBlockedHost(parsed.hostname)) {
    throw new Error(`SSRF: 主机名被阻止 - ${parsed.hostname}`);
  }

  try {
    const { address } = await dns.resolve4(parsed.hostname);
    if (isPrivateIp(address)) {
      throw new Error(`SSRF: 解析到私有IP - ${address}`);
    }
  } catch (dnsErr) {
    if (dnsErr.message.startsWith('SSRF')) throw dnsErr;
  }

  return fetch(url);
}
```

### IPv6地址检测

```javascript
const { isPrivateIPv6, isPrivateIp } = require('./src/utils/network-utils');

console.log(isPrivateIPv6('::1'));
console.log(isPrivateIPv6('fc00::1'));
console.log(isPrivateIPv6('fe80::1'));
console.log(isPrivateIPv6('2001:db8::1'));
console.log(isPrivateIp('::ffff:192.168.1.1'));
```

---

## 与框架模块的集成

| 框架模块 | 使用方式 | 说明 |
|---------|---------|------|
| MCPClient | `isBlockedHost` + `isPrivateIp` | MCP工具服务器连接前的SSRF防护 |
| Web Server | `isLocalRequest` | 开发模式本地请求认证绕过 |
| SharedInfrastructure | `isPrivateIp` | 出站连接的安全检查 |
| Security模块 | `isBlockedHost` | 统一的安全策略执行 |

---

## 注意事项

- `isBlockedHost`仅检查主机名，不检查解析后的IP地址，需配合`isPrivateIp`实现双重验证
- `isPrivateIp`对IPv4映射的IPv6地址（`::ffff:`前缀）自动解包，递归深度限制为3
- `isLocalRequest`依赖`req.socket.remoteAddress`，在反向代理后可能获取到代理IP
- 云元数据端点列表需随云服务商更新而维护
- IPv6检测覆盖了常见的私有/保留前缀，但不保证覆盖所有RFC定义的保留范围

## 关联文档

- [工具详解-文件操作工具](工具详解-文件操作工具.md)
- [工具详解-代码搜索工具](工具详解-代码搜索工具.md)
- [核心功能-权限控制与审计](../core/核心功能-权限控制与审计.md)
- [深度拆解-任务调度执行链路](../deep-dive/深度拆解-任务调度执行链路.md)
- [架构分析-AIProject系统](../architecture/架构分析-AIProject系统.md)
