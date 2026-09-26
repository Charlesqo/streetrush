#!/usr/bin/env python3
import pathlib,json,collections
ROOT=pathlib.Path(__file__).resolve().parents[1]
def read(p):return json.loads((ROOT/p).read_text())
c=read('catalog.json');refs=read('vehicles/references.json')
manual=[
dict(priority='P1',title='Herutsu · Isolated Tire Skids',price='US$45 未税 · 22文件 / 472MB',url='https://www.asoundeffect.com/sound-library/isolated-tire-skids/',use='独立干沥青滑移；商家明确无引擎声、车内/车外机位，优先听。',gap='来源车Taycan/GT86；不是六车专属胎声，轻滑/循环/湿路需另核实。'),
dict(priority='P1',title='Pole · Skids & Screeches Tarmac',price='US$199 · 154片段 / 7.27GB（厂商页）',url='https://pole.se/product/skids-screeches-tarmac-library/',use='干湿路滚动与滑移、轮边/车内/外部，覆盖比单一尖叫全面。',gap='部分录音有引擎；不能整包标无串音。购买前确认不同商城的文件数差异。'),
dict(priority='P1',title='Pole · Aventador LP700-4 2014',price='Spotting US$99 · Complete US$249',url='https://pole.se/product/lamborghini-aventador-2014/',use='最接近目标车型的采购线索；原始take同步发动机/排气/车内，steady/ramp/shift。',gap='不是2011录音。厂商286文件31.4GB与商城366文件27.48GB冲突；先确认版本。'),
dict(priority='P2',title='Pole · Wind in Car',price='US$5 · 56文件 / 1.56GB',url='https://pole.se/product/wind-in-car/',use='不同强度车窗风，优先补开窗气流。',gap='不代表封闭舱/敞篷或精确风速；不能用环境树叶风冒充。'),
dict(priority='P2',title='BOOM · ROAD RAGE',price='From US$139 · 版本以选择后为准',url='https://www.boomlibrary.com/sound-effects/road-rage/',use='碰撞品质参照；Construction Kit按材料、部件与强度组织。',gap='全包未取得，EULA全文本轮未存；轻擦/重撞需分开选，听感待验。'),
dict(priority='P2备选',title='Pole · Car Debris, Impacts & Crashes',price='US$199',url='https://pole.se/product/car-debris-impacts-crashes/',use='实车擦碰、碎玻璃与中大撞击，内外机位。',gap='厂商说明车内录音左声道有间歇问题；应试听后再购买，不能统一当完美素材。'),
dict(priority='P3',title='Sonic Bat · Racing Vehicles Pass-By (Binaural Stereo)',price='US$50 · 48长录音 / 页面列57.4GB',url='https://sonniss.com/sound-effects/binaural-stereo-racing-vehicles-pass-by-bundle/',use='场地远车、通过与比赛背景，普通立体声路线。',gap='多车型/可能广播，不是AMG GT3单车音轨；大包不自动下载。'),
dict(priority='跨版参照',title='Sweet SFX · Porsche 992 GT3',price='Short & Sweet £79 · Standard £199 · Ultimate询价',url='https://www.sweetsfx.com/product/porsche-992-gt3/',use='文件表中的进气/机械接触/排气/车内适合分层研究；免费样本包也已定位。',gap='普通GT3手动，不是GT3 RS PDK；不推荐为RS直接买来替代。'),
dict(priority='跨代参照',title='Soundholder · MX5 NBFL 1.6 Stock',price='主商品页US$70；促销页可能不同',url='https://sonniss.com/sound-effects/mazda-miata-mx5-nbfl-1-6-stock/',use='149文件，状态结构较完整；可比较原厂/改装版本，借鉴取材结构。',gap='NBFL不是NA；Designed是混音，不能等同于独立原轨。'),
dict(priority='免费/手动',title='Sweet SFX · Free Sample Volume One',price='£0 · 99 WAV / 2.2GB压缩包',url='https://www.sweetsfx.com/product/sweet-sfx-free-sample-volume-one/',use='已定位具体免费包与文件表；通过原站订单/账号下载。',gap='本轮未取得音频，超过小批下载预算；免费不等于无限制许可，免费包与EULA适用范围待确认。'),
]
gaps=[dict(title=v['name'],body=v['priority']) for v in read('vehicles/profiles.json')]+[
dict(title='轮胎与路面',body='已收干路滑移候选；轻滑、干净的速度分层滚动、湿路/草地/砂石仍未完整。砂石/石面文件为脚步设计原料，不能声明已补齐实车路面。'),
dict(title='风与场地',body='环境风/鸟/交通已收；封闭舱气动噪声、敞篷高速气流和真实户外比赛观众仍缺。室内掌声与军队式喊声已从首选剔除。'),
dict(title='底盘、碰撞与反馈',body='已收通用机械/金属/玻璃和一套UI候选，听感均待验证。没有六车真实悬挂、材料和碰撞强度分层，也未统一完成反馈音色。'),
dict(title='时间点如何读',body='作者章节与本地编排时间可以核实。视频建议窗口不等于已确认音频事件；没有可信章节就标待定位，不虚构油门/换挡发生在哪一秒。'),
dict(title='许可与发布',body='原始下载、CC署名、购买记录是三个不同层次。商业demo/网络视频只作参照；付费库需购买并符合席位与分发条款后才谈游戏使用。'),
dict(title='技术验收边界',body='预览解码、哈希与时长检查只证明文件可用来继续评估。人耳试听、车型相似度、完整循环接缝和未来游戏混音均NOT_RUN。')]
parked=[]
for item in c['parked']:
    x=dict(item);x['recommended_use']=x['editorial_reason'];x['preview_path']=None;parked.append(x)
data=dict(shared=c['items'],vehicles=read('vehicles/profiles.json'),references=refs,manual=manual,gaps=gaps,parked=parked,cues=read('previews/shared-review-v2.cues.json'))
(ROOT/'reports/manual-shortlist.json').write_text(json.dumps(manual,ensure_ascii=False,indent=2)+'\n')
html=(ROOT/'tools/review-template.html').read_text().replace('__DATA__',json.dumps(data,ensure_ascii=False).replace('</','<\\/'))
(ROOT/'index.html').write_text(html)
counts=collections.Counter(x['category'] for x in c['items'])
readme=f'''# StreetRush 声音研究与收集交付

独立目录：`research-output/audio-20260907`。2026-09-07完成本轮研究与有界收集；没有修改游戏代码或生产资源，没有接入、购买或对外发消息。用户确认不要求误粘贴的模型/材质制作，也理解本环境无法主观试听。

**从 [声音资料室 index.html](index.html) 开始**：本地音频、原始/预览比较、六车档案、关键参考、手动获取和缺口在一起。没有自动播放或远程播放器，参考链接复用单个窗口。浏览器可记录采用/拒绝理由并导出JSON。

## 实际交付

- 6份逐车档案：核对目标身份、动力、传动、工况、录音位置及不能混用的版本。
- 共用资源采集44条，经过第二轮编辑筛选保留**{c['selected_count']}条首选候选**，另有**{c['parked_count']}条未入选**保留原件；首选含设计原料，不能等同于{c['selected_count']}条成品游戏声音。
- {c['selected_count']}份本轮技术预览WAV；1条按固定时间编排的第二版素材走查音频与对应cue表（首版亦保留）。重采样/衰减/裁切只发生在工作副本，原始ZIP/7z/音频不改。
- {len(refs)}条关键参考，含1份已经保存的Miata公开HQ预览（CC BY4.0、年款未知、不是原始文件）。其余商业demo/实车视频保留原站链接，不把观看权当作游戏授权。
- 厂家来源索引、商业文件表和EULA副本、价格/交付版本冲突、10项优先手动获取资源、署名表、机器可读JSON/CSV和预览变更记录。

**目前没有任何一辆车获得准确目标版本、完整多负载多机位且已验证可用的发动机套库。** 这一项仍为 `SKIP_TARGET_DATA`。LP700已找到同款不同年、值得优先试听采购的来源；其它车已留下明确参照与下一步获取路线。没有用通用发动机补成假“六车齐全”。

## 首选候选分布

| 类别 | 数量 | 解释 |
| --- | ---: | --- |
'''
for cat,n in counts.items():readme+=f'| {cat} | {n} | 主观听感待验证；用途与限制见catalog |\n'
readme+='''
## 文件入口

| 文件/目录 | 内容 |
| --- | --- |
| [catalog.json](catalog.json) / [catalog.csv](catalog.csv) | **最终编辑首选**、未入选原因、许可、实际文件与预览区间；优先使用此表 |
| [vehicles/profiles.json](vehicles/profiles.json) | 六车身份与声音需求矩阵 |
| [vehicles/references.json](vehicles/references.json) / [reference-cues.csv](vehicles/reference-cues.csv) | 参照链接、关键段落/建议窗口及时间点核实等级 |
| [手动获取清单](reports/MANUAL_ACQUISITION.zh-CN.md) | 具体商品、推荐理由、适用范围、价格、操作步骤和询价文字（未发送） |
| [品质参照与缺口](reports/QUALITY_AND_GAPS.zh-CN.md) | 选定作品、已达到的部分、差距、状态语义 |
| [预览走查](previews/shared-review-v2.wav) / [时间表](previews/shared-review-v2.cues.json) | 本轮真实文件编排的短音频；不是游戏混音或车型demo |
| [预览技术验证](reports/PREVIEW_VERIFICATION.zh-CN.md) / [处理参数](reports/preview-processing.json) | 样本峰值、时长、衰减、裁切、SHA256；不含主观听感判断 |
| [署名表](ATTRIBUTION.zh-CN.md) | CC0/CC BY具体作者和来源；Miata预览额外署名见下 |
| shared/originals/ | 原始公开下载文件及完整小型ZIP/7z |
| shared/previews/selected/ | 从原始包中挑出的未再处理成员，提取命令留档；不把整个包都称为精选 |
| previews/audition/ | 本轮新制作的技术预览副本 |
| [车辆商品获取报告](vehicles/acquisition/REPORT.zh-CN.md) / [获取台账](vehicles/acquisition/catalog.json) | 原始商品PDF/HTML、许可、手动下载阻塞和Miata HQ预览 |
| [共用采集原账](shared/catalog.json) / [共用采集报告](shared/REPORT.zh-CN.md) | 初轮44项与原始采集记录，包含后续未入选项；**不覆盖最终编辑筛选** |
| [来源索引](evidence/sources.json) / [项目身份只读快照](evidence/project-identity-snapshot.json) | 事实与证据范围，不是新的车辆版本决定 |
| tools/ | 可复现建表、预览处理及静态资料室构建脚本 |

## 最值得先看的三项

1. [Herutsu Isolated Tire Skids](https://www.asoundeffect.com/sound-library/isolated-tire-skids/)：US$45未税，厂家称独立胎声；先确认轻滑、重滑与循环潜力。
2. [Pole Aventador 2014](https://pole.se/product/lamborghini-aventador-2014/)：Complete US$249，先听同take engine/exhaust/cabin；这是2014 LP700-4，不是2011准确录音。保留厂商和商城文件数差异。
3. [Porsche官方992 GT3 RS整圈](https://newsroom.porsche.com/en_US/2022/products/porsche-911-gt3-rs-dream-lap-nuerburgring-nordschleife-30037.html)：只作声学状态参照；普通992 GT3手动库不能顶替RS PDK。

MX-5年款/市场仍未冻结；AMG GT3要保留赛事BoP和消音配置；M5 G90需S68涡轮、混动电驱、纯电/发动机过渡及车内声效开关，不能以F10/F90补齐。

## 本地预览与复现

直接用浏览器打开index.html即可（数据已内嵌）。若所在浏览器限制本地音频，可在本目录运行一个本地服务：

```sh
python3 -m http.server 8766 --bind 127.0.0.1 --directory /Volumes/Storage/streetrush/research-output/audio-20260907
```

然后打开 http://127.0.0.1:8766/ 。服务只读取本研究目录；与游戏服务无关。

不必重跑所有检查。若修改源选项，才依次运行tools/build_research.py、tools/prepare_previews.py、tools/finalize_delivery.py、tools/build_review.py；处理参数和脚本均保留。原始素材只读使用。

Miata HQ预览的额外署名：**Miata Start and Stop.mp3 — TurboTheSergal**，来源 https://freesound.org/people/TurboTheSergal/sounds/523351/ ，[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。本轮保存公开转码预览，未修改；原始320kbps文件需登录下载。无法确认NA1.6身份。

所有主观听感统一 `LISTENING_NOT_RUN`。源账中的ffprobe `DECODE_OK`只表示容器/编解码信息可读；本轮新增ffmpeg检查覆盖预览区间，不承诺长源文件每一帧或真实峰值都已验证。时间表里的原作者章节、本地编排时点、建议抽查窗口严格分开。
'''
(ROOT/'README.zh-CN.md').write_text(readme)
print('Built standalone review page and delivery README. Selected:',c['selected_count'])
