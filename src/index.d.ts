import type { Context } from "@deepseek-ai/cordis";
import type { Model } from "@deepseek-ai/schemastery";

/** 插件配置。 */
export interface BridgeConfig {
  /** history 响应体大小上限（字节）；超出部分截断并标记 truncated。 */
  maxBufferedText?: number;
  /** 可选共享密钥：设置后，除 /status 外的所有接口要求 Bearer token（HTTP）或 ?token=（WS）。 */
  token?: string;
  /** agentDefaultModel 服务缺失（或尚未选择）时回退使用的 provider 路由。 */
  fallbackProvider?: string;
  /** agentDefaultModel 服务缺失（或尚未选择）时回退使用的模型。 */
  fallbackModel?: string;
  /** 可选：把桥接接口额外暴露到指定地址（如 "0.0.0.0:3081"），仅 /dsh-bridge/*，需配 token。 */
  lanListen?: string;
  /** 百花服务运维（bh CLI）入口；留空禁用运维端点与工具。 */
  bhCommand?: string;
  /** 百花 Vault 服务地址（知识库检索/笔记）。 */
  vaultUrl?: string;
  /** 百花 Family 服务地址（家庭数据）。 */
  familyUrl?: string;
  /** 百花 WebUI 服务地址（“打开百花”入口自动登录用）。 */
  webUrl?: string;
  /** ComfyUI 服务地址（出图工具）。 */
  comfyUrl?: string;
  /** ComfyUI 默认 checkpoint。 */
  comfyCheckpoint?: string;
}

/** 插件名（Cordis 约定）。 */
export declare const name = "dsh-baihua-bridge";

/** 需要注入的 DSH 服务。 */
export declare const inject: readonly ["agents", "sessions", "webServer", "tools"];

/** 配置描述。 */
export declare const Config: Model<BridgeConfig>;

/**
 * Cordis 插件入口：在 DSH webServer 上注册桥接 HTTP / WebSocket 路由，
 * 配置 lanListen 时额外暴露仅 /dsh-bridge/* 的局域网服务；配置 bhCommand 时
 * 注册百花服务运维端点与工具。
 * @param ctx - 插件上下文。
 * @param config - 插件配置。
 */
export declare function apply(ctx: Context, config: BridgeConfig): void;
