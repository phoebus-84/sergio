"""Pose a rigged model and render what it looks like. Runs inside Blender.

A rig that is right at rest is the usual way an automatic rig is wrong: the
skeleton fits, and the body tears the first time it moves. This puts the
body in known poses, renders each from three sides on one sheet, and
measures how far the surface was pulled — so a rig is judged in motion,
and two rigs of one body can be compared in the same poses.

Poses are turns about the body's own axes (front, up, side) through a
bone's head, never about the bone's own axes: two rigs point their bones in
different ways, and the same numbers would give two different poses.
"""
import json
import math
import re
import sys
from pathlib import Path

import bpy
import mathutils
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import body  # noqa: E402

cfg = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text())
OUT = Path(cfg["outputDir"])
TILE = int(cfg["tile"])
SAMPLES = int(cfg["clipFrames"])
UP = mathutils.Vector((0, 0, 1))
# glTF's +z is Blender's -y; x is x.
FRONT = mathutils.Vector({"+z": (0, -1, 0), "-z": (0, 1, 0), "+x": (1, 0, 0), "-x": (-1, 0, 0)}[cfg["faces"]])
# The body's own left: the side its left arm is on.
SIDE = UP.cross(FRONT)
AXES = {"front": FRONT, "up": UP, "side": SIDE}
VIEWS = [("front", FRONT), ("three-quarter", (FRONT + SIDE * 0.8 + UP * 0.3).normalized()), ("side", SIDE)]
# An edge pulled to half as long again, or pressed to two thirds, is strained; to three times, torn.
STRAINED, TORN = 1.5, 3.0
BODY_COLOUR, LABEL_COLOUR, GROUND = (0.55, 0.6, 0.7, 1), (1, 1, 1, 1), (0.14, 0.14, 0.16)
notes = []


class Rig:
    """One imported file: its armature, the meshes it moves, and where it stands at rest."""

    def __init__(self, path):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=path)
        self.scene = bpy.context.scene
        armatures = [o for o in self.scene.objects if o.type == "ARMATURE"]
        if not armatures:
            raise RuntimeError("the file has no skeleton: there is nothing to pose")
        self.arm = max(armatures, key=lambda o: len(o.data.bones))
        if len(armatures) > 1:
            notes.append(f"the file holds {len(armatures)} skeletons: the one with most bones ({self.arm.name}) is posed")
        skinned = [o for o in self.scene.objects if o.type == "MESH" and any(m.type == "ARMATURE" and m.object for m in o.modifiers)]
        carried = [o for o in self.scene.objects if o.type == "MESH" and o.parent_type == "BONE" and o not in skinned]
        self.body = skinned + carried
        if not self.body:
            raise RuntimeError("no part of the body follows the skeleton: there is nothing to pose")
        for o in self.scene.objects:
            if o.type == "MESH" and o not in self.body:
                o.hide_render = True  # the importer's bone shapes, and anything no bone moves
            if o.type == "MESH":
                o.color = BODY_COLOUR
        self.actions = list(bpy.data.actions)
        self.rest()
        self.rest_lengths = self.lengths()
        low, high = self.box()
        self.low, self.high = low, high
        self.centre = (low + high) / 2
        self.size = high - low
        self.reach = max(self.size) * 1.45
        self._stage()

    # -- the body --------------------------------------------------------
    def rest(self):
        self.arm.animation_data_clear()
        self.arm.data.pose_position = "POSE"
        for bone in self.arm.pose.bones:
            bone.matrix_basis = mathutils.Matrix.Identity(4)
        bpy.context.view_layer.update()

    def _meshes(self):
        graph = bpy.context.evaluated_depsgraph_get()
        for o in self.body:
            evaluated = o.evaluated_get(graph)
            mesh = evaluated.to_mesh()
            count = len(mesh.vertices)
            co = np.empty(count * 3, dtype=np.float32)
            mesh.vertices.foreach_get("co", co)
            edges = np.empty(len(mesh.edges) * 2, dtype=np.int32)
            mesh.edges.foreach_get("vertices", edges)
            world = np.array(evaluated.matrix_world, dtype=np.float32)
            yield co.reshape(-1, 3), edges.reshape(-1, 2), world
            evaluated.to_mesh_clear()

    def lengths(self):
        out = []
        for co, edges, world in self._meshes():
            placed = co @ world[:3, :3].T
            out.append(np.linalg.norm(placed[edges[:, 0]] - placed[edges[:, 1]], axis=1))
        return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)

    def box(self):
        low, high = np.full(3, np.inf), np.full(3, -np.inf)
        for co, _edges, world in self._meshes():
            if len(co) == 0:
                continue
            placed = co @ world[:3, :3].T + world[:3, 3]
            low, high = np.minimum(low, placed.min(axis=0)), np.maximum(high, placed.max(axis=0))
        return mathutils.Vector(low.tolist()), mathutils.Vector(high.tolist())

    def strain(self):
        """How much of the surface this pose pulled out of shape, against the rest pose."""
        now = self.lengths()
        if len(now) != len(self.rest_lengths) or len(now) == 0:
            return {"strained": 0.0, "torn": 0}
        ratio = now / np.maximum(self.rest_lengths, 1e-9)
        strained = np.count_nonzero((ratio > STRAINED) | (ratio < 1 / STRAINED))
        return {"strained": round(float(strained) / len(now), 4), "torn": int(np.count_nonzero(ratio > TORN))}

    # -- posing ----------------------------------------------------------
    def turn(self, bone, axis, degrees):
        body.turn(self.arm, bone, axis, degrees)

    def place(self, bone):
        return self.arm.matrix_world @ bone.head

    # -- the camera, the light, the label ---------------------------------
    def _stage(self):
        scene = self.scene
        scene.render.engine = "BLENDER_WORKBENCH"
        shading = scene.display.shading
        shading.light = "STUDIO"
        shading.color_type = "OBJECT"
        shading.show_cavity = True
        shading.cavity_type = "BOTH"
        shading.show_shadows = False
        shading.show_object_outline = True
        scene.render.film_transparent = False
        scene.render.resolution_x = scene.render.resolution_y = TILE
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "PNG"
        scene.view_settings.view_transform = "Standard"
        world = bpy.data.worlds.new("ground")
        world.color = GROUND
        scene.world = world
        data = bpy.data.cameras.new("camera")
        data.type = "ORTHO"
        data.ortho_scale = self.reach
        data.clip_start, data.clip_end = 0.001, self.reach * 20
        self.camera = bpy.data.objects.new("camera", data)
        scene.collection.objects.link(self.camera)
        scene.camera = self.camera
        text = bpy.data.curves.new("label", "FONT")
        text.align_x, text.align_y = "LEFT", "TOP"
        text.size = self.reach * 0.055
        self.label = bpy.data.objects.new("label", text)
        self.label.color = LABEL_COLOUR
        scene.collection.objects.link(self.label)

    def shoot(self, path, view, label, centre=None):
        centre = centre or self.centre
        direction = mathutils.Vector(view).normalized()
        distance = self.reach * 6
        self.camera.location = centre + direction * distance
        self.camera.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
        bpy.context.view_layer.update()
        margin = self.reach * 0.03
        self.label.data.body = label
        self.label.matrix_world = self.camera.matrix_world @ mathutils.Matrix.Translation((-self.reach / 2 + margin, self.reach / 2 - margin, -self.reach))
        self.scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)


# -- a biped, read from its bones' names -----------------------------------
def read_roles(rig):
    """The bones a biped's poses turn, by name and by which side of the body they are on."""
    return body.read_roles(rig.arm, SIDE, rig.low, rig.high)


def biped_poses(rig, roles):
    """Seven poses that show where a rig of a two-legged body fails. Angles are from the rest pose
    except the arms', which are set to a height so an A-pose and a T-pose end in the same place."""
    sides = (("left", 1), ("right", -1))
    lift = {side: body.elevation(rig.arm, roles, SIDE, side, sign) for side, sign in sides}

    def arms(height):
        return [(f"upperArm.{side}", "front", sign * (height - lift[side])) for side, sign in sides]

    poses = [
        ("arms up", arms(50)),
        ("arms down", arms(-75)),
        ("reach", arms(0) + [(f"upperArm.{side}", "up", -sign * 80) for side, sign in sides] + [(f"foreArm.{side}", "side", -70) for side, _ in sides]),
        ("step", [("thigh.left", "side", -60), ("shin.left", "side", 60), ("thigh.right", "side", 25)]),
        ("wide", [(f"thigh.{side}", "front", sign * 30) for side, sign in sides]),
        ("head turn", [("head", "up", 50)]),
        ("bow", [("spine", "side", 35)]),
    ]
    out = []
    for name, turns in poses:
        kept = [{"bone": roles[role].name, "about": about, "degrees": round(degrees, 1)} for role, about, degrees in turns if role in roles and abs(degrees) > 0.5]
        if kept:
            out.append({"name": name, "turns": kept})
    return out


def limb_poses(rig):
    """For a body whose bones' names say nothing: swing each of its largest limbs, one a pose.
    A limb starts where the skeleton branches, and is as large as the bones below it."""
    def below(bone):
        return sum(1 + below(child) for child in bone.children)

    roots = [b for b in rig.arm.pose.bones if b.parent and len(b.parent.children) > 1 and b.children]
    largest = sorted(roots, key=lambda b: (-below(b), b.name))[:7]
    largest.sort(key=lambda b: [x.name for x in rig.arm.pose.bones].index(b.name))
    return [{"name": f"swing {b.name}", "turns": [{"bone": b.name, "about": "side", "degrees": 40}]} for b in largest]


# -- sheets -----------------------------------------------------------------
def pixels(path):
    image = bpy.data.images.load(str(path))
    data = np.empty(image.size[0] * image.size[1] * 4, dtype=np.float32)
    image.pixels.foreach_get(data)
    shaped = data.reshape(image.size[1], image.size[0], 4)
    bpy.data.images.remove(image)
    return shaped


def sheet(path, rows):
    """Join tiles into one picture: rows top to bottom, each a list of tile files left to right."""
    columns = max(len(row) for row in rows)
    canvas = np.zeros((len(rows) * TILE, columns * TILE, 4), dtype=np.float32)
    canvas[..., :3], canvas[..., 3] = GROUND, 1
    for r, row in enumerate(rows):
        for c, tile in enumerate(row):
            top = (len(rows) - 1 - r) * TILE  # Blender's rows run bottom to top
            canvas[top:top + TILE, c * TILE:(c + 1) * TILE] = pixels(tile)[:TILE, :TILE]
    image = bpy.data.images.new("sheet", columns * TILE, len(rows) * TILE, alpha=False)
    image.pixels.foreach_set(canvas.ravel())
    image.filepath_raw = str(path)
    image.file_format = "PNG"
    image.save()
    bpy.data.images.remove(image)
    return {"columns": columns, "rows": len(rows), "width": columns * TILE, "height": len(rows) * TILE}


def slug(name):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "clip"


def pose_sheet(rig, poses):
    tiles = OUT / "tiles"
    done = []
    rows = [[] for _ in VIEWS]
    for index, pose in enumerate([{"name": "rest", "turns": []}] + poses):
        rig.rest()
        for step in pose["turns"]:
            bone = rig.arm.pose.bones.get(step["bone"])
            if bone is None:
                raise RuntimeError(f"no bone is named {step['bone']}: the skeleton's bones are {', '.join(b.name for b in rig.arm.pose.bones)}")
            rig.turn(bone, AXES[step["about"]], step["degrees"])
        for row, (view, direction) in zip(rows, VIEWS):
            tile = tiles / f"pose-{index:02d}-{view}.png"
            rig.shoot(tile, direction, f"{pose['name']}, {view}")
            row.append(tile)
        done.append({**pose, **(rig.strain() if index else {"strained": 0.0, "torn": 0})})
    rig.rest()
    return done, sheet(OUT / "poses.png", rows)


def clip_sheet(rig, action, name, file_name):
    """Six moments of a clip, from two sides, with the camera following the body."""
    rig.rest()
    rig.arm.animation_data_create()
    rig.arm.animation_data.action = action
    data = rig.arm.animation_data
    if getattr(data, "action_slot", "none") is None and getattr(action, "slots", None):
        data.action_slot = action.slots[0]
    first, last = action.frame_range
    fps = rig.scene.render.fps / rig.scene.render.fps_base
    views = [VIEWS[1], VIEWS[2]]
    rows = [[] for _ in views]
    worst = {"strained": 0.0, "torn": 0}
    start = None
    travel = 0.0
    for index in range(SAMPLES):
        at = first + (last - first) * index / SAMPLES
        rig.scene.frame_set(int(math.floor(at)), subframe=at - math.floor(at))
        low, high = rig.box()
        centre = (low + high) / 2
        flat = mathutils.Vector((centre.x, centre.y, 0))
        start = flat if start is None else start
        travel = max(travel, (flat - start).length)
        strain = rig.strain()
        worst = {"strained": max(worst["strained"], strain["strained"]), "torn": max(worst["torn"], strain["torn"])}
        follow = mathutils.Vector((centre.x, centre.y, rig.centre.z))
        for row, (view, direction) in zip(rows, views):
            tile = OUT / "tiles" / f"clip-{slug(name)}-{index:02d}-{view}.png"
            rig.shoot(tile, direction, f"{name}, {(at - first) / fps:.2f}s, {view}", follow)
            row.append(tile)
    layout = sheet(OUT / file_name, rows)
    rig.rest()
    return {
        "name": name, "action": action.name, "seconds": round((last - first) / fps, 2), "sheet": file_name, **layout, **worst,
        # How far the body's middle moves over the ground, in heights of the body: 0 is a clip played on the spot.
        "travel": round(travel / max(rig.size.z, 1e-9), 2),
    }


def moving(actions):
    """The actions that are motions: one a frame long is a pose a service left in the file."""
    return [a for a in actions if a.frame_range[1] - a.frame_range[0] > 1.5]


def main():
    rig = Rig(cfg["rigPath"])
    roles = read_roles(rig)
    biped = body.is_biped(roles)
    if cfg.get("poses"):
        poses = cfg["poses"]
    elif biped:
        poses = biped_poses(rig, roles)
    else:
        poses = limb_poses(rig)
        notes.append("the bones' names are not a two-legged body's" + (f": each of its {len(poses)} largest limbs is swung instead. " if poses else ": only the rest pose is shown. ") + "Give poses of your own, as turns of named bones, to see more")
    done, layout = pose_sheet(rig, poses)
    report = {
        "rig": {
            "bones": len(rig.arm.pose.bones), "vertices": int(sum(len(o.data.vertices) for o in rig.body)), "edges": int(len(rig.rest_lengths)),
            # In the body's own terms: across its shoulders, its height, front to back.
            "size": [round(abs(rig.size.dot(axis)), 3) for axis in (SIDE, UP, FRONT)],
            "skeleton": "biped" if biped else "unknown",
            "roles": {role: bone.name for role, bone in roles.items()},
        },
        "bones": [{"name": b.name, "parent": b.parent.name if b.parent else None, "at": [round(v, 3) for v in rig.place(b)]} for b in rig.arm.pose.bones],
        "views": [name for name, _ in VIEWS],
        "poses": {"sheet": "poses.png", **layout, "list": done},
        "clips": [],
    }
    inside = {a.name: a for a in rig.actions}
    for name in cfg.get("actions") or []:
        if name not in inside:
            raise RuntimeError(f"the rig holds no clip named {name}: it holds {', '.join(inside) or 'none'}")
        report["clips"].append({"from": "rig", **clip_sheet(rig, inside[name], name, f"clip.{slug(name)}.png")})
    report["actionsInside"] = [a.name for a in moving(rig.actions)]
    for clip in cfg.get("clips") or []:
        other = Rig(clip["path"])
        found = moving(other.actions)
        if not found:
            notes.append(f"{clip['name']}: the file holds no motion")
            continue
        action = max(found, key=lambda a: a.frame_range[1] - a.frame_range[0])
        report["clips"].append({"from": "file", **clip_sheet(other, action, clip["name"], f"clip.{slug(clip['name'])}.png")})
    report["notes"] = notes
    (OUT / "sheet.json").write_text(json.dumps(report, indent=2) + "\n")


main()
