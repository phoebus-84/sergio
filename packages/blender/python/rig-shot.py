"""Film a rigged character playing a clip. Runs inside Blender.

The last step from a character to a picture: the body, lit, on a plain
ground, seen by a camera that is asked for in the words a shot is described
in (front, three-quarter, side; full, medium, close), playing the one motion
the file holds. Frames are written as PNGs; the caller joins them.

No script comes with the request: the camera, the light and the ground are
made here from the body's own size and the way it faces.
"""
import json
import math
import sys
from pathlib import Path

import bpy
import mathutils

cfg = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text())
OUT = Path(cfg["outputDir"])
UP = mathutils.Vector((0, 0, 1))
# glTF's +z is Blender's -y; x is x.
FRONT = mathutils.Vector({"+z": (0, -1, 0), "-z": (0, 1, 0), "+x": (1, 0, 0), "-x": (-1, 0, 0)}[cfg["faces"]])
SIDE = UP.cross(FRONT)
# Where the camera stands, seen from the body: towards its front, its own left, or between.
VIEWS = {"front": FRONT, "three-quarter": FRONT + SIDE * 0.75, "side": SIDE, "back": -FRONT}
# How much of the body's height a frame holds, the height it is aimed at (both in heights of the body),
# and how much of the body's width it must hold whatever its shape: a tall frame is not let cut the shoulders.
FRAMINGS = {"full": (1.3, 0.5, 1.25), "medium": (0.62, 0.72, 0.8), "close": (0.36, 0.86, 0.55)}


def colour(text):
    value = text.lstrip("#")
    return tuple(int(value[i:i + 2], 16) / 255 for i in (0, 2, 4))


def linear(c):
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def moving(actions):
    return [a for a in actions if a.frame_range[1] - a.frame_range[0] > 1.5]


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=cfg["path"])
    scene = bpy.context.scene
    armatures = [o for o in scene.objects if o.type == "ARMATURE"]
    if not armatures:
        raise RuntimeError("the file has no skeleton: there is no character to film")
    arm = max(armatures, key=lambda o: len(o.data.bones))
    body = [o for o in scene.objects if o.type == "MESH" and (any(m.type == "ARMATURE" and m.object for m in o.modifiers) or o.parent_type == "BONE")]
    if not body:
        raise RuntimeError("no part of the body follows the skeleton: there is no character to film")
    for o in scene.objects:
        if o.type == "MESH" and o not in body:
            o.hide_render = True  # the importer's bone shapes

    found = moving(bpy.data.actions)
    action = max(found, key=lambda a: a.frame_range[1] - a.frame_range[0]) if found else None
    imported_fps = scene.render.fps / scene.render.fps_base
    arm.animation_data_clear()
    for bone in arm.pose.bones:
        bone.matrix_basis = mathutils.Matrix.Identity(4)
    bpy.context.view_layer.update()

    # The body at rest: how tall it is, where it stands.
    corners = [o.matrix_world @ mathutils.Vector(c) for o in body for c in o.bound_box]
    low = mathutils.Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    high = mathutils.Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    tall = high.z - low.z
    wide = abs((high - low).dot(SIDE))
    centre = (low + high) / 2

    if action:
        arm.animation_data_create()
        arm.animation_data.action = action
        data = arm.animation_data
        if getattr(data, "action_slot", "none") is None and getattr(action, "slots", None):
            data.action_slot = action.slots[0]
    first, last = action.frame_range if action else (0, 0)
    clip_seconds = (last - first) / imported_fps if action else 0
    fps = cfg["fps"]
    seconds = cfg.get("seconds") or (clip_seconds * cfg["loops"] if action else 2.0)
    frames = max(1, round(seconds * fps))
    if frames > cfg["maxFrames"]:
        raise RuntimeError(f"the shot would be {frames} frames ({seconds:.1f}s at {fps} a second): at most {cfg['maxFrames']}. Ask for fewer seconds or loops")

    # What the camera follows: the root of the skeleton, which is what a clip moves over the ground.
    roots = [b for b in arm.pose.bones if b.parent is None]
    lead = max(roots, key=lambda b: len(b.children_recursive)) if roots else None
    def where():
        return arm.matrix_world @ lead.head if lead else centre.copy()
    start = where()

    # Camera.
    width, height = cfg["width"], cfg["height"]
    share, aim, across = FRAMINGS[cfg["framing"]]
    held = max(tall * share, wide * across * height / width)
    data = bpy.data.cameras.new("camera")
    data.lens = 85 if cfg["framing"] == "close" else 50
    data.sensor_fit = "VERTICAL"
    data.sensor_height = 24
    distance = (held / 2) / math.tan(math.atan(12 / data.lens))
    data.clip_start, data.clip_end = distance / 100, distance * 100
    camera = bpy.data.objects.new("camera", data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    view = mathutils.Vector(VIEWS[cfg["camera"]]).normalized()
    target = mathutils.Vector((centre.x, centre.y, low.z + tall * aim))
    # A little above what it looks at, so the ground is seen and the face is not looked up at.
    offset = view * distance + UP * distance * 0.12
    def place(at):
        camera.location = at + offset
        camera.rotation_euler = (at - camera.location).to_track_quat("-Z", "Y").to_euler()
    place(target)

    # Light, ground and what is behind them.
    back = colour(cfg["background"])
    world = bpy.data.worlds.new("world")
    world.use_nodes = True
    shade = world.node_tree.nodes["Background"]
    shade.inputs[0].default_value = (*linear(back), 1)
    shade.inputs[1].default_value = 1.0
    scene.world = world
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.2
    sun.data.angle = math.radians(12)
    scene.collection.objects.link(sun)
    towards = (view + SIDE * 0.6 + UP * 1.4).normalized()
    sun.rotation_euler = (-towards).to_track_quat("-Z", "Y").to_euler()
    if cfg["ground"]:
        bpy.ops.mesh.primitive_circle_add(vertices=96, radius=tall * 8, fill_type="NGON", location=(centre.x, centre.y, low.z))
        ground = bpy.context.active_object
        material = bpy.data.materials.new("ground")
        material.use_nodes = True
        surface = material.node_tree.nodes["Principled BSDF"]
        surface.inputs["Base Color"].default_value = (*linear(tuple(v * 0.96 for v in back)), 1)
        surface.inputs["Roughness"].default_value = 1.0
        ground.data.materials.append(material)
    else:
        ground = None

    scene.render.engine = "BLENDER_EEVEE" if bpy.app.version >= (5, 0, 0) else "BLENDER_EEVEE_NEXT"
    scene.eevee.taa_render_samples = cfg["samples"]
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False

    (OUT / "frames").mkdir()
    travel = 0.0
    for index in range(frames):
        if action:
            at = (index / fps) % clip_seconds if clip_seconds > 0 else 0
            source = first + at * imported_fps
            scene.frame_set(int(math.floor(source)), subframe=source - math.floor(source))
        moved = where() - start
        moved.z = 0
        travel = max(travel, moved.length)
        if cfg["follow"]:
            place(target + moved)
            if ground:
                ground.location = (centre.x + moved.x, centre.y + moved.y, low.z)
        scene.render.filepath = str(OUT / "frames" / f"{index + 1:06d}.png")
        bpy.ops.render.render(write_still=True)

    (OUT / "shot.json").write_text(json.dumps({
        "frames": frames, "fps": fps, "seconds": round(frames / fps, 3), "width": width, "height": height,
        "action": action.name if action else None, "clipSeconds": round(clip_seconds, 3),
        "camera": cfg["camera"], "framing": cfg["framing"], "follow": bool(cfg["follow"]),
        # How far the body goes over the ground, in its own heights.
        "travel": round(travel / max(tall, 1e-9), 2),
        "body": {"tall": round(tall, 3), "wide": round(wide, 3)},
        "engine": scene.render.engine, "blender": bpy.app.version_string,
    }, indent=2) + "\n")


main()
