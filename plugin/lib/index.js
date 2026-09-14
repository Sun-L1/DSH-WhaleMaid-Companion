/**
 * DSH Copilot pet — Node half.
 *
 * 这一半是**空的**：不注册工具、不监听事件、不做任何 IO。它的唯一作用是让 Loader
 * 拥有一行合法条目，从而让 client-modules 扫描到本包的 `dsh.client` 声明并把
 * `./client` bundle 作为浏览器半边提供给 shell.overlay。
 *
 * 有意不声明 `inject`：桌宠不依赖任何 host 服务（这同时保证它不会依赖桌面版被禁用的
 * webServer / client-hmr 等行，见 docs/design.md 的迁移一节）。
 */

export const name = 'ui-pet'

/** Node-side plugin body: intentionally empty. */
export function apply() {}
