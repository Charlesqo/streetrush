"""Move only the delivery camera out from behind the fence; do not change assets."""
import bpy
from pathlib import Path
from mathutils import Vector
R=Path(__file__).resolve().parents[1]
bpy.ops.wm.open_mainfile(filepath=str(R/'scene/longwan_region_editable.blend'),load_ui=False,use_scripts=False)
S=bpy.context.scene;camera=bpy.data.objects['region_05_stand'];camera.location=(-25,-17,3.1);camera.rotation_euler=(Vector((-11,-24,2.5))-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.lens=36
S.camera=bpy.data.objects['region_01_overall'];bpy.ops.wm.save_as_mainfile(filepath=str(R/'scene/longwan_region_editable.blend'))
S.camera=camera;S.render.filepath=str(R/'previews/region_05_stand.png');bpy.ops.render.render(write_still=True)
print('STAND_DELIVERY_CAMERA_COMPLETE',flush=True)
