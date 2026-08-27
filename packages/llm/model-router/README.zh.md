# dsh-model-router

可持久化的模型回退路由。恢复决策会写入 `model/route-selected`；下一次 `agent/request` 会使用该供应方/模型，随后普通 `request/header` 继续记录真实请求路由，保证可回放。

只有供应方内部重试放弃后才会进入模型回退；目标供应方必须当前存在已注册适配器，同一步骤也不会重新访问已经尝试过的路由。
