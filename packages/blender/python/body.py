"""What a two-legged body is made of, read from its skeleton and its skin.

Imported by the scripts that run inside Blender (rig-sheet.py, stage-shot.py).
Everything is in the world's axes and the body's own: front (the way it
faces), up, side (towards its left).

- Roles: which bones are a biped's upper arms, forearms, thighs, shins, head
  and spine, read from their names and from the side of the body they are on.
- Turns: a bone turned about an axis of the body, through its head.
- Standing: the arms of an A- or T-pose brought down beside the body, no
  lower than they go without passing into it.
- Parts: the skin cut up by the bone that moves each point most, and how far
  one part passes into another that is not joined to it: a hand into the head.
"""
import math
import re

import bpy
import mathutils
import numpy as np
from mathutils.bvhtree import BVHTree

UP = mathutils.Vector((0, 0, 1))
HELPERS = ("twist", "roll", "helper", "pole", "ctrl", "armature")
# A part that goes into another by more than this share of the body's height has passed into it.
# Less is a sleeve brushing a coat, or a mesh's own unevenness. src/rig-sheet.ts says it as RIG_THROUGH_FROM.
DEEP = 0.02
# How far below the horizontal a standing body's upper arms hang, the first that keeps clear of the body.
HANG = (-75, -70, -65, -60, -55)
# A standing body's forearms, bent forward a little at the elbow.
BEND = -10
# Pairs of parts that are not joined, so that one in the other is never right.
PAIRS = (
    ("left hand", "head"), ("right hand", "head"),
    ("left hand", "body"), ("right hand", "body"),
    ("left hand", "right hand"), ("left leg", "right leg"),
)
SIDES = (("left", 1), ("right", -1))


def plain(name):
    return re.sub(r"[^a-z0-9]", "", name.lower())


def is_role(name, role):
    n = plain(name)
    if any(word in n for word in HELPERS):
        return False
    if role == "upperArm":
        return "arm" in n and not any(word in n for word in ("fore", "lower", "elbow"))
    if role == "foreArm":
        return any(word in n for word in ("forearm", "lowerarm", "elbow"))
    if role == "thigh":
        return any(word in n for word in ("upleg", "thigh", "upperleg"))
    if role == "shin":
        return any(word in n for word in ("shin", "calf", "lowerleg")) or ("leg" in n and not any(word in n for word in ("upleg", "upperleg", "thigh")))
    if role == "head":
        return n.endswith("head")
    if role == "spine":
        return any(word in n for word in ("spine", "chest", "torso"))
    return False


def ancestors(bone):
    count = 0
    while bone.parent:
        bone, count = bone.parent, count + 1
    return count


def place(arm, bone):
    return arm.matrix_world @ bone.head


def read_roles(arm, side, low, high):
    """The bones a biped's poses turn, by name and by which side of the body they are on.
    `low` and `high` are the corners of the body at rest; `side` points to its left."""
    roles = {}
    middle = ((low + high) / 2).dot(side)
    edge = (high - low).length * 0.01
    for role in ("upperArm", "foreArm", "thigh", "shin"):
        found = [b for b in arm.pose.bones if is_role(b.name, role)]
        for name, sign in SIDES:
            mine = [b for b in found if (place(arm, b).dot(side) - middle) * sign > edge]
            if mine:
                roles[f"{role}.{name}"] = min(mine, key=ancestors)
    for role in ("head", "spine"):
        found = [b for b in arm.pose.bones if is_role(b.name, role)]
        if found:
            roles[role] = min(found, key=lambda b: (ancestors(b), place(arm, b).z))
    return roles


def is_biped(roles):
    return all(f"{role}.{side}" in roles for role in ("upperArm", "thigh") for side, _ in SIDES)


def turn(arm, bone, axis, degrees):
    """Turn a bone about an axis of the world through its head; what hangs from it goes with it."""
    world = arm.matrix_world
    head = world @ bone.head
    about = mathutils.Matrix.Translation(head) @ mathutils.Matrix.Rotation(math.radians(degrees), 4, axis) @ mathutils.Matrix.Translation(-head)
    bone.matrix = world.inverted() @ about @ world @ bone.matrix
    bpy.context.view_layer.update()


def elevation(arm, roles, side, name, sign):
    """How far above the horizontal an upper arm points, in degrees: -90 hangs, 0 is out to the side."""
    upper = roles[f"upperArm.{name}"]
    lower = roles.get(f"foreArm.{name}")
    along = (place(arm, lower) - place(arm, upper)) if lower else (arm.matrix_world @ upper.tail - place(arm, upper))
    return math.degrees(math.atan2(along.dot(UP), along.dot(side) * sign))


def fcurves(action):
    """An action's curves, in Blender 4 (on the action) and 5 (in its layers' channel bags)."""
    if hasattr(action, "layers"):
        found = [curve for layer in action.layers for strip in layer.strips for bag in strip.channelbags for curve in bag.fcurves]
        if found or not hasattr(action, "fcurves"):
            return found
    return list(action.fcurves)


def shortest(action):
    """Write each bone's turns with w at or above 0: the same turns, now all on one side.

    q and -q are one turn, and a file may hold either. Blender blends two clips, or a clip and a
    pose, by mixing the four numbers of each: from q to a -q the mix passes near nothing, and the
    limb spins round on the way. A joint turns less than half a turn from rest, where w stays above
    0, so a bone whose turns sit mostly below 0 has all of them turned over, keys and handles:
    nothing it does changes, and every blend between two such takes the short way."""
    turned = 0
    by_bone = {}
    for curve in fcurves(action):
        if curve.data_path.endswith(".rotation_quaternion"):
            by_bone.setdefault(curve.data_path, {})[curve.array_index] = curve
    for curves in by_bone.values():
        w = curves.get(0)
        if w is None or len(curves) != 4 or not len(w.keyframe_points):
            continue
        if sum(key.co[1] for key in w.keyframe_points) >= 0:
            continue
        for curve in curves.values():
            for key in curve.keyframe_points:
                key.co[1], key.handle_left[1], key.handle_right[1] = -key.co[1], -key.handle_left[1], -key.handle_right[1]
            curve.update()
        turned += 1
    return turned


def rest(arm):
    for bone in arm.pose.bones:
        bone.matrix_basis = mathutils.Matrix.Identity(4)
    bpy.context.view_layer.update()


def stand(arm, roles, front, side, parts, tall):
    """Bring the arms down beside the body, each as low as it goes without its hand passing into
    the body or a leg. Starts from the rest pose and leaves the body standing. Returns, for each
    side, how far below the horizontal its upper arm hangs, and the bones it turned."""
    rest(arm)
    deep = tall * DEEP
    before = parts.through() if parts else {}
    hangs, turned = {}, []
    for name, sign in SIDES:
        upper, lower = roles.get(f"upperArm.{name}"), roles.get(f"foreArm.{name}")
        if upper is None:
            continue
        lift = elevation(arm, roles, side, name, sign)
        touches = [(f"{name} hand", "body"), (f"{name} hand", f"{name} leg")]
        for height in HANG:
            for bone in (upper, lower):
                if bone is not None:
                    bone.matrix_basis = mathutils.Matrix.Identity(4)
            bpy.context.view_layer.update()
            turn(arm, upper, front, sign * (height - lift))
            if lower is not None:
                turn(arm, lower, side, BEND)
            now = parts.through(touches) if parts else {}
            if all(now.get(pair, 0.0) <= before.get(pair, 0.0) + deep for pair in touches):
                break
        hangs[name] = height
        turned += [bone for bone in (upper, lower) if bone is not None]
    return hangs, turned


def subtree(bone):
    return [bone] + list(bone.children_recursive)


# Three ways out of a point, none along an axis: a ray along one would run down the edges of a box.
RAYS = tuple(mathutils.Vector(way).normalized() for way in ((0.31, 0.52, 0.80), (-0.72, 0.13, -0.68), (0.27, -0.91, 0.31)))
# A part is looked at in no more than this many of its points: enough to find a hand in a head.
LOOKED_AT = 400


def crossings(tree, at, way, step):
    count, origin = 0, at
    for _ in range(64):
        found, _normal, _face, _distance = tree.ray_cast(origin, way)
        if found is None:
            break
        count += 1
        origin = found + way * step
    return count


def inside(tree, at, step):
    """A point is inside a surface when a ray out of it crosses the surface an odd number of times.
    A closed surface within (an eye, a body under a coat) is crossed twice and changes nothing. A part
    is open where it joins the next, and a ray can leave through there: two rays of three decide."""
    first = crossings(tree, at, RAYS[0], step) % 2
    second = crossings(tree, at, RAYS[1], step) % 2
    if first == second:
        return bool(first)
    return bool(crossings(tree, at, RAYS[2], step) % 2)


def skin(meshes):
    """Where every point of these meshes is now, in the world: a body that was not cut into parts."""
    graph = bpy.context.evaluated_depsgraph_get()
    out = []
    for o in meshes:
        evaluated = o.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        co = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
        mesh.vertices.foreach_get("co", co)
        world = np.array(evaluated.matrix_world, dtype=np.float64)
        out.append(co.reshape(-1, 3) @ world[:3, :3].T + world[:3, 3])
        evaluated.to_mesh_clear()
    return np.concatenate(out) if out else np.zeros((0, 3))


class Parts:
    """The skin, cut up by the bone that moves each point most: head, body, each hand (the forearm
    and all that hangs from it), each upper arm, each leg."""

    def __init__(self, arm, meshes, roles):
        self.arm = arm
        own = {bone.name: "body" for bone in arm.pose.bones}
        for name, _sign in SIDES:
            for role, part in (("thigh", f"{name} leg"), ("upperArm", f"{name} upper arm"), ("foreArm", f"{name} hand")):
                if f"{role}.{name}" in roles:
                    own.update({b.name: part for b in subtree(roles[f"{role}.{name}"])})
        if "head" in roles:
            own.update({b.name: "head" for b in subtree(roles["head"])})
        self.names = sorted(set(own.values()))
        self.index = {part: number for number, part in enumerate(self.names)}
        self.meshes, labels, faces, offset = [], [], {part: [] for part in self.names}, 0
        for o in meshes:
            count = len(o.data.vertices)
            mine = np.full(count, -1, dtype=np.int32)
            if o.parent_type == "BONE" and o.parent is arm and o.parent_bone in own:
                mine[:] = self.index[own[o.parent_bone]]
            else:
                groups = {g.index: g.name for g in o.vertex_groups}
                for vertex in o.data.vertices:
                    best = max(vertex.groups, key=lambda g: g.weight, default=None)
                    if best is not None and best.weight > 0 and groups.get(best.group) in own:
                        mine[vertex.index] = self.index[own[groups[best.group]]]
            # A part's surface is every face with a corner in it, so that it is closed up to where it joins the next.
            for polygon in o.data.polygons:
                corners = tuple(v + offset for v in polygon.vertices)
                for number in {int(mine[v]) for v in polygon.vertices if mine[v] >= 0}:
                    faces[self.names[number]].append(corners)
            self.meshes.append({"object": o, "count": count})
            labels.append(mine)
            offset += count
        self.labels = np.concatenate(labels) if labels else np.zeros(0, dtype=np.int32)
        self.faces = faces
        self.corners = {part: np.array(sorted({v for face in found for v in face}), dtype=np.int64) for part, found in faces.items()}

    def posed(self):
        """Where every point of the skin is now, in the world; None when a mesh no longer has the points it had."""
        graph = bpy.context.evaluated_depsgraph_get()
        out = []
        for entry in self.meshes:
            evaluated = entry["object"].evaluated_get(graph)
            mesh = evaluated.to_mesh()
            count = len(mesh.vertices)
            if count == entry["count"]:
                co = np.empty(count * 3, dtype=np.float64)
                mesh.vertices.foreach_get("co", co)
                world = np.array(evaluated.matrix_world, dtype=np.float64)
                out.append(co.reshape(-1, 3) @ world[:3, :3].T + world[:3, 3])
            evaluated.to_mesh_clear()
            if count != entry["count"]:
                return None
        return np.concatenate(out) if out else np.zeros((0, 3))

    def of(self, part, posed):
        """The points of a part, as they are in `posed`."""
        return posed[self.labels == self.index[part]] if part in self.index else posed[:0]

    def _into(self, points, surface):
        """How far the deepest of these points is inside a surface: how far it is from the nearest
        of it, which may be a surface inside (an eye in a head), so it is at least that deep."""
        if surface is None or not len(points):
            return 0.0
        tree, low, high = surface
        within = points[np.all((points >= low) & (points <= high), axis=1)]
        if len(within) > LOOKED_AT:
            within = within[np.linspace(0, len(within) - 1, LOOKED_AT).astype(np.int64)]
        step = float(np.max(high - low)) * 1e-5
        deepest = 0.0
        for point in within:
            at = mathutils.Vector(point.tolist())
            if inside(tree, at, step):
                found, _normal, _face, distance = tree.find_nearest(at)
                if found is not None:
                    deepest = max(deepest, distance)
        return deepest

    def through(self, pairs=PAIRS, posed=None):
        """How far each pair of parts is in each other as the body stands now, in the world's units.
        `posed` is the skin as posed() gave it, when the caller has read it already."""
        pairs = [pair for pair in pairs if pair[0] in self.index and pair[1] in self.index]
        if not pairs:
            return {}
        posed = self.posed() if posed is None else posed
        if posed is None:
            return {}
        listed, points, surfaces = None, {}, {}

        def points_of(part):
            if part not in points:
                points[part] = posed[self.labels == self.index[part]]
            return points[part]

        def surface_of(part):
            nonlocal listed
            if part not in surfaces:
                if not self.faces[part]:
                    surfaces[part] = None
                else:
                    listed = posed.tolist() if listed is None else listed
                    corners = posed[self.corners[part]]
                    surfaces[part] = (BVHTree.FromPolygons(listed, self.faces[part], all_triangles=False), corners.min(axis=0), corners.max(axis=0))
            return surfaces[part]

        return {(a, b): max(self._into(points_of(a), surface_of(b)), self._into(points_of(b), surface_of(a))) for a, b in pairs}


class Through:
    """What passes through what over a run of moments, against how the body stood before them."""

    def __init__(self, parts, tall, before):
        self.parts, self.deep, self.before, self.seen = parts, tall * DEEP, before, {}

    def look(self, moment, posed=None):
        for pair, depth in self.parts.through(posed=posed).items():
            beyond = depth - self.before.get(pair, 0.0)
            if beyond <= self.deep:
                continue
            seen = self.seen.setdefault(pair, {"from": moment, "count": 0, "depth": 0.0, "at": moment})
            seen["count"] += 1
            if beyond > seen["depth"]:
                seen["depth"], seen["at"] = beyond, moment

    def told(self, scale, step):
        """Each pair seen, deepest first: how deep (in `scale`s), from when, for how long, deepest when."""
        out = [{
            "parts": list(pair), "depth": round(seen["depth"] / scale, 3),
            "from": round(seen["from"], 3), "seconds": round(seen["count"] * step, 3), "at": round(seen["at"], 3),
        } for pair, seen in self.seen.items()]
        return sorted(out, key=lambda item: -item["depth"])
