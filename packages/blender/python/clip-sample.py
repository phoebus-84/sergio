"""Read a motion out of a file. Runs inside Blender.

A clip made for one skeleton is carried to another by copying, bone by bone,
how far each has turned from its rest pose, measured in the world and not in
the bone's own axes (two rigs point their bones in different ways). This
script does the measuring: it plays a clip in a .glb or an .fbx and writes,
for every frame and every bone, that turn and where the bone is.

Everything is written in glTF's axes (y up), whatever the file's own were.
"""
import json
import sys
from pathlib import Path

import bpy

cfg = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text())
MAX_FRAMES = int(cfg["maxFrames"])


def moving(actions):
    return [a for a in actions if a.frame_range[1] - a.frame_range[0] > 1.5]


def point(v):
    # Blender's z is glTF's y; Blender's -y is glTF's z.
    return [round(v.x, 5), round(v.z, 5), round(-v.y, 5)]


def turn(q):
    # A rotation's axis moves as a point does: x y z w, in glTF's order.
    return [round(q.x, 6), round(q.z, 6), round(-q.y, 6), round(q.w, 6)]


def main():
    path = cfg["path"]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if path.lower().endswith(".fbx"):
        bpy.ops.import_scene.fbx(filepath=path)
    else:
        bpy.ops.import_scene.gltf(filepath=path)
    scene = bpy.context.scene
    armatures = [o for o in scene.objects if o.type == "ARMATURE"]
    if not armatures:
        raise RuntimeError("the file has no skeleton: there is no motion to read")
    arm = max(armatures, key=lambda o: len(o.data.bones))
    found = moving(bpy.data.actions)
    names = [a.name for a in found]
    if cfg.get("action"):
        chosen = [a for a in found if a.name == cfg["action"]]
        if not chosen:
            raise RuntimeError(f"the file holds no clip named {cfg['action']}: it holds {', '.join(names) or 'none'}")
        action = chosen[0]
    elif found:
        action = max(found, key=lambda a: a.frame_range[1] - a.frame_range[0])
    else:
        raise RuntimeError("the file holds no motion: only a pose, or nothing")

    # The rest pose first: what every turn is measured from.
    arm.animation_data_clear()
    arm.data.pose_position = "REST"
    bpy.context.view_layer.update()
    world = arm.matrix_world.copy()
    rest = {b.name: (world @ b.matrix).to_quaternion() for b in arm.pose.bones}
    bones = [{"name": b.name, "parent": b.parent.name if b.parent else None, "rest": point(world @ b.head)} for b in arm.pose.bones]

    arm.data.pose_position = "POSE"
    arm.animation_data_create()
    arm.animation_data.action = action
    data = arm.animation_data
    if getattr(data, "action_slot", "none") is None and getattr(action, "slots", None):
        data.action_slot = action.slots[0]
    first, last = (int(round(v)) for v in action.frame_range)
    fps = scene.render.fps / scene.render.fps_base
    step = max(1, -(-(last - first + 1) // MAX_FRAMES))
    frames = list(range(first, last + 1, step))
    rotations = {b.name: [] for b in arm.pose.bones}
    positions = {b.name: [] for b in arm.pose.bones}
    for frame in frames:
        scene.frame_set(frame)
        world = arm.matrix_world
        for b in arm.pose.bones:
            now = (world @ b.matrix).to_quaternion()
            rotations[b.name].append(turn(now @ rest[b.name].inverted()))
            positions[b.name].append(point(world @ b.head))
    out = {
        "action": action.name, "actions": names, "fps": round(fps / step, 4), "seconds": round((frames[-1] - frames[0]) / fps, 4),
        "times": [round((f - frames[0]) / fps, 5) for f in frames],
        "bones": bones, "rotations": rotations, "positions": positions,
    }
    (Path(cfg["outputDir"]) / "clip.json").write_text(json.dumps(out))


main()
