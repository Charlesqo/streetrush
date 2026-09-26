"""Complete the three close views from the saved assembled scene."""
import bpy
from pathlib import Path
R=Path(__file__).resolve().parents[1]
bpy.ops.wm.open_mainfile(filepath=str(R/'scene/longwan_region_editable.blend'),load_ui=False,use_scripts=False)
S=bpy.context.scene;S.render.threads_mode='FIXED';S.render.threads=3
for name in ['region_04_control','region_05_stand','region_06_ground']:
    S.camera=bpy.data.objects[name];S.render.filepath=str(R/'previews'/f'{name}.png');bpy.ops.render.render(write_still=True);print('REGION_DETAIL_VIEW_COMPLETE '+name,flush=True)
