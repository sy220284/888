# Observation Import Dedup 回归 Fixture

目标：固定“逻辑观测次数”和“物理内容去重”之间的边界。

输入：

- `observations/first.png`
- `observations/second.png`

两张图片文件名不同，但二进制内容完全一致。

预期：

- Observation = 2
- Physical Artifact = 1
- Analyze Job = 2
- 每个 Analyze Job 都持久化 observation_id / artifact_id
- 原始图片 Artifact 标记为 ORIGINAL_IMAGE

这个 Fixture 用于防止未来把“内容去重”错误扩散成“观测去重”。
