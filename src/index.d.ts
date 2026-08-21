import type { Context } from "@deepseek-ai/cordis";
import type { Model } from "@deepseek-ai/schemastery";

/** 插件配置。 */
export interface BridgeConfig {
  /** WebSocket 单连接缓冲上限（字节）。 */
  maxBufferedText?: number;
}

/** 插件名（Cordis 约定）。 */
export declare const name = "dsh-baihua-bridge";

/** 需要注入的 DSH 服务。 */
export declare const inject: readonly ["agents", "sessions", "agentDefaultModel", "webServer"];

/** 配置描述。 */
export declare const Config: Model<BridgeConfig>;

/**
 * Cordis 插件入口：在 DSH webServer 上注册桥接 HTTP / WebSocket 路由。
 * @param ctx - 插件上下文。
 * @param config - 插件配置。
 */
export declare function apply(ctx: Context, config: BridgeConfig): void;
