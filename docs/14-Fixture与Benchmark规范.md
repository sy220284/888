# 14 Fixture 与 Benchmark 规范

## 1. 目标

888 的效果依赖真实 3D 数据，因此 Fixture 与 Benchmark 是项目长期能力资产。

测试素材必须可重复、可版本化、可比较。

## 2. Fixture 分类

### S1 连续单房间

验证：

- Matching
- SfM
- Camera
- MVS
- Splat

### S2 跳跃单房间

验证：

- Anchor
- Entity Re-ID
- Hypothesis

### S3 多房间

验证：

- Zone
- Portal
- Topology

### S4 室内 + 室外有共享锚点

验证：

- Indoor / Outdoor relation

### S5 室内 + 室外无共享视觉

验证：

- 多假设
- 未知表达
- Generated transition

### S6 多楼层

验证：

- Height
- Stair
- Floor relation

### S7 单图

验证：

- 单图初始化
- Generated 标记

### S8 视频

验证：

- 关键帧
- 连续 Pose

### S9 差素材

验证：

- 模糊
- 过曝
- 低清
- 降级策略

### S10 联想与零重叠求证

验证：

- Associative Proposal Recall / Precision
- Weak Association
- 多假设
- 联想 → 求证
- Next Best View
- False High-confidence Association

### S11 反联想干扰

构造外观很像但实际不同的房间 / 家具 / 门窗，验证系统不会因为相似度高就错误合并。

### S12 AI Conformance

同一组任务分别运行不同模型，验证：

- Schema Compliance
- Tool Calling
- Evidence Citation
- Unsupported Claim
- False Verified Attempt
- Confidence Calibration
- Provider Error Normalization

### S13 严谨性 / 创意性平衡

同一高不确定场景分别使用 STRICT、BALANCED、EXPLORATORY：

- STRICT 应更稳定、更少候选。
- EXPLORATORY 应产生更高候选多样性。
- 三种模式的 Verified 准入门槛必须相同。
- EXPLORATORY 的有效新 Proposal 应高于 STRICT。

---

## 3. Fixture 目录结构

```text
testdata/
└─ s1-room-continuous/
   ├─ manifest.yaml
   ├─ observations/
   ├─ ground_truth/
   ├─ expected/
   └─ README.md
```

## 4. manifest.yaml

至少记录：

- fixture_id
- version
- category
- source
- license
- observation_count
- expected_capabilities
- ground_truth_available
- required_gpu
- notes

## 5. Ground Truth

可能包含：

- Camera Pose
- Intrinsics
- Metric Scale
- Point Cloud
- Mesh
- Zone Label
- Portal
- Anchor Match
- Entity Identity
- Expected Hypothesis

不是所有 Fixture 都必须有全部真值。

## 6. expected

保存稳定的结构性预期，不保存容易漂移的每个浮点值。

例如：

- 最少成功注册相机数
- 最大 reprojection error
- Zone 数
- Portal 关系
- 禁止 false merge 的实体
- 应保留的 Hypothesis 数

## 7. 大文件存储

大型原图、视频、Splat、模型：

- 不直接无控制地提交 Git。
- 使用外部对象存储 / Release Artifact / LFS（确定后统一）。
- manifest 保存 Hash 与下载位置。

测试运行前校验 Hash。

## 8. 数据许可

每个 Fixture 必须标记来源与许可。

不明确许可的数据不能进入公开仓库测试集。

## 9. Fixture 版本

修改 Fixture 时增加版本。

禁止悄悄替换原图而保持同一版本。

## 10. Benchmark 输出

统一机器可读结果：

```json
{
  "fixture_id": "s1-room-continuous",
  "fixture_version": 1,
  "commit": "...",
  "device_profile": "STANDARD_24GB",
  "metrics": {},
  "timings": {},
  "resources": {}
}
```

## 11. Benchmark 指标

### 几何

- Reprojection Error
- Camera Error
- Depth Error
- Chamfer
- Completeness

### 语义

- Anchor Precision / Recall
- Entity False Merge
- Portal Precision / Recall
- Zone Accuracy

### AI 兼容层

- Model Conformance Score
- Schema Compliance
- Tool Calling Success
- Evidence Citation Accuracy
- Unsupported Claim Rate
- Calibration Error
- Proposal Diversity
- Useful Novel Proposal Rate

### 世界推理

- Hypothesis ranking
- Proposal Recall / Precision
- Useful Hypothesis Rate
- False High-confidence Association
- Evidence Conversion Rate
- Conflict resolution
- Confidence calibration

### 质量闭环

- Error detection accuracy
- Repair success rate
- Error before / after

### 性能

- runtime
- RAM
- VRAM
- disk
- provider cost

## 12. Baseline

每个 Milestone 保存一份 Baseline。

新 PR 与最近稳定 Baseline 比较。

禁止只看“当前测试通过”，还要看质量是否退化。

## 13. 回归阈值

阈值分：

- HARD_FAIL
- WARNING
- INFORMATIONAL

例如：

- False Entity Merge 增加 → HARD_FAIL
- 运行时间 +5% → WARNING
- 输出模型体积变化 → INFORMATIONAL

## 14. Bug Fixture

真实 Bug 修复后，建立最小化 Bug Fixture。

命名：

```text
regression/<issue-or-date>-<short-name>/
```

长期保留。

## 15. 随机性

涉及随机模型时：

- 固定 seed（可行时）。
- 记录模型版本。
- 使用区间 / 分布指标。
- 不能要求像素级完全一致。

## 16. Benchmark Runner

最终由统一命令运行：

```bash
just benchmark
just benchmark s1-room-continuous
```

输出到机器可读目录，不污染正式项目数据。

## 17. AI 开发要求

AI 修改算法前必须：

1. 确认相关 Fixture。
2. 记录旧 Baseline。
3. 修改。
4. 运行相同 Benchmark。
5. 对比。
6. 说明改善与退化。

没有同条件对比，不得宣称算法效果提升。
