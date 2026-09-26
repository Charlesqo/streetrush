# StreetRush 材质预览库（glm-materials-20260905-084701）

生成时间：2026-09-05 ｜ 状态：**已完成并通过校验**

## 用途
供下一轮直接挑选 StreetRush 道路 / 草地材质的本地预览库。
颜色图预览是**未修改的贴图副本**，不代表含法线 / 粗糙度 / 位移参与渲染的完整材质效果。

## 打开方式
用浏览器直接打开 `index.html`（纯静态、零外链、数据内嵌，file:// 双击即可用）。

## 素材源（只读，未改动）
`/Volumes/Charles/下载/赛车游戏 材质/`
（源目录共 4 种材质 × 多分辨率档：road_asphalt_rh0ribp0、asphalt_crack_ugcmfivcw、cracked_asphalt_tjmgfelew、lawn_grass_tkynejer）

## 目录结构
- `index.html`：预览库入口（卡片浏览 / 分类筛选 / 候选对比 / 配套贴图详情 / 原始 ZIP 路径与 SHA256）
- `manifest.json`：原包、解压文件、通道含义与确认依据、用途、缺失项、同素材其他分辨率档
- `extracted/<set>/`：四个 1k_ue_low ZIP 的原样解压（Textures/、gltf、bin、元数据 json）
- `previews/<set>/`：选定的一组 1K 贴图（1024×1024），按角色命名：`basecolor__*` / `basecolor-opacity__*` / `normal__*` / `orm-ao-rough-metal__*`
- `tools/extract.py`：安全解压（拒绝绝对路径与 `..` 成员、逐成员校验落盘路径、不覆盖已有文件）
- `tools/build.py`：manifest + 预览 + index.html 生成器（可重复运行）
- `verify/verify.py` + `verify/verify-result.json`：路径 / 哈希 / 引用校验

## 处理结果（4 套，全部 1024×1024）
| 中文名 | id | 类别 | 贴图 | 备注 |
|---|---|---|---|---|
| 道路沥青 | rh0ribp0 | 道路 | B / N / ORM | 平铺 0.39m，最高档 4K |
| 沥青裂纹贴花 | ugcmfivcw | 道路 | B-O(带α) / N / ORM | BLEND 透明贴花，不可平铺，最高档 8K |
| 开裂沥青 | tjmgfelew | 道路 | B / N / ORM | 平铺 2m，最高档 8K |
| 草坪草地 | tkynejer | 草地 | B / N / ORM | 平铺 2m，最高档 8K |

通道识别以包内 glTF 绑定为权威依据：`_B`=baseColor、`_N`=normal（OpenGL +Y）、`_ORM`=R:AO / G:粗糙度 / B:金属度（glTF 2.0 约定）；`_B-O` 的 A=不透明度（BLEND + PNG 实测含 α）。三项均为「已确认」，其余不确定处逐项标注「未确认」。

## 校验（全部 PASS，见 verify/verify-result.json）
- manifest 32 条相对路径全部存在、无越界；4 个原 ZIP SHA256 复核一致
- index.html 内嵌数据可解析，其中所有 previews/…、extracted/… 路径存在
- 真实浏览器实测：页面渲染正常，颜色图 4/4、详情弹窗配套贴图、对比弹窗 2/2 全部解码（naturalWidth>0）；分类筛选、对比选择、坐标点击均正常
- 页面零外网引用

## 未确认 / 待办
1. **许可未确认**：各元数据 JSON 均无 license 字段；格式特征指向 PolyHaven（默认 CC0）但未经证实，**入库游戏前必须联网核实**。
2. 混凝土类候选：源目录不存在，如需要需另行获取。
3. asphalt_crack / cracked_asphalt 的元数据 averageColor 为 #000000（疑似透明/图集导致），已标「未确认」。
4. 2K/4K/8K/exr 档仅记录路径未解压（见 manifest 各 set 的 siblingZips），下一轮选定后可直接取用。
5. ORM 为 JPEG 存储，通道可能有压缩串扰；法线 UE(DirectX) 与 glTF(OpenGL) 的 G 通道方向需在导入时复核——两者都已在 manifest/页面标注「未实测」。

## 复现
```bash
python3 tools/build.py     # 重新生成 manifest/预览/index
python3 verify/verify.py   # 校验
```
