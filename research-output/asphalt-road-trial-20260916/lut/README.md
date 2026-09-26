# 道路 DFG 全域试用查表

此目录由独立编写的 `build-road-dfg.py` 生成。没有导入或执行外部研究包的脚本。

交付 `src/data/road-dfg-lut.json`，并在本目录保留相同JSON、RG16F二进制和详细CPU验证。用于当前开发入口试用，不表示生产GPU视觉/性能验收完成。

## 集成接口：横轴必须先 sqrt

- width=height=256；每texel两个通道A、B。
- `type: "float16"`；`base64`是**小端IEEE half位模式**，不是归一化整数；配 `Uint16Array + THREE.HalfFloatType`。
- 物理域完整覆盖NdotV与perceptual roughness的 `[0,1]`，没有有限域条件分支或旧公式回退。
- **存储横轴为sqrt(NdotV)，纵轴为perceptual roughness。** 用更多横轴分辨率保留驾驶掠射角；不能把它按均匀NdotV读取。
- 第一/最后网格点在texel中心，使用半texel偏移；row0为roughness0、最后一行为roughness1。

```js
const data = Uint8Array.from(atob(payload.base64), c => c.charCodeAt(0));
const view = new DataView(data.buffer);
const halfBits = new Uint16Array(data.length / 2);
for (let i = 0; i < halfBits.length; ++i) halfBits[i] = view.getUint16(i * 2, true);
const lut = new THREE.DataTexture(halfBits, payload.width, payload.height,
  THREE.RGFormat, THREE.HalfFloatType);
lut.minFilter = lut.magFilter = THREE.LinearFilter;
lut.wrapS = lut.wrapT = THREE.ClampToEdgeWrapping;
lut.flipY = false;
lut.generateMipmaps = false;
lut.colorSpace = THREE.NoColorSpace;
lut.needsUpdate = true;
```

DFG查表仅需一次硬件双线性采样：

```glsl
vec2 q = vec2(sqrt(clamp(dot(normal, viewDir), 0.0, 1.0)),
              clamp(roughness, 0.0, 1.0));
vec2 uv = (q * vec2(255.0) + vec2(0.5)) / vec2(256.0);
return texture2D(roadDFGLut, uv).rg;
```

组合仍为 `F0*A + F90*B`。表只包含单次散射系数；保留r180已有computeMultiscattering，不再叠第二份补偿。

## 模型与边界约定

- GGX alpha=perceptual roughness²。
- height-correlated Smith；VNDF重要性权重使用相关G2/G1，**不是独立G1(L)**。
- Fresnel使用r180的 `exp2((-5.55473*VoH-6.98316)*VoH)`，不是另一个pow5版本。
- roughness=0使用解析光滑镜面极限；NdotV=0的粗糙表面使用正掠射 `1e-5` 近似，具体写入JSON。
- 使用稳定的解析VNDF权重，没有模拟直接光shader的 `max(visibilityDenominator,1e-6)` 数值截断。这个截断在极小NdotV/低roughness处可以改变结果，验证文件单独列出了差别；不应把该数值保护当作物理模型定义。实用道路验证域与极端边界分别报告。
- 先float64积分再量化成half；若独立rounding令A+B略超过1，则把较大系数下调一个half步进，直到满足A+B≤1。这也保证任意硬件双线性插值不会违反A/B非负和单次能量上限。

## 验证内容与边界

每texel使用8192个平移Hammersley VNDF样本。验证使用独立平移、524288样本参照，并与另一262144样本参照比较收敛；高粗糙度再用独立入射方向Gauss–Legendre积分交叉检查。

`road-dfg-validation.json`区分全域离散点、r≥.0525且NdotV≥.001的实用道路域、r≥.6的高粗糙域。包含半精度量化、球面积分检查、参考采样差、逐点误差和边界值。离散误差不是连续域严格上界；相机运动和目标GPU实际纹理采样仍由主任务验证。

本次生成结果：

| 验证 | 结果 |
|---|---:|
| 表大小 | 256×256 RG16F，262144 bytes（256 KiB） |
| 全域154个离散点最大F0=.04相对误差 | 2.0652% |
| 最差点 | r=.005，NdotV=.00001，极低粗糙度且几乎完全掠射 |
| 实用道路域97个点最大相对误差 | **0.08473%** |
| 高粗糙度46个点最大相对误差 | **0.08473%** |
| 两组独立高样本参照最大相对差 | 0.002204% |
| 所有texel | 有限、A/B≥0、A+B≤1 |

与之前r=.837半球积分对照：NdotV=1/.5/.1，新表单次项分别为 `.02047601 / .03014283 / .07133889`，独立球面积分为 `.02047454 / .03014353 / .07133229`。高粗糙度参照与上轮计算吻合。

JSON base64、独立二进制与SHA逐字节交叉检查通过。二进制SHA-256：`0151b271d219cb2d47ef155e991da2097dc54b3cfa1db487af3243fdef8e8cb7`。

参考：[Heitz 2018 GGX VNDF原论文](https://jcgt.org/published/0007/04/01/paper.pdf)、项目本地Three r180 `lights_physical_pars_fragment.glsl.js` 与 `common.glsl.js`。
