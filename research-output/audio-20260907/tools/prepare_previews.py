#!/usr/bin/env python3
"""One bounded technical preparation pass. No listening or target-car validation."""
import json,pathlib,subprocess,hashlib,wave,math,csv
import numpy as np
ROOT=pathlib.Path(__file__).resolve().parents[1]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
raw=json.loads((ROOT/'shared/catalog.json').read_text())['items']
excluded={x['id']:'未核实车型的通用引擎：保留原件，排除六车制作候选。' for x in raw if 'engine_' in x['id'] or 'acceleration_pack' in x['id']}
excluded.update(environment_crowd_shout='作者描述为抗议/军队式喊声；不推荐作常规赛道观众。',environment_crowd_applause='大厅/教堂掌声，室内混响不匹配户外赛场；保留作反例。',vehicle_blinker_01='本轮核心范围外的附件声；保留原件，不加入首选集。',race_feedback_supertuxkart='多音效混在一条MP3，事件边界/底层来源需进一步核查；本轮不切分，也不作为可用首选。')
cats={'vehicle':'车体细节','tire_skid':'轮胎滑移','wind':'环境风','surface':'路面设计原料','environment':'场地环境','collision':'碰撞设计原料','mechanical':'机械设计原料','ui_feedback':'游戏反馈'}
selected=[];parked=[];qa=[]
(ROOT/'previews/audition').mkdir(parents=True,exist_ok=True)
for item in raw:
    x=dict(item);source=x.get('preview_path') or x.get('original_path')
    x['source_audio_path']=source;x['local_path']=source;x['editorial_status']='SELECTED_CANDIDATE_LISTENING_NOT_RUN'
    x['category']=cats.get(x['category'],x['category'])
    if x['id'] in excluded:
        x['editorial_status']='PARKED_NOT_RECOMMENDED';x['editorial_reason']=excluded[x['id']];parked.append(x);continue
    if item['category'] in ('surface','collision','mechanical'):
        x['recommended_use']='设计原料候选：'+x['recommended_use']
        x['limitations']+=' 通用材料/机构声音，不是目标车辆实测；不能据此声明路面滚动、悬挂或碰撞已补齐。'
    if item['category']=='surface':x['recommended_use']='脚步来源的颗粒/硬质瞬态设计原料；不可用作实录车辆滚动层。'
    if item['category']=='wind':x['recommended_use']='户外环境风候选；不可认定为高速车内或车体气动风噪。'
    if item['category']=='environment':x['limitations']+=' 非龙湾赛道实录；鸟种/交通内容/音乐和人声仍需试听。'
    if item['category']=='vehicle':x['limitations']+=' 车型未知，仅作通用车体交互原料；不声称六车门体或手刹一致。'
    x['preview_source_note']='原始压缩包及其未处理选取成员保持不变；下方另有本轮技术预览。'
    p=ROOT/source
    probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-show_streams','-of','json',str(p)]))
    stream=next(s for s in probe['streams'] if s['codec_type']=='audio');dur=float(probe['format']['duration'])
    end=min(dur,12.0 if item['category'] in ('environment','wind') else 8.0)
    # Cut windows are technical convenience, not manually verified event boundaries.
    arr=np.frombuffer(subprocess.check_output(['ffmpeg','-v','error','-i',str(p),'-t',str(end),'-ar','48000','-ac','2','-f','f32le','pipe:1']),dtype='<f4').reshape(-1,2).copy()
    assert len(arr)>0 and np.isfinite(arr).all(), source
    peak=float(np.max(np.abs(arr)));rms=float(np.sqrt(np.mean(arr.astype(np.float64)**2)))
    cap=10**(-6/20);gain=min(1.0,cap/peak) if peak else 1.0
    before=arr.copy();arr*=gain
    fade=0
    if dur>end+0.01:
        fade=min(2400,len(arr)//4);arr[-fade:]*=np.linspace(1,0,fade)[:,None]
    out=ROOT/'previews/audition'/f"{x['id']}.wav"
    with wave.open(str(out),'wb') as w:
        w.setnchannels(2);w.setsampwidth(2);w.setframerate(48000);w.writeframes((np.clip(arr,-1,1)*32767).astype('<i2').tobytes())
    x.update(preview_path=str(out.relative_to(ROOT)),source_start_s=0.0,source_end_s=round(len(arr)/48000,6),timestamp_status='TECHNICAL_EXCERPT_NOT_EVENT_VERIFIED',quality='待试听；只有技术检查',source_audio_sha256=sha(p),preview_sha256=sha(out),source_duration_s=dur)
    q=dict(id=x['id'],source_path=source,original_archive=x['original_path'],source_sha256=sha(p),source_duration_s=dur,source_codec=stream['codec_name'],source_rate=stream.get('sample_rate'),source_channels=stream.get('channels'),preview_path=x['preview_path'],preview_sha256=x['preview_sha256'],preview_duration_s=x['source_end_s'],source_start_s=0,source_end_s=x['source_end_s'],source_excerpt_sample_peak_dbfs=20*math.log10(peak) if peak else None,source_excerpt_rms_dbfs=20*math.log10(rms) if rms else None,source_excerpt_samples_ge_1=int((np.abs(before)>=1).sum()),gain_db=20*math.log10(gain),tail_fade_s=fade/48000,processing='48kHz stereo PCM16; attenuation only to sample peak <= -6dBFS; 50ms tail fade only if excerpt truncates source; no denoise/EQ/pitch change',listening_status='LISTENING_NOT_RUN',decode_status='FFMPEG_EXCERPT_DECODE_OK',coverage='Preview excerpt only; no claim full source has been listened to or fully decoded; intersample true peaks not measured')
    qa.append(q);selected.append(x)
manifest={'checked_at':'2026-09-07','scope':'Independent editorial selection; shared/catalog.json remains the acquisition record','raw_collected_items':len(raw),'selected_count':len(selected),'parked_count':len(parked),'items':selected,'parked':parked}
(ROOT/'catalog.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
(ROOT/'reports/preview-processing.json').write_text(json.dumps(qa,ensure_ascii=False,indent=2)+'\n')
with (ROOT/'catalog.csv').open('w',newline='') as f:
    cols=['id','category','title','creator','license','source_url','license_url','original_path','source_audio_path','source_audio_sha256','preview_path','preview_sha256','source_start_s','source_end_s','editorial_status','listening_status','recommended_use','limitations']
    w=csv.DictWriter(f,fieldnames=cols,extrasaction='ignore');w.writeheader();w.writerows(selected)
reel_ids=['ui_click','ui_confirmation','ui_error','race_countdown','vehicle_tire_skid_loop','environment_wind_01','mechanical_clank','collision_metal_thud','collision_glass_break','environment_birds_ambient']
chunks=[];cues=[];cursor=0
for id in reel_ids:
    x=next((a for a in selected if a['id']==id),None)
    if not x:continue
    p=ROOT/x['preview_path']
    with wave.open(str(p)) as w:frames=w.readframes(min(w.getnframes(),144000))
    t=len(frames)/(48000*4);chunks.append(frames);cues.append({'id':id,'title':x['title'],'reel_start_s':round(cursor,6),'reel_end_s':round(cursor+t,6),'source_start_s':0,'source_end_s':round(t,6),'source_url':x['source_url'],'license':x['license'],'timestamp_status':'ASSEMBLED_CUE_VERIFIED_NOT_LISTENED'})
    cursor+=t;chunks.append(bytes(48000*4));cursor+=1
with wave.open(str(ROOT/'previews/shared-first-pass.wav'),'wb') as w:
    w.setnchannels(2);w.setsampwidth(2);w.setframerate(48000);w.writeframes(b''.join(chunks))
(ROOT/'previews/shared-first-pass.cues.json').write_text(json.dumps(cues,ensure_ascii=False,indent=2)+'\n')
attr=['# 本轮首选素材署名与变更记录','', '不代表声音已验收。CC0无需强制署名仍保留来源；CC BY 3.0条目应在后续作品中保留作者、链接、许可及修改说明。','']
for x in selected:
    attr += [f"- **{x['title']}** — {x['creator']}；[{x['license']}]({x['license_url']})；[原条目]({x['source_url']})。本轮修改：仅技术预览转48kHz立体声PCM16，必要时衰减和裁切末尾淡出；原文件未改。源区间0–{x['source_end_s']}秒。"]
(ROOT/'ATTRIBUTION.zh-CN.md').write_text('\n'.join(attr)+'\n')
print(json.dumps({'raw':len(raw),'selected':len(selected),'parked':len(parked),'preview_wav':len(qa),'reel_seconds':cursor,'listening':'NOT_RUN'}))
