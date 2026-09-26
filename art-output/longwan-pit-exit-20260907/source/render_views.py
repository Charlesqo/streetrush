"""Serial finite camera render batch. Open an existing built .blend; never rebuild by polling."""
import bpy,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'scene'/'longwan_pit_exit_editable.blend'))
s=bpy.context.scene
draft='--draft' in args
review='--review' in args
args=[a for a in args if a not in {'--draft','--review'}]
s.render.threads_mode='FIXED';s.render.threads=3
s.cycles.samples=32 if review else (20 if draft else 64);s.cycles.use_denoising=True
s.render.resolution_x=1600 if review else (1200 if draft else 1920);s.render.resolution_y=1000 if review else (750 if draft else 1200);s.render.resolution_percentage=100
names=args or [f'{i:02}_{n}' for i,n in enumerate(['overall','driving','reverse','garage','facilities','surface','control','rear'],1)]
for name in names:
    prefix=s.get('revision','draft')+'_' if (draft or review) else ''
    s.camera=bpy.data.objects[name];s.render.filepath=str(ROOT/'previews'/f'{prefix}{name}.png')
    bpy.ops.render.render(write_still=True)
    print('VIEW_COMPLETE '+name,flush=True)
