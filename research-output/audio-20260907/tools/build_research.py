#!/usr/bin/env python3
"""Build the independent sound-research catalog. No production files are modified."""
import json, pathlib, hashlib, csv
ROOT = pathlib.Path(__file__).resolve().parents[1]
PROJECT = ROOT.parents[1]
def save(path, data):
    p=ROOT/path; p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')

sources = [
 ('S01','BMW Group Classic','BMW M3 (E30)','https://www.bmwgroup-classic.com/en/models/bmw-classics/product-description-page.ad-239-1.bmw-m3-e30.html','厂家页面核实 S14B23 2302cc；200hp无催化、195hp有催化及后期215hp不可混用。'),
 ('S02','BMW M','The BMW M3 E30','https://www.bmw-m.com/en/topics/magazine-article-pool/bmw-m3-e30-portraet.html','厂家车型历史；Sport Evolution 2.5L属于不同版本。'),
 ('S03','Mazda','MX-5 (1989–), A linear driving feel','https://www.mazda.com/en/about/history/greatcar/roadster/03/','厂家确认早期1.6L DOHC直四自然吸气，没有涡轮或机械增压；未解决本项目市场/年款混用。'),
 ('S04','Porsche Newsroom','Purpose-built for performance: the new Porsche 911 GT3 RS','https://newsroom.porsche.com/en_US/2022/products/porsche-911-gt3-rs-world-premiere-29439.html','992 GT3 RS 4.0L自然吸气水平对置六缸、独立节气门、7速PDK；美制hp与欧制PS不可直接当成版本差。'),
 ('S05','Porsche Newsroom','992 911 GT3 RS Press Kit','https://newsroom.porsche.com/dam/jcr%3A46a23375-e7ee-4507-a577-d9761b784d33/992%20911%20GT3%20RS%20Press%20Kit%201.pdf','厂家文件确认9000rpm上限、进气位置和7速PDK；本轮仅网页提取内容用于资料核对。'),
 ('S06','Mercedes-AMG','The Mercedes-AMG GT3','https://www.mercedes-amg.com/en/mercedes-amg-gt3','2019发布的后继型号；标称6.3L实际6208cc自然吸气V8、6速序列式后置变速箱。'),
 ('S07','Lamborghini','Lamborghini V12: an engine that made history','https://www.lamborghini.com/en-en/news/lamborghini-v12-an-engine-that-made-history','2011 Aventador新6.5L V12、700CV；SVJ为770CV另一个版本。'),
 ('S08','Lamborghini','End of an Era with the Last Lamborghini Aventador','https://www.lamborghini.com/en-en/news/end-of-an-era-with-the-last-lamborghini-aventador','厂家明确2011 LP700-4、60度V12；不可拿Ultimae终代声当初代。'),
 ('S09','BMW PressClub','The all-new BMW M5 (26 June 2024)','https://www.press.bmwgroup.com/united-kingdom/article/detail/T0443389EN_GB/the-all-new-bmw-m5','G90 4.4L涡轮V8加电机，8速M Steptronic；排气电控阀、纯电声及boost track需区分。'),
 ('S10','Pole Position Production','Lamborghini Aventador 2014','https://pole.se/product/lamborghini-aventador-2014/','同步多机位、steady/ramp/shift录音候选；与S11文件数容量存在冲突。'),
 ('S11','Sonniss / Pole Position','Lamborghini Aventador 2014','https://sonniss.com/sound-effects/lamborghini-aventador-2014/','商城列366文件/27.48GB；厂商主页面列286文件/31.4GB；采购前确认实际版本。'),
 ('S12','Sonniss / Soundholder','Mazda Miata MX5 NBFL 1.6 Stock','https://sonniss.com/sound-effects/mazda-miata-mx5-nbfl-1-6-stock/','149文件、多机位；NBFL与NA代际不符。'),
 ('S13','Sounding Sweet','Porsche 992 GT3 Standard File List','https://www.sweetsfx.com/wp-content/uploads/2026/02/SSFX-P992GT3_Standard_FileList.pdf','文件表明确Stock、Manual、4.0L、进气/接触式机械/排气/车内；不是RS PDK。'),
 ('S14','Porsche Newsroom','On-board video of the dream lap','https://newsroom.porsche.com/en_US/2022/products/porsche-911-gt3-rs-dream-lap-nuerburgring-nordschleife-30037.html','官方992 GT3 RS整圈视频7:06，Weissach/Cup2R；只作参照，不获得游戏复用授权。'),
 ('S15','BOOM Library','Making the DR!FT sound','https://www.boomlibrary.com/blog/making-the-drift-sound/','已完成作品的录音方法参照：多机位、负载录音和分离附加声；其中E30是DTM非本项目道路版。'),
 ('S16','Pole Position Production','How to Record and Use a Dyno Sound Library','https://pole.se/new-dyno-sound-library/','负载/卸载可控制；轮毂台架避免行驶风胎声但仍有台架啸叫、散热风扇、室内混响。'),
 ('S17','Sonniss / Sounddogs','Mazda Miata MX5 Hot','https://sonniss.com/sound-effects/mazda-miata-mx5-hot/','进一步查商品文件表确认2002 Turbocharged；明确排除早期NA原厂候选，不只是信息不足。'),
 ('S18','Sonniss / Krampfstadt Studio','BMW M5 F10 2011 sports sedan','https://sonniss.com/sound-effects/bmw-m5-f10-2011-sports-sedan/','明确F10；即使同为4.4L双涡轮V8也不能代表G90的S68及混动。'),
 ('S19','Pole Position / A Sound Effect','BMW E30 1988 Street Race Modded file list','https://www.asoundeffect.com/wp-content/uploads/2020/03/BMW_E30_88_Street_Race_Modded.pdf','明确318i换M50b25直六涡轮、定制排气；从M3目标素材中剔除。'),
 ('S20','Pole Position Production','Lamborghini Aventador SVJ 2019','https://pole.se/product/lamborghini-aventador-svj-sound-effects/','2019 SVJ、改装排气；仅版本反例。'),
 ('S21','Sonniss / Sounddogs','Mazda Miata MX5 Hot file list','https://cdn.sonniss.com/storage/2025/02/Mazda-Miata-MX5-Hot-Sound-Effects-Library.pdf','文件描述明确2002涡轮改装；不是目标NA1.6自然吸气。'),
 ('S22','BMW PressClub USA','The All-New 2025 BMW M5','https://www.press.bmwgroup.com/usa/article/detail/T0443395EN_US/the-all-new-2025-bmw-m5?language=en_US','厂家明确S68B44T0与8速M Steptronic内电机。用作发动机家族核实；美规功率/排气配置不覆盖欧规。'),
]
sources=[dict(id=a,publisher=b,title=c,url=d,verified_facts=e,checked_at='2026-09-07',verification='PAGE_OR_PUBLISHED_FILELIST_READ',rights='REFERENCE_DOCUMENT_ONLY') for a,b,c,d,e in sources]
save('evidence/sources.json',sources)

vehicles = [
dict(id='mx5',name='MAZDA MX-5 NA',target='早期NA 1.6L、5速手动；1990北美基础款为项目暂定方向',identity_status='PROVISIONAL_MARKET_YEAR',engine='B6家族1.6L DOHC直列四缸，自然吸气',transmission='5速手动',boost='NOT_APPLICABLE',sources=['S03'],
 sound_hypothesis='预期是小排量直四的排气脉动与随负载增加的进气宽带声；敞篷驾驶位会混入明显风和路面。以上为录音筛选假设，未作听感确认。',
 states={'start_idle':'分别收冷/热启动、稳定暖机怠速、熄火；不把老化挺杆/附件异响作为常态。','load':'低/中/高转稳态轻负载与全负载、上升/下降扫转；前机舱和后排气同步。','lift_shift':'收油滑行单独录制；手动离合断扭、换挡杆及齿轮接合短声，不能套PDK瞬时换挡。','intake_boost':'原厂空气箱进气，不加涡轮泄压或赛车ITB声。','perspectives':'前空气箱、前机舱机械、尾管侧向避开气流；驾驶员耳位分别顶篷开/关，固定路旁通过。'},
 must_not_use=['NB/NBFL 1.6','NA后期1.8 BP或换机','涡轮改装Miata','以1997NA视频证明1990 1.6'],
 priority='先锁定年款/市场/原厂排气，再获取匹配NA1.6多机位；当前仅链接与未定代际启动音候选。'),
dict(id='m3e30',name='BMW M3 E30',target='E30 M3基础2.3L、200PS、5速手动',identity_status='TARGET_SPEC_VERIFIED',engine='S14B23 2302cc自然吸气直列四缸',transmission='5速手动',boost='NOT_APPLICABLE',sources=['S01','S02'],
 sound_hypothesis='应研究高转直四与独立节气门进气、机械纹理和排气共鸣；道路空气箱和催化配置会影响音色，DTM尖锐进气声不能直接复制。此为结构推断。',
 states={'start_idle':'暖怠速稳定片段与启动过程分开，避免故障链条声。','load':'同转速不同负载；空气箱和排气分轨，对比中转到高转的纹理变化。','lift_shift':'手动换挡有动力中断；记录补油降挡、收油和空挡转速回落，常态不能夸张持续放炮。','intake_boost':'进气具有研究价值，但无涡轮；DTM碳空气箱、2.5L赛车凸轮属不同目标。','perspectives':'前机舱/空气箱、后尾管、车内封闭驾驶位；外部通过单独保持空间信息。'},
 must_not_use=['E30 318i M50b25涡轮直六换机库','320/325i普通直六','DTM/Group A 2.5L','Sport Evolution 238PS','未确认的195/215PS催化版本'],
 priority='准确200PS原厂道路版整套公开授权录音尚未找到；应定向询价录制，优先空气箱+排气同步负载。'),
dict(id='gt3rs',name='PORSCHE GT3 RS',target='992代911 GT3 RS，项目欧规525PS（2022发布）',identity_status='TARGET_SPEC_VERIFIED',engine='4.0L自然吸气水平对置六缸，9000rpm上限',transmission='7速PDK双离合',boost='NOT_APPLICABLE',sources=['S04','S05','S14'],
 sound_hypothesis='高转密集六缸纹理、后部进气和排气都需保留；PDK换挡短暂断扭与补油降挡是重点。官方整圈可校对状态关系，不能从车内混音推导干净排气轨。',
 states={'start_idle':'启动、稳定怠速、熄火及风扇应有分离依据。','load':'后空气入口、机械接触/机舱、尾管；低中高转轻重负载，接近9000rpm的短扫转。','lift_shift':'PDK升挡/降挡/收油；普通GT3手动声不能充作RS变速箱。','intake_boost':'独立节气门进气，NOT_APPLICABLE涡轮；库标签Blowoff不证明此车有增压。','perspectives':'后翼下方空气入口附近、后发动机、后尾管、车内、路旁；不借用GT4 RS座舱进气布置。'},
 must_not_use=['991.1/991.2 GT3 RS','普通992 GT3手动挡当RS','911 GT3 R/Cup赛车','JCR/Dundon/Akrapovic改装排气当原厂','涡轮911 Carrera/GT2 RS'],
 priority='官方992RS整圈为第一实车状态参照；Sweet 992GT3是优质方法/分层候选但有版本边界，仍需RS PDK准确录音。'),
dict(id='lp700',name='LAMBORGHINI LP700',target='2011 Aventador LP700-4 Coupé',identity_status='TARGET_SPEC_VERIFIED',engine='L539家族6.5L、60度自然吸气V12、700CV',transmission='7速ISR自动化单离合手动变速箱',boost='NOT_APPLICABLE',sources=['S07','S08','S10'],
 sound_hypothesis='研究低转V12脉动向高转密集谐波的变化、后部进气及机械声；ISR换挡过程应区别于PDK。2014同款录音是最接近的采购线索，未宣称与2011完全相同。',
 states={'start_idle':'点火建立、暖怠速和熄火独立，驻车补油只作瞬态。','load':'发动机/排气/座舱同步steady与ramp；轻重负载分别取材。','lift_shift':'慢/快驾驶下ISR换挡断扭与恢复、收油；高转限转仅短时参考。','intake_boost':'后部自然吸气；不得加入turbo/supercharger。排气阀和改装状态需向录音商确认。','perspectives':'中后置机舱左右、尾管侧向、车内耳位、车外ORTF/XY通过。'},
 must_not_use=['SV/SVJ/Ultimae','Roadster车内声当Coupé','Revuelto混动','直通/改装排气当2011原厂'],
 priority='首选人工试听Pole 2014 LP700-4的同步engine/exhaust/inside；购Complete而非只含剪辑片段的Spotting，先确认年份及交付内容冲突。'),
dict(id='amggt3',name='MERCEDES AMG GT3',target='2019发布、2020 Evo规范GT3赛车；赛事/BoP仍需留档',identity_status='MODEL_VERIFIED_EVENT_UNRESOLVED',engine='6.3L名义排量，实际6208cc自然吸气V8（M159家族）',transmission='6速序列式赛车变速箱，后置transaxle',boost='NOT_APPLICABLE',sources=['S06'],
 sound_hypothesis='研究V8排气脉动、快速切火换挡、车内传动啸叫和赛用底盘冲击。录音中的齿轮声可能掩盖排气；不能用单一低频V8层承担全部赛车声音。',
 states={'start_idle':'启动、暖机、pit limiter受限行驶；限速器状态不能用常规怠速代替。','load':'赛事范围内的稳定负载与快速加速，BoP及消音配置必须与录音一起记录。','lift_shift':'序列式升挡切火、降挡补油、传动加/减载啸叫；禁止套道路双离合或8AT。','intake_boost':'自然吸气进气，无turbo；AMG GT/GT R/GT4的4.0涡轮不是目标发动机。','perspectives':'发动机、排气口旁、车内安全隔热位置及后部传动机位；路旁通过/回响另轨。'},
 must_not_use=['AMG GT R道路4.0TT','AMG GT4','SLS GT3当准确Evo录音','Edition55/130Y或Bathurst无限制纪录车','2017–19混剪直接认定2020 Evo'],
 priority='19Bozzy92明确Evo2020+Monza双视角作参考；没有确认到可直接采购的准确Evo多轨库，赛事/车队定向录制优先。'),
dict(id='m5g90',name='BMW M5 G90',target='2024 G90轿车、欧规M HYBRID；不包括G99旅行版',identity_status='TARGET_SPEC_VERIFIED',engine='S68家族4.4L双涡轮V8 + 电驱动',transmission='8速M Steptronic，电机集成于变速箱',boost='REQUIRED_TURBO_AND_HYBRID_DISTINCT',sources=['S09','S22'],
 sound_hypothesis='必须区分排气阀开度、涡轮进气/机械、电机与车内IconicSounds。座舱视频不是未经声效加工的V8干声；纯电驶离不应继续播放怠速。',
 states={'start_idle':'冷/热ICE启动、停止再启动、纯电READY分别标记，不能将READY当发动机已启动。','load':'V8轻/重负载与阀门模式，电机辅助出现的状态；分离车外真实动力声和座舱设计声。','lift_shift':'8AT升降挡、滑行及再加速；不能套F10双离合声音或夸张赛用回火。','intake_boost':'涡轮升压、卸载声只在真实可闻证据支持下采用；普通大泄压BOV不作为准确S68。BMW电驱提示/boost track另属设计音，不自动获得复用权。','perspectives':'前机舱/空气入口、两侧后尾管、车内（注明IconicSounds开关）、外部纯电低速；风噪/胎声独立。'},
 must_not_use=['F10/F90 M5库当G90','G99混剪当纯G90','改装OPF-delete/Akrapovic当欧规原厂','自然吸气V8代理','科幻UI声当真实电机/AVAS'],
 priority='当前最明显的完整库缺口；先收准确G90原厂外部/内部/EV/ICE切换，再做分层，保留市场排放和车内声效设置。')
]
for v in vehicles:
    v.update(listening_status='LISTENING_NOT_RUN',target_recorded_audio_status='SKIP_TARGET_DATA',notes='身份研究不修改或裁决项目物理规范；候选库与网络视频不等于已获得准确车型制作素材。')
save('vehicles/profiles.json',vehicles)

refs=[]
def ref(id,vehicle,title,creator,url,why,match,cues,verification='INDEXED_METADATA_ONLY',role='REAL_CAR_REFERENCE'):
    refs.append(dict(id=id,vehicle_id=vehicle,title=title,creator=creator,url=url,role=role,match=match,recommended_use=why,acquisition_status='LINK_ONLY',rights='REFERENCE_ONLY_NO_GAME_REUSE_LICENSE',listening_status='LISTENING_NOT_RUN',verification=verification,cues=cues,quality='待验证；按来源与内容结构入选，不代表已试听优胜'))
def cue(s,e,label,status='SUGGESTED_WINDOW_NOT_EVENT_VERIFIED'):
    return dict(start_s=s,end_s=e,label=label,timestamp_status=status)
ref('R01','mx5','1990 MAZDA MX-5 Miata NA, 1.6l stock exhaust sound','Paweł Pilarczyk','https://www.youtube.com/watch?v=RhtinZnIB6Q','标题与简述明确1990/NA/1.6/原厂排气；比改装NB视频更贴近目标。先核对画面车型和进排气，听手动换挡动力中断。','作者自述准确款；市场/原厂状态未独立证实',[cue(0,None,'整段核对原厂1.6；事件时间待定位')])
ref('R02','mx5','1991 Mazda MX-5 Miata – POV Test Drive','Winding Road Magazine','https://windingroad.com/articles/reviews/winding-road-modern-classic-1991-mazda-mx-5-miata-pov-test-drive/','真实早期NA驾驶位参考；出版者明确轻度改装，因此仅研究敞篷空间、风路声和驾驶状态。','1991轻改；不作原厂基准',[cue(0,None,'页内POV完整视频；无可靠章节')],verification='PUBLISHER_PAGE_READ')
ref('R03','m3e30','Perfect 1988 BMW E30 M3 - Driving My Dream Car! (POV)','Straight Six Racing','https://www.youtube.com/watch?v=OAZAmBFVRg8','真实道路M3 POV线索优于DTM混剪；需先确认发动机/排气/催化版本，不能直接认定200PS。','标题称1988 M3；动力/改装未知',[cue(0,None,'完整片：先核对版本，再定位暖怠速、负载、换挡')])
ref('R04','m3e30','BMW E30 M3 Race cars High revving S14s | Intake & Exhaust sound 2022–2023','Belgian-Motorsport','https://www.youtube.com/watch?v=a2ASO3b67Cg','只作赛车版与道路版差异参照；作者写2493cc/355bhp@9300rpm，不是目标2.3L 200PS。','已确认版本不符',[cue(8,114,'混合赛道'),cue(245,366,'维修区/围场'),cue(573,628,'E30 M3 vs E30 325i')],role='EXCLUSION_COMPARISON')
for c in refs[-1]['cues']: c['timestamp_status']='PUBLISHER_CHAPTER_VERIFIED_AUDIO_NOT_LISTENED'
ref('R05','gt3rs','On-board video of the dream lap (7:06)','Porsche','https://newsroom.porsche.com/en_US/2022/products/porsche-911-gt3-rs-dream-lap-nuerburgring-nordschleife-30037.html','第一实车状态品质参照：官方992RS连续完整圈，适合校对高转、PDK与道路声在负载变化时的相对关系。','992RS Weissach/Cup2R官方确认；不是独立分轨',[cue(20,65,'建议首轮抽查窗：观察转速/挡位/踏板与声音'),cue(340,395,'建议高速段抽查窗：先按画面核对实际工况')],verification='MANUFACTURER_PAGE_READ')
ref('R06','lp700','Lamborghini Aventador Sound Library Audio Demo Preview Montage','Pole Position Production','https://soundcloud.com/polepositionproduction/sets/lamborghini-aventador-sound-library-audio-demo-preview-montage','第一采购参照：对照T1发动机DPA4061与T1排气DPA4062及外部ORTF；只有厂家原始同步轨才可做严格对齐A/B，网页剪辑试听不能假定同步。','2014 LP700-4，同款不同年；非2011准确录音',[cue(0,None,'分曲T1 ONBRD SLOW ENGINE Left DPA4061'),cue(0,None,'分曲T1 ONBRD SLOW EXHAUST Right DPA4062'),cue(0,None,'分曲T1 EXT SLOW By ORTF MKH8040')],verification='PUBLISHER_PLAYLIST_METADATA_READ',role='COMMERCIAL_QUALITY_REFERENCE')
ref('R07','amggt3','Mercedes AMG GT3 Evo 2020 OnBoard, Warm Up & Sound at Monza Circuit!','19Bozzy92','https://www.youtube.com/watch?v=HBaEm2ENBqg','明确Evo2020、Krypton Motorsport/Stefano Pezzucchi；车内+车外可研究序列变速和赛用传动。作者说明不同练习场次湿/干路面，不能直接拿响度做A/B。','正确Evo代际；该赛事BoP与目标仍需核对',[cue(0,None,'先看暖机与全片状态；没有可靠原作者章节，不编造换挡时点')])
ref('R08','amggt3','Mercedes AMG GT3 Evo 2020 in action at Monza Circuit: Accelerations, Fly Bys & Great V8 Sound!','19Bozzy92','https://www.youtube.com/watch?v=pi1J8dNxlYM','补车外加速与通过机位；保留多普勒和场地混响作空间参考，不能直接循环作跟车引擎。','正确Evo代际；具体消音配置未知',[cue(0,None,'外部通过整片，短片事件待手动定位')])
ref('R09','m5g90','2025 BMW M5 - POV Night Drive (Binaural Audio)','Winding Road Magazine','https://www.youtube.com/watch?v=huuCI1aOOcE','车内双耳呈现方式参考；先核实视频作者、市场及IconicSounds设置。不可把座舱录音判为真实尾管声。','标题与年份匹配G90时代；配置仍待核实',[cue(0,None,'整片先核对EV/ICE/声效设置；时间待定位')])
ref('R10','m5g90','THE NEW BMW M5 G90/G99 - SOUND COMPILATION!','CarSpotterQVS','https://www.youtube.com/watch?v=YdWyqCQDcvQ','补车外实际通过；作者说明G90/G99混合、Panasonic HC-X1500E与Rode VideoMic Pro+，必须逐镜区分轿车。','混有G99；不可整片认定G90',[cue(0,None,'逐镜先辨G90轿车与G99旅行版，再标通过时点')])
ref('R11','shared','Making the DR!FT sound','BOOM Library','https://www.boomlibrary.com/blog/making-the-drift-sound/','选为已完成游戏声音工作的制作参照：多机位、负载状态及可分离胎声设计；借鉴方法，不能提取游戏声音或把其DTM录音当道路E30。','流程参照，不提供本项目六车素材',[cue(0,None,'阅读Recording Process与More Sounds；非音频时间')],verification='CREATOR_ARTICLE_READ',role='WORKFLOW_BENCHMARK')
ref('R12','mx5','Miata Start and Stop.mp3 — 公开HQ预览','TurboTheSergal','https://freesound.org/people/TurboTheSergal/sounds/523351/','已经保存的Miata车内启停参考。网页未写年份/排量/代际，只能作为未知代际参考，不能挂到NA1.6名下作为准确音频。','Miata自述；动力和年款未核实',[cue(0,13.881202,'完整公开预览；启动/熄火各自事件秒点未定位')],verification='SOURCE_PAGE_AND_LOCAL_PREVIEW_METADATA_READ',role='DOWNLOADED_UNRESOLVED_VEHICLE_REFERENCE')
refs[-1].update(local_path='vehicles/acquisition/raw/freesound-523351-preview-hq.mp3',acquisition_status='PREVIEW_ONLY',rights='CC BY 4.0; attribution required; target identity unresolved',license_url='https://creativecommons.org/licenses/by/4.0/',quality='公开转码预览已取得，原始320kbps文件未取得；主观听感待验证')
save('vehicles/references.json',refs)

inventory=json.loads((PROJECT/'data/vehicle-data.json').read_text())
save('evidence/project-identity-snapshot.json',dict(checked_at='2026-09-07',path='data/vehicle-data.json',sha256=hashlib.sha256((PROJECT/'data/vehicle-data.json').read_bytes()).hexdigest(),vehicles=[{'id':v['id'],'identity':v['identity']} for v in inventory['vehicles']],note='只读快照。不是新的身份冻结决定，也不评价物理完成状态。'))

for v in vehicles:
    lines=[f"# {v['name']} 声音档案",'',f"目标：{v['target']}。",f"核对状态：`{v['identity_status']}`；全部听感：`LISTENING_NOT_RUN`。",'',f"动力：{v['engine']}；{v['transmission']}。增压需求：`{v['boost']}`。",'',v['sound_hypothesis'],'','## 驾驶状态与录音位置','', '| 项目 | 研究/取材重点 |','| --- | --- |']
    names={'start_idle':'启动/怠速','load':'负载/转速','lift_shift':'收油/传动','intake_boost':'进气/增压','perspectives':'录音位置'}
    lines += [f"| {names[k]} | {val} |" for k,val in v['states'].items()]
    lines += ['','## 不可混用','']+['- '+x for x in v['must_not_use']]+['','## 已选参考','']
    for r in refs:
        if r['vehicle_id']!=v['id']:continue
        lines += [f"- [{r['title']}]({r['url']}) — {r['creator']}。{r['recommended_use']} 核实范围：{r['match']}；`{r['verification']}`。"]
    lines += ['','## 获取与缺口','',v['priority'],'','准确车型、可复用、完整原始分层录音当前仍为 `SKIP_TARGET_DATA`。网页或商业试听可看/可听，不代表取得游戏使用权。','', '## 厂家/文件证据','']
    lines += [f"- [{s['publisher']} — {s['title']}]({s['url']})：{s['verified_facts']}" for s in sources if s['id'] in v['sources']]
    (ROOT/'vehicles'/f"{v['id']}.zh-CN.md").write_text('\n'.join(lines)+'\n')

with (ROOT/'vehicles'/'reference-cues.csv').open('w',newline='') as f:
    w=csv.writer(f);w.writerow(['reference_id','vehicle','title','url','source_start_s','source_end_s','cue','timestamp_status','listening_status','reuse'])
    for r in refs:
        for c in r['cues']:
            w.writerow([r['id'],r['vehicle_id'],r['title'],r['url'],c['start_s'],c['end_s'],c['label'],c['timestamp_status'],r['listening_status'],r['rights']])
print('Built 6 vehicle profiles, 12 reference entries, source register and cue sheet.')
