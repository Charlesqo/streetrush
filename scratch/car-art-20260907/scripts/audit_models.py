"""Initial audit and neutral baseline preview builder for StreetRush car GLBs.

This script is intentionally self-contained so it can be run once in Blender's
background mode. It never writes to public/cars or source-models. All outputs
go beneath scratch/car-art-20260907 (or --out).

Example:
    Blender.app/Contents/MacOS/blender -b --python audit_models.py -- \
        --project-root /Volumes/Storage/streetrush \
        --out /Volumes/Storage/streetrush/scratch/car-art-20260907
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import traceback
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import bpy
from mathutils import Matrix, Vector


TARGET_MODEL_LENGTH_M = 4.5
PUBLIC_CAR_FILES = (
    "bmw-m3-e30.glb",
    "bmw-m5-g90.glb",
    "lamborghini-aventador-lp700.glb",
    "mazda-miata-mx5-na.glb",
    "mercedes-amg-gt3.glb",
    "porsche-gt3-rs.glb",
)
SOURCE_CAR_FILES = (
    "bmw-m5-g90.glb",
    "mercedes-amg-gt3.glb",
)


def finite_float(value: Any) -> Optional[float]:
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def vector_json(value: Iterable[Any]) -> List[Optional[float]]:
    return [finite_float(component) for component in value]


def matrix_json(value: Matrix) -> List[List[Optional[float]]]:
    return [[finite_float(value[row][column]) for column in range(4)] for row in range(4)]


def write_json(path: str, payload: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False, allow_nan=False)
        handle.write("\n")


def clear_scene() -> None:
    """Start each model from a clean Blender factory scene."""
    bpy.ops.wm.read_factory_settings(use_empty=True)


def unique_objects(before_pointers: set[int]) -> List[bpy.types.Object]:
    return [obj for obj in bpy.data.objects if obj.as_pointer() not in before_pointers]


def object_world_bounds(obj: bpy.types.Object) -> Optional[Dict[str, Any]]:
    if obj.type != "MESH":
        return None
    try:
        corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    except Exception:
        return None
    if not corners:
        return None
    mins = [min(corner[index] for corner in corners) for index in range(3)]
    maxs = [max(corner[index] for corner in corners) for index in range(3)]
    dimensions = [maxs[index] - mins[index] for index in range(3)]
    return {
        "min": vector_json(mins),
        "max": vector_json(maxs),
        "dimensions": vector_json(dimensions),
    }


def union_world_bounds(objects: Sequence[bpy.types.Object]) -> Optional[Dict[str, Any]]:
    records = [object_world_bounds(obj) for obj in objects if obj.type == "MESH"]
    records = [record for record in records if record is not None]
    if not records:
        return None
    mins = [min(record["min"][index] for record in records if record["min"][index] is not None) for index in range(3)]
    maxs = [max(record["max"][index] for record in records if record["max"][index] is not None) for index in range(3)]
    return {
        "min": vector_json(mins),
        "max": vector_json(maxs),
        "dimensions": vector_json(maxs[index] - mins[index] for index in range(3)),
        "mesh_object_count": len(records),
    }


def get_material_input(node: Optional[bpy.types.Node], names: Sequence[str]) -> Any:
    if node is None:
        return None
    for name in names:
        socket = node.inputs.get(name)
        if socket is not None:
            try:
                return socket.default_value
            except (AttributeError, TypeError):
                return None
    return None


def material_record(material: Optional[bpy.types.Material]) -> Optional[Dict[str, Any]]:
    if material is None:
        return None

    record: Dict[str, Any] = {
        "name": material.name,
        "use_nodes": bool(material.use_nodes),
        "diffuse_color": vector_json(material.diffuse_color),
        "surface_render_method": getattr(material, "surface_render_method", None),
        "blend_method": getattr(material, "blend_method", None),
        "properties": {
            "base_color": None,
            "roughness": None,
            "metallic": None,
            "transmission": None,
            "alpha": finite_float(getattr(material, "diffuse_color", [None, None, None, None])[3]),
        },
        "textures": [],
    }

    bsdf = None
    nodes = []
    if material.use_nodes and material.node_tree is not None:
        nodes = list(material.node_tree.nodes)
        bsdf = next((node for node in nodes if node.type == "BSDF_PRINCIPLED"), None)

    base_color = get_material_input(bsdf, ("Base Color",))
    if base_color is not None:
        record["properties"]["base_color"] = vector_json(base_color)
        if len(base_color) >= 4:
            record["properties"]["alpha"] = finite_float(base_color[3])
    roughness = get_material_input(bsdf, ("Roughness",))
    metallic = get_material_input(bsdf, ("Metallic",))
    transmission = get_material_input(bsdf, ("Transmission Weight", "Transmission"))
    alpha = get_material_input(bsdf, ("Alpha",))
    record["properties"]["roughness"] = finite_float(roughness)
    record["properties"]["metallic"] = finite_float(metallic)
    record["properties"]["transmission"] = finite_float(transmission)
    if alpha is not None:
        record["properties"]["alpha"] = finite_float(alpha)

    for node in nodes:
        if node.type != "TEX_IMAGE" or node.image is None:
            continue
        image = node.image
        try:
            size = [int(image.size[0]), int(image.size[1])]
        except Exception:
            size = [None, None]
        record["textures"].append(
            {
                "node": node.name,
                "image": image.name,
                "filepath": image.filepath,
                "packed": bool(getattr(image, "packed_file", None)),
                "size": size,
                "colorspace": getattr(getattr(image, "colorspace_settings", None), "name", None),
            }
        )
    return record


def mesh_record(obj: bpy.types.Object) -> Dict[str, Any]:
    mesh = obj.data
    try:
        mesh.calc_loop_triangles()
    except Exception:
        pass
    attributes = []
    try:
        attributes = [attribute.name for attribute in mesh.attributes]
    except Exception:
        attributes = []
    custom_normals = getattr(mesh, "has_custom_normals", None)
    if custom_normals is None:
        normal_attributes = [name for name in attributes if "normal" in name.lower()]
        custom_normals = bool(normal_attributes) if normal_attributes else None
    return {
        "object_name": obj.name,
        "mesh_name": mesh.name,
        "vertex_count": len(mesh.vertices),
        "edge_count": len(mesh.edges),
        "polygon_count": len(mesh.polygons),
        "triangle_count": len(mesh.loop_triangles),
        "material_slots": [slot.material.name if slot.material else None for slot in obj.material_slots],
        "attributes": attributes,
        "custom_normals": custom_normals,
        "use_auto_smooth": getattr(mesh, "use_auto_smooth", None),
        "world_bounds": object_world_bounds(obj),
    }


def object_record(obj: bpy.types.Object, imported_names: set[str]) -> Dict[str, Any]:
    parent_name = obj.parent.name if obj.parent else None
    record: Dict[str, Any] = {
        "name": obj.name,
        "type": obj.type,
        "parent": parent_name,
        "parent_is_imported": parent_name in imported_names if parent_name else False,
        "hide_viewport": bool(obj.hide_viewport),
        "hide_render": bool(obj.hide_render),
        "visible_get": bool(obj.visible_get()),
        "location": vector_json(obj.location),
        "rotation_euler": vector_json(obj.rotation_euler),
        "rotation_quaternion": vector_json(obj.rotation_quaternion),
        "scale": vector_json(obj.scale),
        "matrix_world": matrix_json(obj.matrix_world),
        "world_bounds": object_world_bounds(obj),
        "animation_data": bool(obj.animation_data),
    }
    if obj.type == "MESH":
        record["mesh_name"] = obj.data.name
        record["vertex_count"] = len(obj.data.vertices)
        record["triangle_count"] = len(obj.data.loop_triangles)
    return record


def action_record(action: bpy.types.Action) -> Dict[str, Any]:
    frame_start, frame_end = action.frame_range
    keyframe_count = 0
    fcurves = []
    try:
        for curve in action.fcurves:
            points = len(curve.keyframe_points)
            keyframe_count += points
            fcurves.append({"data_path": curve.data_path, "array_index": curve.array_index, "keyframe_count": points})
    except Exception:
        pass
    return {
        "name": action.name,
        "frame_start": finite_float(frame_start),
        "frame_end": finite_float(frame_end),
        "keyframe_count": keyframe_count,
        "fcurves": fcurves,
    }


def animation_review(objects: Sequence[bpy.types.Object], scene: bpy.types.Scene, label: str) -> Dict[str, Any]:
    animated_objects = []
    actions_by_pointer: Dict[int, bpy.types.Action] = {}
    for obj in objects:
        data = obj.animation_data
        if data is None:
            continue
        action = data.action
        nla_tracks = len(data.nla_tracks) if data.nla_tracks else 0
        animated_objects.append({"object": obj.name, "action": action.name if action else None, "nla_track_count": nla_tracks})
        if action is not None:
            actions_by_pointer[action.as_pointer()] = action

    actions = list(actions_by_pointer.values())
    scene_start = float(scene.frame_start)
    scene_end = float(scene.frame_end)
    candidate_frames = [scene_start, scene_end]
    for action in actions:
        action_start, action_end = action.frame_range
        candidate_frames.extend([float(action_start), float(action_end), (float(action_start) + float(action_end)) * 0.5])
    unique_frames = []
    for frame in candidate_frames:
        if not any(abs(frame - existing) < 1e-5 for existing in unique_frames):
            unique_frames.append(frame)
    unique_frames = sorted(unique_frames)[:12]

    review: Dict[str, Any] = {
        "has_animation": bool(animated_objects or actions),
        "scene_frame_range": [scene_start, scene_end],
        "animated_objects": animated_objects,
        "actions": [action_record(action) for action in actions],
        "sampled_frames": [],
        "static_pose_frame": None,
        "bounds_change_detected": False,
    }
    if not unique_frames:
        return review

    previous_frame = scene.frame_current
    base_bounds = None
    for frame in unique_frames:
        try:
            scene.frame_set(frame)
        except Exception:
            continue
        bounds = union_world_bounds(objects)
        sample = {"frame": finite_float(frame), "bounds": bounds}
        review["sampled_frames"].append(sample)
        if base_bounds is None:
            base_bounds = bounds
        elif bounds and base_bounds:
            base_dims = base_bounds["dimensions"]
            dims = bounds["dimensions"]
            if any(base_dims[index] is not None and dims[index] is not None and abs(dims[index] - base_dims[index]) > 0.005 for index in range(3)):
                review["bounds_change_detected"] = True

    if actions:
        earliest = min(float(action.frame_range[0]) for action in actions)
        review["static_pose_frame"] = finite_float(earliest)
    elif "mx5" in label.lower():
        review["static_pose_frame"] = scene_start
    try:
        scene.frame_set(previous_frame)
    except Exception:
        pass
    return review


def raw_audit_record(objects: Sequence[bpy.types.Object], scene: bpy.types.Scene, label: str, filepath: str) -> Dict[str, Any]:
    imported_names = {obj.name for obj in objects}
    meshes = [obj for obj in objects if obj.type == "MESH"]
    materials_by_name: Dict[str, bpy.types.Material] = {}
    for obj in meshes:
        for slot in obj.material_slots:
            if slot.material is not None:
                materials_by_name[slot.material.name] = slot.material

    mesh_records = [mesh_record(obj) for obj in meshes]
    return {
        "label": label,
        "source_filepath": os.path.abspath(filepath),
        "source_size_bytes": os.path.getsize(filepath) if os.path.exists(filepath) else None,
        "objects": [object_record(obj, imported_names) for obj in objects],
        "meshes": mesh_records,
        "materials": [material_record(material) for material in materials_by_name.values()],
        "mesh_count": len(meshes),
        "object_count": len(objects),
        "vertex_count_total": sum(record["vertex_count"] for record in mesh_records),
        "triangle_count_total": sum(record["triangle_count"] for record in mesh_records),
        "world_bounds": union_world_bounds(objects),
        "animation_review": animation_review(objects, scene, label),
        "orientation_review": {
            "resolved": False,
            "labels": ["generic_A", "generic_B"],
            "note": "Vehicle front/rear was intentionally left unresolved. The two previews are opposite 3/4 camera views for human orientation review.",
        },
    }


def import_gltf(filepath: str) -> List[bpy.types.Object]:
    before_pointers = {obj.as_pointer() for obj in bpy.data.objects}
    bpy.ops.import_scene.gltf(filepath=filepath)
    return unique_objects(before_pointers)


def normalize_model(objects: Sequence[bpy.types.Object], raw_bounds: Dict[str, Any]) -> Dict[str, Any]:
    raw_dimensions = raw_bounds["dimensions"]
    raw_min = raw_bounds["min"]
    raw_max = raw_bounds["max"]
    xy_length = max(float(raw_dimensions[0]), float(raw_dimensions[1])) if raw_dimensions[0] is not None and raw_dimensions[1] is not None else 0.0
    if not math.isfinite(xy_length) or xy_length <= 1e-9:
        scale_factor = 1.0
        status = "NO_VALID_XY_EXTENT"
    else:
        scale_factor = TARGET_MODEL_LENGTH_M / xy_length
        status = "OK"

    root = bpy.data.objects.new("car_art_baseline_root", None)
    bpy.context.scene.collection.objects.link(root)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.25
    root["baseline_normalization_target_m"] = TARGET_MODEL_LENGTH_M
    root["baseline_source_xy_length"] = xy_length
    root["baseline_normalization_scale"] = scale_factor

    imported_names = {obj.name for obj in objects}
    top_level = [obj for obj in objects if obj.parent is None or obj.parent.name not in imported_names]
    for obj in top_level:
        world_matrix = obj.matrix_world.copy()
        obj.parent = root
        obj.matrix_world = world_matrix

    center_x = (float(raw_min[0]) + float(raw_max[0])) * 0.5 if raw_min[0] is not None and raw_max[0] is not None else 0.0
    center_y = (float(raw_min[1]) + float(raw_max[1])) * 0.5 if raw_min[1] is not None and raw_max[1] is not None else 0.0
    min_z = float(raw_min[2]) if raw_min[2] is not None else 0.0
    root.scale = (scale_factor, scale_factor, scale_factor)
    root.location = (-center_x * scale_factor, -center_y * scale_factor, -min_z * scale_factor)
    root.rotation_euler = (0.0, 0.0, 0.0)

    for obj in objects:
        if obj.type in {"CAMERA", "LIGHT"}:
            obj.hide_render = True

    return {
        "status": status,
        "target_length_m": TARGET_MODEL_LENGTH_M,
        "raw_xy_length": xy_length,
        "scale_factor": scale_factor,
        "raw_center_xy": [center_x, center_y],
        "raw_min_z": min_z,
        "root_name": root.name,
        "note": "All imported top-level objects share one uniform scale and translation. Original child hierarchy and vehicle proportions are retained.",
    }


def make_principled_material(name: str, color: Tuple[float, float, float, float], roughness: float, metallic: float = 0.0) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    bsdf = next((node for node in nodes if node.type == "BSDF_PRINCIPLED"), None)
    if bsdf is not None:
        base = bsdf.inputs.get("Base Color")
        if base is not None:
            base.default_value = color
        rough = bsdf.inputs.get("Roughness")
        if rough is not None:
            rough.default_value = roughness
        metal = bsdf.inputs.get("Metallic")
        if metal is not None:
            metal.default_value = metallic
    return material


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    direction = target - obj.location
    if direction.length > 1e-8:
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def build_render_setup(scene: bpy.types.Scene, normalized_bounds: Dict[str, Any]) -> Dict[str, Any]:
    dimensions = normalized_bounds["dimensions"]
    max_span = max(float(value) for value in dimensions if value is not None)
    floor_size = max(20.0, max_span * 6.0)

    bpy.ops.mesh.primitive_plane_add(size=floor_size, location=(0.0, 0.0, -0.003))
    floor = bpy.context.object
    floor.name = "baseline_gray_floor"
    floor["baseline_helper"] = True
    floor.data.materials.append(make_principled_material("baseline_floor_gray", (0.16, 0.17, 0.18, 1.0), 0.72))

    world = bpy.data.worlds.new("baseline_neutral_world")
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background is not None:
        background.inputs["Color"].default_value = (0.055, 0.06, 0.07, 1.0)
        background.inputs["Strength"].default_value = 0.32

    camera_data = bpy.data.cameras.new("baseline_fixed_camera")
    camera = bpy.data.objects.new("baseline_fixed_camera", camera_data)
    scene.collection.objects.link(camera)
    camera_data.lens = 52.0
    camera_data.sensor_width = 36.0
    camera_data.clip_start = 0.05
    camera_data.clip_end = 1000.0
    scene.camera = camera

    target = Vector((0.0, 0.0, max(0.35, float(normalized_bounds["min"][2] or 0.0) + float(dimensions[2] or 1.0) * 0.42)))
    span = max(float(dimensions[0] or 1.0), float(dimensions[1] or 1.0))
    light_specs = [
        ("baseline_key_rect", (span * 1.25, -span * 1.55, span * 1.55), (1200.0, 5.0, 4.0), (1.0, 0.82, 0.68)),
        ("baseline_fill_rect", (-span * 1.15, -span * 0.65, span * 0.9), (650.0, 4.0, 3.0), (0.62, 0.76, 1.0)),
        ("baseline_rim_rect", (-span * 0.9, span * 1.35, span * 1.75), (1050.0, 4.0, 4.0), (0.72, 0.85, 1.0)),
    ]
    for name, location, (energy, size, size_y), color in light_specs:
        data = bpy.data.lights.new(name, type="AREA")
        data.energy = energy
        data.shape = "RECTANGLE"
        data.size = size
        data.size_y = size_y
        data.color = color
        obj = bpy.data.objects.new(name, data)
        scene.collection.objects.link(obj)
        obj.location = location
        look_at(obj, target)

    engine_used = None
    for candidate in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = candidate
            engine_used = candidate
            break
        except Exception:
            continue
    if engine_used is None:
        scene.render.engine = "CYCLES"
        engine_used = "CYCLES"
        try:
            scene.cycles.samples = 16
            scene.cycles.use_denoising = True
            scene.cycles.device = "CPU"
        except Exception:
            pass

    scene.render.resolution_x = 900
    scene.render.resolution_y = 600
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        pass
    try:
        scene.render.engine = engine_used
        if engine_used == "CYCLES":
            scene.cycles.samples = 16
            scene.cycles.use_denoising = True
            scene.cycles.device = "CPU"
    except Exception:
        pass
    return {
        "engine": engine_used,
        "threads": 4,
        "resolution": [900, 600],
        "samples": 16 if engine_used == "CYCLES" else None,
        "camera_name": camera.name,
        "floor_name": floor.name,
        "light_names": [spec[0] for spec in light_specs],
        "camera_target": vector_json(target),
    }


def camera_for_view(scene: bpy.types.Scene, view_label: str, normalized_bounds: Dict[str, Any]) -> Dict[str, Any]:
    camera = scene.camera
    dimensions = normalized_bounds["dimensions"]
    height = float(dimensions[2] or 1.0)
    span = max(float(dimensions[0] or 1.0), float(dimensions[1] or 1.0))
    target = Vector((0.0, 0.0, max(0.35, float(normalized_bounds["min"][2] or 0.0) + height * 0.42)))
    horizontal = Vector((1.0, -1.0, 0.0)) if view_label == "generic_A" else Vector((-1.0, 1.0, 0.0))
    horizontal.normalize()
    distance = max(span * 1.72, height * 2.5)
    location = target + horizontal * distance + Vector((0.0, 0.0, max(height * 0.58, span * 0.38)))
    camera.location = location
    look_at(camera, target)
    return {
        "label": view_label,
        "location": vector_json(location),
        "target": vector_json(target),
        "orientation_semantics": "generic opposite 3/4 view; vehicle front/rear intentionally unresolved",
    }


def render_views(scene: bpy.types.Scene, normalized_bounds: Dict[str, Any], render_dir: str) -> Dict[str, Any]:
    os.makedirs(render_dir, exist_ok=True)
    records = []
    for view_label, filename in (("generic_A", "view-generic-A.png"), ("generic_B", "view-generic-B.png")):
        camera_record = camera_for_view(scene, view_label, normalized_bounds)
        output_path = os.path.abspath(os.path.join(render_dir, filename))
        scene.render.filepath = output_path
        started = time.perf_counter()
        try:
            bpy.ops.render.render(write_still=True)
            exists = os.path.isfile(output_path) and os.path.getsize(output_path) > 0
            status = "PASS" if exists else "RENDER_NO_OUTPUT"
            error = None
        except Exception as exc:
            status = "RENDER_ERROR"
            exists = False
            error = repr(exc)
        records.append(
            {
                "status": status,
                "path": output_path,
                "exists_nonzero": exists,
                "elapsed_seconds": round(time.perf_counter() - started, 3),
                "camera": camera_record,
                "error": error,
            }
        )
    return {"views": records, "elapsed_seconds": round(sum(record["elapsed_seconds"] for record in records), 3)}


def save_baseline(scene: bpy.types.Scene, path: str) -> Dict[str, Any]:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    started = time.perf_counter()
    try:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(path))
        exists = os.path.isfile(path) and os.path.getsize(path) > 0
        return {"status": "PASS" if exists else "SAVE_NO_OUTPUT", "path": os.path.abspath(path), "exists_nonzero": exists, "elapsed_seconds": round(time.perf_counter() - started, 3)}
    except Exception as exc:
        return {"status": "SAVE_ERROR", "path": os.path.abspath(path), "exists_nonzero": False, "elapsed_seconds": round(time.perf_counter() - started, 3), "error": repr(exc)}


def process_model(filepath: str, label: str, mode: str, output_root: str) -> Dict[str, Any]:
    started = time.perf_counter()
    result: Dict[str, Any] = {
        "status": "STARTED",
        "label": label,
        "mode": mode,
        "source_filepath": os.path.abspath(filepath),
        "blender_version": bpy.app.version_string,
    }
    try:
        clear_scene()
        scene = bpy.context.scene
        scene.unit_settings.system = "METRIC"
        scene.unit_settings.scale_length = 1.0
        scene.frame_set(0)
        imported = import_gltf(filepath)
        if not imported:
            raise RuntimeError("GLTF import completed without creating objects")
        result["imported_object_names"] = [obj.name for obj in imported]
        raw = raw_audit_record(imported, scene, label, filepath)
        result["audit"] = raw
        if not raw["meshes"] or raw["world_bounds"] is None:
            raise RuntimeError("Model has no mesh objects with usable world bounds")

        if mode == "public":
            normalization = normalize_model(imported, raw["world_bounds"])
            scene.frame_set(raw["animation_review"]["static_pose_frame"] if raw["animation_review"]["static_pose_frame"] is not None else 0)
            normalized_bounds = union_world_bounds(imported)
            if normalized_bounds is None:
                raise RuntimeError("Normalized model has no usable world bounds")
            result["normalization"] = normalization
            result["normalized_world_bounds"] = normalized_bounds
            result["abnormal_floating_objects"] = []
            baseline_min_z = float(normalized_bounds["min"][2] or 0.0)
            for obj in imported:
                bounds = object_world_bounds(obj)
                if bounds is None:
                    continue
                obj_min_z = float(bounds["min"][2] or 0.0)
                gap = obj_min_z - baseline_min_z
                if gap > max(0.08, float(normalized_bounds["dimensions"][2] or 1.0) * 0.08):
                    result["abnormal_floating_objects"].append({"object": obj.name, "min_z": obj_min_z, "gap_above_lowest_m": gap, "bounds": bounds})
            render_setup = build_render_setup(scene, normalized_bounds)
            result["render_setup"] = render_setup
            baseline_path = os.path.join(output_root, "baselines", label, "baseline.blend")
            result["baseline_save"] = save_baseline(scene, baseline_path)
            result["render"] = render_views(scene, normalized_bounds, os.path.join(output_root, "renders", label))
            result["status"] = "PASS" if result["baseline_save"]["status"] == "PASS" and all(view["status"] == "PASS" for view in result["render"]["views"]) else "PARTIAL"
        else:
            result["status"] = "PASS"
    except Exception as exc:
        result["status"] = "ERROR"
        result["error"] = repr(exc)
        result["traceback"] = traceback.format_exc()
    result["elapsed_seconds"] = round(time.perf_counter() - started, 3)
    return result


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", default=os.getcwd())
    parser.add_argument("--out", default=os.path.join(os.getcwd(), "scratch", "car-art-20260907"))
    parser.add_argument("--public-dir", default=None)
    parser.add_argument("--source-dir", default=None)
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    project_root = os.path.abspath(args.project_root)
    output_root = os.path.abspath(args.out)
    public_dir = os.path.abspath(args.public_dir or os.path.join(project_root, "public", "cars"))
    source_dir = os.path.abspath(args.source_dir or os.path.join(project_root, "source-models"))
    os.makedirs(os.path.join(output_root, "audit", "public"), exist_ok=True)
    os.makedirs(os.path.join(output_root, "audit", "source"), exist_ok=True)
    summary: Dict[str, Any] = {
        "status": "RUNNING",
        "started_at_epoch": time.time(),
        "blender_version": bpy.app.version_string,
        "requested": {
            "threads": 4,
            "render_resolution": [900, 600],
            "cycles_samples_if_used": 16,
            "public_files": list(PUBLIC_CAR_FILES),
            "source_files": list(SOURCE_CAR_FILES),
        },
        "models": [],
    }
    run_started = time.perf_counter()

    for filename in PUBLIC_CAR_FILES:
        filepath = os.path.join(public_dir, filename)
        label = os.path.splitext(filename)[0]
        result = process_model(filepath, label, "public", output_root)
        summary["models"].append({"label": label, "mode": "public", "status": result["status"], "elapsed_seconds": result["elapsed_seconds"]})
        write_json(os.path.join(output_root, "audit", "public", f"{label}.json"), result)

    for filename in SOURCE_CAR_FILES:
        filepath = os.path.join(source_dir, filename)
        label = os.path.splitext(filename)[0]
        result = process_model(filepath, label, "source", output_root)
        summary["models"].append({"label": label, "mode": "source", "status": result["status"], "elapsed_seconds": result["elapsed_seconds"]})
        write_json(os.path.join(output_root, "audit", "source", f"{label}.json"), result)

    summary["elapsed_seconds"] = round(time.perf_counter() - run_started, 3)
    summary["completed_at_epoch"] = time.time()
    summary["status"] = "PASS" if all(model["status"] == "PASS" for model in summary["models"]) else "PARTIAL"
    write_json(os.path.join(output_root, "audit", "summary.json"), summary)


if __name__ == "__main__":
    main()
