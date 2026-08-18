/**
 * 运行时 @deepseek-ai/dsh-settings 从 Desktop 壳 flat fallback 解析（lib 打包无 .d.ts），
 * 此处提供最小 ambient 声明，仅覆盖本插件用到的 API。
 */
declare module '@deepseek-ai/dsh-settings' {
  /** Brand a raw string as a SettingsNamespace（校验 kebab-case）。 */
  export function settingsNamespace(value: string): string
}
