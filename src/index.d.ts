import type { Context } from "@deepseek-ai/cordis";
import type { Model } from "@deepseek-ai/schemastery";

/** 插件配置。 */
export interface BridgeConfig {
  /** history 响应体大小上限（字节）；超出部分截断并标记 truncated。 */
  maxBufferedText?: number;
  /** 可选共享密钥：设置后，除 /status 外的所有接口要求 Bearer token（HTTP）或 ?token=（WS）。 */
  token?: string;
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
