// Token黑名单（内存Set，重启后清空）
const blacklist = new Set<string>();

// 检查token是否在黑名单中
export function isBlacklisted(token: string): boolean {
  return blacklist.has(token);
}

// 将token加入黑名单
export function addToBlacklist(token: string): void {
  blacklist.add(token);
}
