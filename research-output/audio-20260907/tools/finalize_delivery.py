#!/usr/bin/env python3
"""Targeted editorial correction and reel v2; preserves original sources and v1."""
import pathlib,json,csv,wave,hashlib
import numpy as np
ROOT=pathlib.Path(__file__).resolve().parents[1]
cat=json.loads((ROOT/'catalog.json').read_text())
processing={x['id']:x for x in json.loads((ROOT/'reports/preview-processing.json').read_text())}
for x in cat['items']:
    x['collection_technical_status']=x.get('technical_status')
    x['technical_status']='FFMPEG_EXCERPT_DECODE_OK'
    if processing[x['id']]['source_excerpt_samples_ge_1']:
        x['technical_status']='PREVIEW_DECODE_OK_SOURCE_PEAK_REVIEW_REQUIRED'
        x['technical_warning']='解码并转48kHz后的浮点样本超过满幅：可能含编码/重采样过冲，不足以证明原录音已削波；需试听。预览已衰减，不能声称修复原始失真。'
    if x['id']=='surface_moving_car':
        x['category']='场地环境'
        x['recommended_use']='未知车型车辆移动的场地声音参考；不是独立胎噪或准确车型发动机层。'
        x['limitations']='源条目只说明moving car sound，可能混入发动机、风或远近变化；不是脚步。不能据此声明路面滚动分层已补齐。主观听感与录音距离仍待确认。'
(ROOT/'catalog.json').write_text(json.dumps(cat,ensure_ascii=False,indent=2)+'\n')
with (ROOT/'catalog.csv').open(newline='') as f:cols=next(csv.reader(f))
with (ROOT/'catalog.csv').open('w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=cols,extrasaction='ignore');w.writeheader();w.writerows(cat['items'])
old=json.loads((ROOT/'previews/shared-first-pass.cues.json').read_text())
chunks=[];cues=[];cursor=0;pcm_rate=48000
for row in old:
    x=next(i for i in cat['items'] if i['id']==row['id'])
    with wave.open(str(ROOT/x['preview_path'])) as w:
        pcm=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2').reshape(-1,2).copy()
    # Keep UI one-shots complete; only long environment excerpts are capped.
    end=min(len(pcm),3*pcm_rate) if x['id'].startswith('environment_') else len(pcm)
    truncated=end<len(pcm);pcm=pcm[:end].copy()
    if truncated:
        n=min(480,len(pcm)//4);pcm[-n:]=(pcm[-n:].astype(float)*np.linspace(1,0,n)[:,None]).astype('<i2')
    t=len(pcm)/pcm_rate
    cues.append(dict(id=x['id'],title=x['title'],reel_start_s=cursor,reel_end_s=cursor+t,source_start_s=0,source_end_s=t,source_url=x['source_url'],license=x['license'],timestamp_status='ASSEMBLED_CUE_VERIFIED_NOT_LISTENED',tail_fade_s=0.01 if truncated else 0))
    chunks.append(pcm.tobytes());chunks.append(bytes(pcm_rate*4));cursor+=t+1
out=ROOT/'previews/shared-review-v2.wav'
with wave.open(str(out),'wb') as w:
    w.setnchannels(2);w.setsampwidth(2);w.setframerate(pcm_rate);w.writeframes(b''.join(chunks))
(ROOT/'previews/shared-review-v2.cues.json').write_text(json.dumps(cues,ensure_ascii=False,indent=2)+'\n')
checks=[]
for x in cat['items']:
    for k in ('original_path','source_audio_path','preview_path'):
        p=(ROOT/x[k]).resolve();assert p.is_relative_to(ROOT) and p.is_file(),(x['id'],k)
    assert hashlib.sha256((ROOT/x['source_audio_path']).read_bytes()).hexdigest()==x['source_audio_sha256'],x['id']
    assert hashlib.sha256((ROOT/x['preview_path']).read_bytes()).hexdigest()==x['preview_sha256'],x['id']
    checks.append(x['id'])
with wave.open(str(out)) as w:
    pcm=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2')
    assert abs(w.getnframes()/pcm_rate-cursor)<1/pcm_rate
    assert (np.abs(pcm.astype(np.int32))<=16424).all()
result=dict(date='2026-09-07',selected=len(checks),parked=len(cat['parked']),source_and_preview_hashes='MATCH',source_and_preview_paths='EXIST_WITHIN_RESEARCH_DIRECTORY',reel_v2=dict(path=str(out.relative_to(ROOT)),duration_s=cursor,sha256=hashlib.sha256(out.read_bytes()).hexdigest(),cue_count=len(cues),cue_alignment='VERIFIED_TO_FRAME',peak='SAMPLE_PEAK_AT_MOST_MINUS_6_DBFS',listening='NOT_RUN'),changes=['Correct moving-car source category; it is not a footstep.','Preserve complete countdown and other short events in reel v2; v1 had a general 3s preview cap.','10ms tail fade only for truncated environment excerpts in v2.','v1 retained; individual audition files and all original sources unchanged.'])
(ROOT/'reports/final-integrity.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'selected':len(checks),'parked':len(cat['parked']),'reel_v2_s':cursor,'source_hashes':'MATCH','preview_hashes':'MATCH'}))
