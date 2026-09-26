const fs = require('fs');
const path = require('path');

const root = '/Volumes/Storage/streetrush/research-output/audio-20260907/shared';
const cc0 = 'https://creativecommons.org/publicdomain/zero/1.0/';
const ccby3 = 'https://creativecommons.org/licenses/by/3.0/';
const items = [];

function add({id, category, title, creator, source_url, license='CC0 1.0', license_url=cc0,
  acquisition_status='DOWNLOADED', original_path, preview_path, recommended_use, limitations}) {
  items.push({id, category, title, creator, source_url, license, license_url,
    acquisition_status, original_path, preview_path, source_start_s: null, source_end_s: null,
    recommended_use, limitations, listening_status: 'LISTENING_NOT_RUN'});
}

const oga = 'https://opengameart.org/content/';
const kenney = 'https://kenney.nl/assets/';

add({id:'vehicle_engine_start_generic_01',category:'vehicle',title:'Car engine start 01',creator:'looneybits',source_url:oga+'car-engine-start-01',original_path:'shared/originals/generic_car_startengine.wav',preview_path:'shared/originals/generic_car_startengine.wav',recommended_use:'冷启动、重置后重新上车的短事件',limitations:'页面未给车型或录音条件；需在车辆混音中试听。'});
add({id:'vehicle_engine_start_generic_01_alt',category:'vehicle',title:'Car engine start 01 (alternate)',creator:'looneybits',source_url:oga+'car-engine-start-01',original_path:'shared/originals/generic_car_startengine_1.wav',preview_path:'shared/originals/generic_car_startengine_1.wav',recommended_use:'同一启动事件的随机变体',limitations:'同源短启动音；需试听后决定是否与主变体并用。'});
add({id:'vehicle_engine_start_02',category:'vehicle',title:'Car engine start up 02',creator:'looneybits',source_url:oga+'car-engine-start-up-02',original_path:'shared/originals/engine_start_up_01.wav',preview_path:'shared/originals/engine_start_up_01.wav',recommended_use:'比赛开始前点火或车辆重启',limitations:'页面未给车型；需根据目标车辆的音色试听。'});
add({id:'vehicle_engine_loop_pitch_0',category:'vehicle',title:'Racing car engine loop 0',creator:'domasx2',source_url:oga+'racing-car-engine-sound-loops',original_path:'shared/originals/racing_loop_0.wav',preview_path:'shared/originals/racing_loop_0.wav',recommended_use:'低速发动机循环的候选层',limitations:'页面说明这是短循环及音高变体；单声道，需处理循环接缝。'});
add({id:'vehicle_engine_loop_pitch_3',category:'vehicle',title:'Racing car engine loop 3',creator:'domasx2',source_url:oga+'racing-car-engine-sound-loops',original_path:'shared/originals/racing_loop_3.wav',preview_path:'shared/originals/racing_loop_3.wav',recommended_use:'发动机循环的较高音高变体',limitations:'与同页其他文件主要差异为音高；需试听后选层。'});
add({id:'vehicle_door_open',category:'vehicle',title:'Car door opening',creator:'looneybits',source_url:oga+'cardoorsfx',original_path:'shared/originals/door_opening.wav',preview_path:'shared/originals/door_opening.wav',recommended_use:'车门开启交互',limitations:'页面面向停车/赛车游戏；需试听是否适合摄像机距离。'});
add({id:'vehicle_door_close',category:'vehicle',title:'Car door closing',creator:'looneybits',source_url:oga+'cardoorsfx',original_path:'shared/originals/door_closing.wav',preview_path:'shared/originals/door_closing.wav',recommended_use:'车门关闭交互',limitations:'页面面向停车/赛车游戏；需试听是否需要更重的关门层。'});
add({id:'vehicle_blinker_01',category:'vehicle',title:'Car blinker 01',creator:'looneybits',source_url:oga+'car-blinker-sfx',original_path:'shared/originals/blinker01.wav',preview_path:'shared/originals/blinker01.wav',recommended_use:'转向灯循环的点击层',limitations:'此条是短点击事件，不是完整循环；需由运行时定时重复。'});
add({id:'environment_traffic_road',category:'environment',title:'High traffic road sounds',creator:'IgnasD',source_url:oga+'high-traffic-road-sounds',original_path:'shared/originals/high_traffic_road.ogg',preview_path:'shared/originals/high_traffic_road.ogg',recommended_use:'城市道路或赛道远景交通底床',limitations:'页面标注 traffic/road/city/highway；单声道，未确认距离感和循环点。'});

add({id:'vehicle_acceleration_pack_01',category:'vehicle',title:'Car acceleration (pack selection)',creator:'GGBotNet',source_url:oga+'car-sound-effects-pack-low-quality',original_path:'shared/originals/car_sound_effects_pack.zip',preview_path:'shared/previews/selected/carpack_acceleration.ogg',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'加速事件或发动机上扬层',limitations:'源包明确为手机录制、64 kb/s 低质量；这里只精选一个条目，不能代表整包。'});
add({id:'vehicle_acceleration_pack_02',category:'vehicle',title:'Car acceleration 2 (pack selection)',creator:'GGBotNet',source_url:oga+'car-sound-effects-pack-low-quality',original_path:'shared/originals/car_sound_effects_pack.zip',preview_path:'shared/previews/selected/carpack_acceleration_2.ogg',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'加速随机变体',limitations:'源包明确为手机录制、64 kb/s 低质量；需试听并避免与高保真引擎层直接叠加。'});
add({id:'vehicle_engine_loop_pack',category:'vehicle',title:'Car engine loop (pack selection)',creator:'GGBotNet',source_url:oga+'car-sound-effects-pack-low-quality',original_path:'shared/originals/car_sound_effects_pack.zip',preview_path:'shared/previews/selected/carpack_engine_loop.ogg',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'低质量原型引擎循环或参考层',limitations:'源包明确为手机录制、64 kb/s 低质量；不可直接视作最终混音合格。'});
add({id:'vehicle_parking_brake_pack',category:'vehicle',title:'Car parking brake (pack selection)',creator:'GGBotNet',source_url:oga+'car-sound-effects-pack-low-quality',original_path:'shared/originals/car_sound_effects_pack.zip',preview_path:'shared/previews/selected/carpack_parking_brake.ogg',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'驻车制动、低速机械反馈',limitations:'源包明确为手机录制、64 kb/s 低质量；需试听是否能与底盘层分离。'});

add({id:'vehicle_tire_skid_loop',category:'tire_skid',title:'Car tire skid squealing loop',creator:'Mike Koenig (Soundbible), submitted by qubodup',source_url:oga+'car-tire-skid-squealing',license:'CC BY 3.0',license_url:ccby3,original_path:'shared/originals/carskid.7z',preview_path:'shared/previews/selected/carskid_skid_loop.wav',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'干沥青持续滑移/抱死的候选循环',limitations:'CC BY 3.0 必须署名；页面说明来自 Soundbible 并经过裁切、归一化、淡入淡出；试听前只做技术收集。'});
add({id:'vehicle_tire_skid_piece',category:'tire_skid',title:'Car tire skid squeal piece',creator:'Mike Koenig (Soundbible), submitted by qubodup',source_url:oga+'car-tire-skid-squealing',license:'CC BY 3.0',license_url:ccby3,original_path:'shared/originals/carskid.7z',preview_path:'shared/previews/selected/carskid_skid_piece.wav',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'短刹车尖叫或擦地瞬态',limitations:'CC BY 3.0 必须署名；来源为同一归档包，需试听频谱和尾部噪声。'});
add({id:'vehicle_tire_skid_piece_fade',category:'tire_skid',title:'Car tire skid piece with fade',creator:'Mike Koenig (Soundbible), submitted by qubodup',source_url:oga+'car-tire-skid-squealing',license:'CC BY 3.0',license_url:ccby3,original_path:'shared/originals/carskid.7z',preview_path:'shared/previews/selected/carskid_skid_piece_fadeinout.wav',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'滑移开始或结束的过渡层',limitations:'CC BY 3.0 必须署名；文件名表示已有淡入淡出，仍需试听避免重复包络。'});

add({id:'environment_wind_short',category:'wind',title:'Short wind sound',creator:'remaxim',source_url:oga+'short-wind-sound',original_path:'shared/originals/short_wind_sound.wav',preview_path:'shared/originals/short_wind_sound.wav',recommended_use:'车速变化时的短风掠过',limitations:'页面定位为 short wind/fade；时长短，适合事件层而非持续底床。'});
add({id:'environment_wind_01',category:'wind',title:'Wind 01',creator:'IgnasD',source_url:oga+'wind',original_path:'shared/originals/wind.zip',preview_path:'shared/previews/selected/wind_01.ogg',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'户外赛道风噪底床',limitations:'原始 ZIP 含三条风声，本条为精选；页面未提供车辆速度匹配信息。'});
add({id:'environment_wind_02',category:'wind',title:'Wind 02',creator:'IgnasD',source_url:oga+'wind',original_path:'shared/originals/wind.zip',preview_path:'shared/previews/selected/wind_02.ogg',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'户外风噪随机变体',limitations:'原始 ZIP 含三条风声，本条为精选；需试听是否与 wind_01 足够区分。'});
add({id:'surface_gravel',category:'surface',title:'Gravel surface step (proxy)',creator:'TinyWorlds',source_url:oga+'different-steps-on-wood-stone-leaves-gravel-and-mud',original_path:'shared/originals/different_steps.zip',preview_path:'shared/previews/selected/surface_gravel.ogg',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'砂石路滚动、碎石飞溅的参考层',limitations:'原作者描述为脚步/建造音效，非车辆轮胎录音；用于车轮层前必须试听。'});
add({id:'surface_moving_car',category:'surface',title:'Car 1 moving-car sound',creator:'Yaroslav_Novikov',source_url:oga+'car-1-1',original_path:'shared/originals/car1_moving.wav',preview_path:'shared/originals/car1_moving.wav',recommended_use:'车辆滚动/移动底层和道路运动参考',limitations:'页面只标注 moving car sound，没有拆分轮胎、发动机或距离层；需试听后再决定是否作为生产层。'});
add({id:'environment_bird_chirp',category:'environment',title:'Bird chirping sounds',creator:'syncopika',source_url:oga+'bird-chirping-sounds',original_path:'shared/originals/birdchirping071414.mp3',preview_path:'shared/originals/birdchirping071414.mp3',recommended_use:'户外赛道鸟鸣点缀',limitations:'页面说明为后院录制的很短片段；不适合独立形成连续环境。'});
add({id:'environment_birds_ambient',category:'environment',title:'Ambient bird sounds',creator:'isaiah658',source_url:oga+'ambient-bird-sounds',original_path:'shared/originals/birds_isaiah658.ogg',preview_path:'shared/originals/birds_isaiah658.ogg',recommended_use:'户外自然环境底床',limitations:'页面说明音频经过 Audacity 清理；未确认循环点和鸟种距离。'});
add({id:'environment_crowd_shout',category:'environment',title:'Crowd shouting/speaking ambience',creator:'StarNinjas',source_url:oga+'crowd-shoutingspeaking-ambience',original_path:'shared/originals/crowd_shouting.ogg',preview_path:'shared/originals/crowd_shouting.ogg',recommended_use:'赛道观众或路旁人群远景层',limitations:'页面说明素材是抗议/军队式喊声混音，可能比普通观众更激烈；署名虽非强制但作者希望链接其 OGA 主页。'});
add({id:'environment_crowd_applause',category:'environment',title:'Applause in a large hall or church',creator:'eXpl0it3r',source_url:oga+'applause-in-a-large-hall-or-church',original_path:'shared/originals/applause_clapping_church_crowd.wav',preview_path:'shared/originals/applause_clapping_church_crowd.wav',recommended_use:'终点线观众鼓掌或成功事件环境层',limitations:'页面说明为教堂大型空间内的近场立体录音；混入户外赛道前需试听混响。'});

add({id:'collision_metal_bing',category:'collision',title:'Metal impact bing 1',creator:'BMacZero',source_url:oga+'metal-impact-sounds',original_path:'shared/originals/metal_bing1.wav',preview_path:'shared/originals/metal_bing1.wav',recommended_use:'轻微金属擦碰的高频瞬态',limitations:'页面只描述为少量金属撞击；作者署名 Brian MacIntosh 为可选。'});
add({id:'collision_metal_clink',category:'collision',title:'Metal impact clink 2',creator:'BMacZero',source_url:oga+'metal-impact-sounds',original_path:'shared/originals/metal_clink2.wav',preview_path:'shared/originals/metal_clink2.wav',recommended_use:'轻碰、零件松动或小擦撞',limitations:'页面只描述为少量金属撞击；作者署名 Brian MacIntosh 为可选。'});
add({id:'collision_metal_thud',category:'collision',title:'Metal impact thud 2',creator:'BMacZero',source_url:oga+'metal-impact-sounds',original_path:'shared/originals/metal_thud2.wav',preview_path:'shared/originals/metal_thud2.wav',recommended_use:'低频车身触地或中等擦撞层',limitations:'页面只描述为少量金属撞击；作者评论提示部分文件听感可能像脚步，需试听。'});
add({id:'collision_glass_break',category:'collision',title:'Glass break',creator:'Till Behrend, submitted by TinyWorlds',source_url:oga+'glass-break',original_path:'shared/originals/glass_breaking.wav',preview_path:'shared/originals/glass_breaking.wav',recommended_use:'车窗破碎或碰撞碎玻璃层',limitations:'页面说明是 Duckstruction 的 game-ready 文件；未试听碎裂密度和尾响。'});
add({id:'collision_metal_pack_slam',category:'collision',title:'Metal slam (pack selection)',creator:'rubberduck',source_url:oga+'100-cc0-metal-and-wood-sfx',original_path:'shared/originals/100-CC0-wood-metal-SFX.zip',preview_path:'shared/previews/selected/metal_pack_slam.ogg',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'车身重擦撞或金属门板 slam 层',limitations:'源包含 100 条金属/木材音效，本条仅为精选；页面提示预览未覆盖全包，需试听。'});
add({id:'mechanical_clank',category:'mechanical',title:'Mechanical clank 1',creator:'BMacZero',source_url:oga+'mechanical-sounds',original_path:'shared/originals/mechanical_clank1.wav',preview_path:'shared/originals/mechanical_clank1.wav',recommended_use:'底盘、悬挂或换挡机械短响',limitations:'页面描述为 mechanical impacts/ratchets 等通用机械声；不是特定车辆实录。'});
add({id:'mechanical_light_clunk',category:'mechanical',title:'Mechanical light clunk 1',creator:'BMacZero',source_url:oga+'mechanical-sounds',original_path:'shared/originals/mechanical_lightclunk1.wav',preview_path:'shared/originals/mechanical_lightclunk1.wav',recommended_use:'轻悬挂回弹、内饰机构或换挡反馈',limitations:'通用机械声；作者署名 Brian MacIntosh 为可选，需试听层次。'});
add({id:'mechanical_rattle',category:'mechanical',title:'Mechanical rattle 1',creator:'BMacZero',source_url:oga+'mechanical-sounds',original_path:'shared/originals/mechanical_rattle1.wav',preview_path:'shared/originals/mechanical_rattle1.wav',recommended_use:'底盘松动、碎石路颠簸或车内异响层',limitations:'通用机械声；未试听是否有明显人工录音底噪。'});
add({id:'collision_kenney_metal_heavy',category:'collision',title:'Kenney heavy metal impact 000',creator:'Kenney',source_url:kenney+'impact-sounds',original_path:'shared/originals/kenney_impact-sounds.zip',preview_path:'shared/previews/selected/kenney_impact_metal_heavy_000.ogg',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'可随机化的中重度金属碰撞层',limitations:'Kenney 包页标注 130 条 CC0 impact/foley；本条仅为精选，未试听随机组之间的相似度。'});
add({id:'collision_kenney_glass_heavy',category:'collision',title:'Kenney heavy glass impact 000',creator:'Kenney',source_url:kenney+'impact-sounds',original_path:'shared/originals/kenney_impact-sounds.zip',preview_path:'shared/previews/selected/kenney_impact_glass_heavy_000.ogg',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'玻璃撞击、碎裂前的高频层',limitations:'Kenney 包页标注 130 条 CC0 impact/foley；本条仅为精选，未试听是否需要与独立碎玻璃叠加。'});

add({id:'ui_click',category:'ui_feedback',title:'Kenney interface click 001',creator:'Kenney',source_url:kenney+'interface-sounds',original_path:'shared/originals/kenney_interface-sounds.zip',preview_path:'shared/previews/selected/kenney_ui_click_001.ogg',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'按钮、菜单和轻量 HUD 点击',limitations:'Kenney 包页标注 100 条 CC0 interface 声音；本条仅为精选。'});
add({id:'ui_confirmation',category:'ui_feedback',title:'Kenney interface confirmation 001',creator:'Kenney',source_url:kenney+'interface-sounds',original_path:'shared/originals/kenney_interface-sounds.zip',preview_path:'shared/previews/selected/kenney_ui_confirmation_001.ogg',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'设置确认、检查点或完成确认',limitations:'Kenney 包页标注 100 条 CC0 interface 声音；本条仅为精选。'});
add({id:'ui_error',category:'ui_feedback',title:'Kenney interface error 001',creator:'Kenney',source_url:kenney+'interface-sounds',original_path:'shared/originals/kenney_interface-sounds.zip',preview_path:'shared/previews/selected/kenney_ui_error_001.ogg',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'无效操作、失败提示或碰撞警告',limitations:'Kenney 包页标注 100 条 CC0 interface 声音；本条仅为精选。'});
add({id:'ui_open',category:'ui_feedback',title:'Kenney interface open 001',creator:'Kenney',source_url:kenney+'interface-sounds',original_path:'shared/originals/kenney_interface-sounds.zip',preview_path:'shared/previews/selected/kenney_ui_open_001.ogg',acquisition_status:'DOWNLOADED_FROM_ARCHIVE',recommended_use:'菜单打开、暂停页或结果页进入',limitations:'Kenney 包页标注 100 条 CC0 interface 声音；本条仅为精选。'});
add({id:'race_countdown',category:'ui_feedback',title:'Race start countdown',creator:'kheetor',source_url:oga+'race-start-countdown',original_path:'shared/originals/race_countdown.ogg',preview_path:'shared/originals/race_countdown.ogg',recommended_use:'3、2、1、Go 比赛倒计时',limitations:'页面同时列出 CC0 与 CC-BY 等许可；本目录按 CC0 记录。需试听混响和节拍是否匹配。'});
add({id:'race_success',category:'ui_feedback',title:'Well Done',creator:'qubodup',source_url:oga+'well-done',original_path:'shared/originals/well_done.ogg',preview_path:'shared/originals/well_done.ogg',recommended_use:'完赛、胜利或检查点成功',limitations:'页面说明 2024-10-05 改为 CC0，文件名仍带旧 CCBY3；可选署名 qubodup。'});
add({id:'race_game_over',category:'ui_feedback',title:'Game Over (old school)',creator:'den_yes',source_url:oga+'game-over-soundold-school',original_path:'shared/originals/game_over.ogg',preview_path:'shared/originals/game_over.ogg',recommended_use:'失败、淘汰或比赛结束负反馈',limitations:'页面说明是老派游戏结束音；需试听是否与游戏整体音色相容。'});
add({id:'ui_beep',category:'ui_feedback',title:'Beep tone',creator:'qubodup',source_url:oga+'beep-tone-sound-sfx',original_path:'shared/originals/beep.wav',preview_path:'shared/originals/beep.wav',recommended_use:'确认、提示或倒计时单音',limitations:'页面定位为通用 interface beep；时长极短，需由运行时节奏化。'});
add({id:'race_feedback_supertuxkart',category:'ui_feedback',title:'SuperTuxKart sound effects (mixed source)',creator:'Scribe',source_url:oga+'supertuxkart-sound-effects',original_path:'shared/originals/supertuxkart_sfx.mp3',preview_path:'shared/originals/supertuxkart_sfx.mp3',recommended_use:'从混合音轨中试听和切分轮胎、倒计时、确认/失败候选',limitations:'页面明确是包含多类赛车音效的单个约 82 秒 MP3；本次未切分，不能把整条音轨当作单一生产事件。'});

const checkFile = path.join(root, 'evidence', 'technical_check.tsv');
const byPath = new Map();
for (const line of fs.readFileSync(checkFile, 'utf8').trim().split(/\n/).slice(1)) {
  const [rel, bytes, sha, status, summary] = line.split('\t');
  byPath.set(rel, {bytes: Number(bytes), sha256: sha, technical_status: status, technical_summary: summary});
}
for (const item of items) {
  const check = byPath.get(item.preview_path.replace(/^shared\//, ''));
  if (!check) throw new Error(`No technical check for ${item.preview_path}`);
  Object.assign(item, check);
}

const out = {
  schema_version: '1.0',
  collection_id: 'audio-20260907/shared',
  generated_at_utc: new Date().toISOString(),
  scope: 'Shared racing-game sound research; selected files only',
  selected_count: items.length,
  raw_download_total_bytes: fs.readdirSync(path.join(root, 'originals')).reduce((n, name) => n + fs.statSync(path.join(root, 'originals', name)).size, 0),
  download_cap_bytes: 200 * 1024 * 1024,
  listening_policy: 'All items are marked LISTENING_NOT_RUN; ffprobe decode checks are technical only.',
  source_page_evidence_dir: 'shared/evidence/pages',
  technical_check: 'shared/evidence/technical_check.tsv',
  extraction_tool: 'shared/tools/extract_selected.sh',
  items,
  research_candidates: [
    {
      id: 'candidate_27_metal_audio_samples',
      category: 'collision',
      title: '27 Metal Audio Samples (SFX)',
      creator: 'blacklodgegames',
      source_url: oga+'27-metal-audio-samples-sfx',
      license: 'CC0 1.0',
      license_url: cc0,
      acquisition_status: 'RESEARCH_ONLY_NOT_DOWNLOADED',
      original_path: null,
      preview_path: null,
      source_start_s: null,
      source_end_s: null,
      recommended_use: '额外金属碰撞和车身变形候选',
      limitations: '页面明确为 27 条未压缩 WAV；本批已有多组金属音效，为控制精选规模和冗余暂不下载。',
      listening_status: 'LISTENING_NOT_RUN',
      sha256: null
    },
    {
      id: 'candidate_game_voice_race_lines',
      category: 'ui_feedback',
      title: 'Game voice race lines',
      creator: 'Tim Rockk',
      source_url: oga+'game-voice',
      license: 'CC0 1.0',
      license_url: cc0,
      acquisition_status: 'RESEARCH_ONLY_NOT_DOWNLOADED',
      original_path: null,
      preview_path: null,
      source_start_s: null,
      source_end_s: null,
      recommended_use: '“Get ready/3-2-1-go/new car/victory” 语音反馈候选',
      limitations: '页面提供多条预览和 11.7 MB 全包；本批先保留无语音 UI 方案，待产品需要和试听后再收集。',
      listening_status: 'LISTENING_NOT_RUN',
      sha256: null
    }
  ]
};
fs.writeFileSync(path.join(root, 'catalog.json'), `${JSON.stringify(out, null, 2)}\n`);
