"""Film characters on a set. Runs inside Blender.

Where rig-shot.py films one character on an empty stage, this puts several
in one picture and, when a set is given, in a place. Each player stands on
a mark, turned the way it is told, and does one thing after another: plays
a clip, walks to another mark while a clip plays, waits, turns to someone.
The camera is the set's own, or one asked for in a shot's words about the
players it is on.

A stage is laid out as it is seen from the front: x to the right, y away
from the audience, in metres on the floor. A player turned 0 faces the
audience, 90 the right of the picture, -90 the left, 180 away.

A walk takes as long as its clip says: the pace is measured from the foot
that is on the ground, so that the body is moved as far as its feet step.
It goes round what stands in its way — a thing of the set, a player who
stays where it is — and steps up onto what is low enough; with no way
round, the shot is refused and what stands in the way is named.

A two-legged body stands with its arms beside it when it plays no clip:
before its first, between two, after its last. It is watched in every frame
for a part passing into another it is not joined to: a hand into the head;
and for its skin passing through a thing of the set.

No script comes with the request. The set is a .blend whose own Python is
not run (--disable-autoexec).
"""
import json
import math
import sys
from pathlib import Path

import bpy
import mathutils
import numpy as np
from bpy_extras.object_utils import world_to_camera_view

sys.path.insert(0, str(Path(__file__).resolve().parent))
import body as anatomy  # noqa: E402
import way as ways  # noqa: E402

cfg = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text())
OUT = Path(cfg["outputDir"])
UP = mathutils.Vector((0, 0, 1))
# The audience is at -y: a front camera stands there and looks along +y.
FRONT = mathutils.Vector((0, -1, 0))
SIDE = UP.cross(FRONT)
VIEWS = {"front": FRONT, "three-quarter": FRONT + SIDE * 0.75, "side": SIDE, "back": -FRONT}
# As rig-shot.py: the share of the tallest player's height a frame holds, the height it is aimed at,
# and the share of the players' width it must hold whatever its shape. wide leaves air around them.
FRAMINGS = {"wide": (1.9, 0.5, 1.6), "full": (1.3, 0.5, 1.25), "medium": (0.62, 0.72, 1.1), "close": (0.36, 0.86, 1.0)}
# Degrees about the vertical that bring a body facing that way in its file to face the audience.
FACES = {"+z": 0, "-z": 180, "+x": -90, "-x": 90}
MARK = "mark."
# How long a body takes to turn, and one clip to give way to the next.
TURN_SECONDS = 0.4
BLEND_SECONDS = 0.25
# The share of its height a body steps up or down as it walks: a kerb, a stair. More is in its way.
STEP = 0.18
# A body walks by a thing of the set no nearer than this much of its own half-width, and a little more.
BY = (1.15, 0.03)
# Two bodies are in the same place nearer than this share of their two half-widths, and one
# walks by another that stands no nearer than this.
SAME, PAST = 0.6, 1.3
# A way round is looked for no further than this from where it starts and ends (metres), or
# this share of how far apart they are.
ROUND = (4.0, 0.75)
# A way along the edge of a step — one foot on the pavement, one in the street — counts this many
# times its length: a body crosses a kerb, it does not walk along it when there is room beside.
KERB = 3.0
# A floor that is this share of a body's height higher or lower beside it than under it is a step's edge.
UNEVEN = 0.03
# No more points of a body's skin than this are looked at for being in the set.
LOOKED_AT = 240


def colour(text):
    value = text.lstrip("#")
    return tuple(int(value[i:i + 2], 16) / 255 for i in (0, 2, 4))


def linear(c):
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def fail(message):
    raise RuntimeError(message)


def heading(way):
    """The turn that faces along a direction over the floor."""
    return math.degrees(math.atan2(way.x, -way.y))


def nearer(angle, to):
    """The same turn as `angle`, written within half a turn of `to`: a body turns the short way."""
    return to + (angle - to + 180) % 360 - 180


def spin(degrees):
    return mathutils.Matrix.Rotation(math.radians(degrees), 4, "Z")


def flat(vector):
    return mathutils.Vector((vector.x, vector.y, 0))


def shortest_of(quaternion):
    """A turn written with w at or above 0, as anatomy.shortest writes a clip's."""
    return quaternion.copy() if quaternion.w >= 0 else -quaternion


def said(place):
    """A place as it was asked for: a mark's name, or its metres."""
    return place if isinstance(place, str) else f"{place[0]:g}, {place[1]:g}"


def main():
    notes = []
    if cfg.get("set"):
        bpy.ops.wm.open_mainfile(filepath=cfg["set"], load_ui=False, use_scripts=False)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    set_fps = scene.render.fps / scene.render.fps_base
    fps = cfg.get("fps") or (round(set_fps) if cfg.get("set") else 24)
    if cfg.get("set") and abs(set_fps - fps) > 0.01:
        notes.append(f"the set was made at {set_fps:g} frames a second and is filmed at {fps}: what moves in it moves at another speed")
    # Before anything is brought in: a clip's seconds become frames at the scene's rate.
    scene.render.fps, scene.render.fps_base = fps, 1.0
    set_objects = set(scene.objects)
    set_meshes = {o for o in set_objects if o.type == "MESH"}
    first_frame = scene.frame_start if cfg.get("set") else 1
    marks = {o.name[len(MARK):]: o for o in scene.objects if o.name.startswith(MARK)}
    # What is seen of the scene now. Read again whenever something in it has been moved.
    now = {"graph": bpy.context.evaluated_depsgraph_get()}

    solid = set_meshes

    def cast(origin, way, distance):
        """The first solid thing of the set a ray meets: (where, the thing, how far), or None.
        A player is passed through."""
        gone = 0.0
        for _ in range(24):
            hit, location, _normal, _face, obj, _matrix = scene.ray_cast(now["graph"], origin + way * gone, way, distance=distance - gone)
            if not hit:
                return None
            gone = (location - origin).length
            if obj is not None and obj.original in solid:
                return location, obj.original, gone
            gone += 1e-4
            if gone >= distance:
                return None
        return None

    # ── The floor ───────────────────────────────────────────────────────────
    DOWN = mathutils.Vector((0, 0, -1))

    def surfaces(x, y):
        """Every surface of the set over a place on the stage, from the top down."""
        found, top = [], 10000.0
        for _ in range(16):
            met = cast(mathutils.Vector((x, y, top)), DOWN, 20000.0) if solid else None
            if met is None:
                break
            found.append(met[0].z)
            top = met[0].z - 0.02
        return found

    def floor_at(x, y, near=None):
        """Where a body stands there: the surface nearest a height it is known to be at, or the lowest it has room to stand on."""
        found = surfaces(x, y)
        if not found:
            return 0.0 if near is None else near
        if near is not None:
            best = min(found, key=lambda z: abs(z - near))
            return best if abs(best - near) <= 0.6 else near
        for index in range(len(found) - 1, -1, -1):
            if index == 0 or found[index - 1] - found[index] >= 1.5:
                return found[index]
        return found[0]

    def place_of(where, player, what):
        """A place on the stage and the turn a mark gives it: (location, degrees or None)."""
        if isinstance(where, str):
            mark = marks.get(where)
            if mark is None:
                names = ", ".join(sorted(marks)) or "none"
                fail(f"the set has no mark named {where} for {player} ({what}): its marks are {names}. A mark is an object named {MARK}<name>")
            ahead = mark.matrix_world.to_3x3() @ mathutils.Vector((0, -1, 0))
            return mark.matrix_world.translation.copy(), heading(ahead)
        x, y = where
        return mathutils.Vector((x, y, floor_at(x, y))), None

    # Where everyone stands and goes is found before anyone is brought in, so that a player is not another's floor.
    plans = []
    for player in cfg["players"]:
        start, mark_turn = place_of(player.get("at", [0, 0]), player["name"], "at")
        acts, at = [], start
        for number, act in enumerate(player.get("does") or [], 1):
            entry = {"act": act, "number": number, "from": at, "to": None, "way": None, "round": []}
            if act.get("to") is not None:
                entry["to"] = place_of(act["to"], player["name"], f"act {number}, to")[0]
                at = entry["to"]
            acts.append(entry)
        plans.append({"player": player, "start": start, "markTurn": mark_turn, "acts": acts})
    by_name = {plan["player"]["name"]: plan for plan in plans}

    # ── Bring each player in, under a handle that stands on its mark ────────
    def moving(actions):
        found = [a for a in actions if a.frame_range[1] - a.frame_range[0] > 1.5]
        return max(found, key=lambda a: a.frame_range[1] - a.frame_range[0]) if found else None

    # What a motion is called in its file. Blender renames the second "walk" it is given to "walk.001".
    called = {}

    def bring(filepath):
        objects_before, actions_before = set(bpy.data.objects), set(bpy.data.actions)
        names_before = {a.name for a in actions_before}
        bpy.ops.import_scene.gltf(filepath=filepath)
        brought = [o for o in bpy.data.objects if o not in objects_before]
        actions = [a for a in bpy.data.actions if a not in actions_before]
        for action in actions:
            stem, dot, number = action.name.rpartition(".")
            called[action] = stem if (dot and len(number) == 3 and number.isdigit() and stem in names_before) else action.name
        return brought, actions

    def skeleton_of(brought):
        armatures = [o for o in brought if o.type == "ARMATURE"]
        return max(armatures, key=lambda o: len(o.data.bones)) if armatures else None

    for plan in plans:
        player = plan["player"]
        brought, actions = bring(player["path"])
        handle = bpy.data.objects.new("player." + player["name"], None)
        scene.collection.objects.link(handle)
        for o in brought:
            if o.parent is None:
                o.parent = handle
        arm = skeleton_of(brought)
        if arm:
            body = [o for o in brought if o.type == "MESH" and (any(m.type == "ARMATURE" and m.object for m in o.modifiers) or o.parent_type == "BONE")]
            if not body:
                fail(f"no part of {player['name']}'s body follows its skeleton: there is no character to film")
            for o in brought:
                if o.type == "MESH" and o not in body:
                    o.hide_render = True  # the importer's bone shapes
            arm.animation_data_clear()
            for bone in arm.pose.bones:
                bone.matrix_basis = mathutils.Matrix.Identity(4)
        else:
            body = [o for o in brought if o.type == "MESH"]
            if not body:
                fail(f"{player['name']}'s file holds no body: there is nothing to film")
            if any(entry["act"].get("clip") for entry in plan["acts"]):
                fail(f"{player['name']} has no skeleton: it can stand, wait and be moved, and plays no clip")
        faces = FACES[player.get("faces", "+z")]
        handle.rotation_euler = (0, 0, math.radians(faces))
        bpy.context.view_layer.update()

        # The body at rest, turned to the audience and not yet moved: how tall it is, how wide.
        corners = [o.matrix_world @ mathutils.Vector(c) for o in body for c in o.bound_box]
        low = mathutils.Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
        high = mathutils.Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
        roots = [b for b in arm.pose.bones if b.parent is None] if arm else []
        lead = max(roots, key=lambda b: len(b.children_recursive)) if roots else None
        plan.update({
            "handle": handle, "arm": arm, "body": body, "faces": faces, "lead": lead,
            # Half its width as it stands, for walking by things; a body read as two-legged is measured below, without its arms.
            "girth": min(max(high.x - low.x, high.y - low.y), high.z - low.z) / 2,
            "own": moving(actions) if arm else None,
            "tall": high.z - low.z, "wide": max(high.x - low.x, high.y - low.y), "feet": low.z,
            "middle": mathutils.Vector(((low.x + high.x) / 2, (low.y + high.y) / 2, 0)),
        })
        if abs(low.z) > max(plan["tall"], 1e-6) * 0.05:
            notes.append(f"{player['name']} does not stand on the ground in its own file (its lowest point is at {low.z:.2f}): it was put on its mark by its lowest point")

        # How it stands when it plays nothing, and what of it is in what already then.
        plan.update({"standing": None, "stance": [], "parts": None, "before": {}})
        if arm:
            roles = anatomy.read_roles(arm, SIDE, low, high)
            if anatomy.is_biped(roles):
                parts = anatomy.Parts(arm, body, roles)
                hangs, turned = anatomy.stand(arm, roles, FRONT, SIDE, parts, plan["tall"])
                stood = parts.posed()
                trunk = [parts.of(part, stood) for part in parts.names if "hand" not in part and "upper arm" not in part] if stood is not None else []
                trunk = np.concatenate(trunk) if trunk else np.zeros((0, 3))
                if len(trunk):
                    plan["girth"] = float(max(np.ptp(trunk[:, 0]), np.ptp(trunk[:, 1]))) / 2
                plan.update({
                    "standing": hangs, "parts": parts, "before": parts.through(),
                    # By name: a bone's handle is not kept across the imports that follow.
                    "stance": [(bone.name, bone.rotation_mode, shortest_of(bone.rotation_quaternion) if bone.rotation_mode == "QUATERNION" else bone.rotation_euler.copy()) for bone in turned],
                })
                anatomy.rest(arm)
            else:
                notes.append(f"{player['name']}'s bones were not read as a two-legged body's: when it plays no clip it stands in its rest pose, and no part of it is watched for passing into another")

    # ── The ways: round what stands, onto what is low enough to step on ─────
    now["graph"] = bpy.context.evaluated_depsgraph_get()
    for plan in plans:
        # One that goes nowhere is stood where it is for the whole shot: another walks round it.
        plan["still"] = not any(entry["to"] is not None for entry in plan["acts"])
    RING = [mathutils.Vector((math.cos(turn), math.sin(turn), 0)) for turn in (index * math.pi / 4 for index in range(8))]

    def looker(plan, start, end):
        """What a walking body finds at a place: (the floor's height there, what is in its way or None)."""
        tall, girth = plan["tall"], plan["girth"]
        step = tall * STEP
        by = girth * BY[0] + BY[1]
        levels = [step + (tall - step) * share for share in (0.05, 0.35, 0.65, 0.95)]
        others = [(other["player"]["name"], other["start"], other["girth"]) for other in plans if other is not plan and other["still"]]

        def look(place, height):
            x, y = place
            # Where it leaves from and where it arrives it may be nearer to things than it walks by them.
            ends = min(math.dist(place, start), math.dist(place, end))
            for name, spot, wide in others:
                if math.dist(place, (spot.x, spot.y)) < min((girth + wide) * PAST, (girth + wide) * SAME + ends):
                    return height, name, 1.0
            if not solid:
                return height, None, 1.0
            # The floor: the highest surface it can step up to from where it comes; none, and it goes on level.
            under = [z for z in surfaces(x, y) if z <= height + step]
            floor = max(under) if under else height
            if height - floor > step:
                return floor, f"a drop of {height - floor:.2f} m", 1.0
            clear = min(by, girth * 0.3 + ends)
            middle = mathutils.Vector((x, y, floor))
            # Nothing over the floor it stands on up to its head, at its middle and about it; and the
            # floor about it as high as under it, or it stands on the edge of a step.
            toll = 1.0
            for off in [None] + [way * by for way in RING[::2]]:
                over = middle + UP * tall if off is None else middle + off * (clear / by) + UP * tall
                met = cast(over, DOWN, tall - step)
                if met is not None:
                    return floor, met[1].name, 1.0
                if off is not None and under:
                    beside = cast(middle + off + UP * step, DOWN, 2 * step)
                    if beside is None or abs(beside[0].z - floor) > tall * UNEVEN:
                        toll = KERB
            # and nothing beside it, from above a step to its head.
            for level in levels:
                for way in RING:
                    met = cast(middle + UP * level, way, clear)
                    if met is not None:
                        return floor, met[1].name, 1.0
            return floor, None, toll

        return look

    for plan in plans:
        name = plan["player"]["name"]
        for entry in plan["acts"]:
            if entry["to"] is None:
                continue
            start, end = entry["from"], entry["to"]
            a, b = (start.x, start.y), (end.x, end.y)
            apart = math.dist(a, b)
            if apart <= 1e-6:
                entry["way"], entry["lengths"] = [start.copy(), end.copy()], [0.0, 0.0]
                continue
            look = looker(plan, a, b)
            going = said(entry["act"]["to"])
            there = look(b, end.z)[1]
            if there is not None:
                fail(f"{name}, act {entry['number']}: it cannot go to {going}: {there} is there. Give it a place beside, or move what is there")
            margin = max(ROUND[0], apart * ROUND[1])
            try:
                walked, turns, met = ways.find(a, b, start.z, look, min(max(plan["girth"] * 0.5, 0.06), 0.2), margin)
            except ways.NoWay as none:
                fail(f"{name}, act {entry['number']}: there is no way to {going} round {' and '.join(none.met) or 'what stands there'} (looked for within {margin:.0f} m). Give it a place to go by first, one act for each, or move what is in the way")
            points = [mathutils.Vector(point) for point in walked]
            points[0].z, points[-1].z = start.z, end.z
            lengths = [0.0]
            for one, other in zip(points, points[1:]):
                lengths.append(lengths[-1] + flat(other - one).length)
            entry.update({"way": points, "lengths": lengths, "round": met, "turns": [mathutils.Vector((x, y, 0)) for x, y in turns[1:-1]]})

    def on_way(entry, share):
        """Where a body is on its way, a share of it gone: its place, and the turn that faces along the way there."""
        lengths, points = entry["lengths"], entry["way"]

        def at(gone):
            gone = min(max(gone, 0.0), lengths[-1])
            low, high = 0, len(lengths) - 1
            while high - low > 1:
                half = (low + high) // 2
                low, high = (half, high) if lengths[half] <= gone else (low, half)
            span = lengths[high] - lengths[low]
            return points[low].lerp(points[high], (gone - lengths[low]) / span if span > 1e-9 else 0.0)

        gone = share * lengths[-1]
        # It turns through a corner over as much of the way as it is wide, not on the spot.
        ahead = max(entry["look"], 1e-3)
        facing = flat(at(gone + ahead) - at(gone - ahead))
        return at(gone), (heading(facing) if facing.length > 1e-6 else None)

    # ── The clips: each read from its file, measured once ───────────────────
    def measure(plan, action):
        """How long a clip is, how far it carries the body in one playing, and the pace it walks at."""
        arm, lead = plan["arm"], plan["lead"]
        first, last = action.frame_range
        data = arm.animation_data_create()
        data.action = action
        if getattr(data, "action_slot", "none") is None and getattr(action, "slots", None):
            data.action_slot = action.slots[0]
        samples = 48
        rows = []
        for index in range(samples + 1):
            at = first + (last - first) * index / samples
            scene.frame_set(int(math.floor(at)), subframe=at - math.floor(at))
            root = arm.matrix_world @ lead.head if lead else mathutils.Vector()
            # Joints, not the ends of bones: a file's bones may be drawn any length.
            rows.append((root, {bone.name: arm.matrix_world @ bone.head for bone in arm.pose.bones}))
        arm.animation_data_clear()
        for bone in arm.pose.bones:
            bone.matrix_basis = mathutils.Matrix.Identity(4)
        scene.frame_set(first_frame)
        seconds = (last - first) / fps
        carried = flat(rows[-1][0] - rows[0][0])
        # A foot on the ground is among the lowest joints of the skeleton. Seen from the body, the one
        # that carries it goes backwards at the pace the body walks; one that swings forward is not it.
        ahead = spin(plan["faces"]) @ FRONT
        ground = min(point.z for _root, points in rows for point in points.values())
        down = plan["tall"] * 0.04
        paces = []
        for index in range(samples):
            (root_a, points_a), (root_b, points_b) = rows[index], rows[index + 1]
            backwards = [
                -flat((points_b[name] - root_b) - (points_a[name] - root_a)).dot(ahead) / (seconds / samples)
                for name in points_a if points_a[name].z - ground <= down and points_b[name].z - ground <= down
            ]
            if backwards and max(backwards) > 0:
                paces.append(max(backwards))
        paces.sort()
        pace = paces[len(paces) // 2] if paces else 0.0
        return {"action": action, "first": first, "last": last, "seconds": seconds, "carried": carried, "pace": max(pace, 0.0)}

    for plan in plans:
        player, arm = plan["player"], plan["arm"]
        clips = {}
        if plan["own"]:
            clips[player["path"]] = plan["own"]
        for entry in plan["acts"]:
            clip = entry["act"].get("clip")
            if not clip or clip in clips:
                continue
            brought, actions = bring(clip)
            other = skeleton_of(brought)
            action = moving(actions)
            if other is None or action is None:
                fail(f"{clip} holds no motion for {player['name']}: a clip is the body with one motion in it")
            missing = [bone.name for bone in other.data.bones if bone.name not in arm.data.bones]
            if missing:
                fail(f"the clip {Path(clip).name} is not of {player['name']}'s body: it moves bones the body does not have ({', '.join(missing[:4])})")
            action.use_fake_user = True
            for o in brought:
                bpy.data.objects.remove(o, do_unlink=True)
            clips[clip] = action
        # Every turn on the side where a blend between two of them takes the short way.
        for action in clips.values():
            anatomy.shortest(action)
        plan["measured"] = {path: measure(plan, action) for path, action in clips.items()} if arm else {}

    # ── What each player does, and when ─────────────────────────────────────
    for plan in plans:
        player = plan["player"]
        moment = 0.0
        for number, entry in enumerate(plan["acts"], 1):
            act = entry["act"]
            clip = plan["measured"].get(act["clip"]) if act.get("clip") else None
            distance = entry["lengths"][-1] if entry["to"] is not None else 0.0
            entry["look"] = max(plan["girth"], 0.15)
            if act.get("seconds") is not None:
                seconds = float(act["seconds"])
            elif entry["to"] is not None and distance > 1e-6:
                if not clip or clip["pace"] <= plan["tall"] * 0.05:
                    fail(f"{player['name']}, act {number}: say how many `seconds` the way takes. " + ("Its clip does not walk: no pace could be read from its feet" if clip else "It plays no clip on the way, so nothing says how fast it goes"))
                seconds = distance / clip["pace"]
            elif clip:
                seconds = clip["seconds"] * (act.get("loops") or 1)
            else:
                seconds = TURN_SECONDS if (act.get("turn") is not None or act.get("towards") is not None) else 0.0
            if not clip and entry["to"] is None and act.get("seconds") is None and act.get("turn") is None and act.get("towards") is None:
                fail(f"{player['name']}, act {number} does nothing: give it a clip, a place to go `to`, a turn, or `seconds` to wait")
            entry.update({"clip": clip, "start": moment, "seconds": seconds, "distance": distance})
            moment += seconds
        plan["ends"] = moment

    seconds = cfg.get("seconds") or max((plan["ends"] for plan in plans), default=0.0) or 2.0
    frames = max(1, round(seconds * fps))
    if frames > cfg["maxFrames"]:
        fail(f"the shot would be {frames} frames ({seconds:.1f}s at {fps} a second): at most {cfg['maxFrames']}. Ask for fewer seconds or loops")

    # Under everything, the body standing. Each clip on a track of its own, above the one before.
    # A clip comes in over the pose the last one left, or out of standing; when nothing follows
    # it, it gives way to standing again.
    for plan in plans:
        arm = plan["arm"]
        if not arm:
            continue
        playing = [entry for entry in plan["acts"] if entry["clip"]]
        if not playing and not plan["stance"]:
            continue
        data = arm.animation_data_create()
        if plan["stance"]:
            standing = bpy.data.actions.new(f"standing.{plan['player']['name']}")
            data.action = standing
            for name, mode, value in plan["stance"]:
                bone = arm.pose.bones[name]
                path = "rotation_quaternion" if mode == "QUATERNION" else "rotation_euler"
                setattr(bone, path, value)
                for frame in (first_frame, first_frame + frames):
                    bone.keyframe_insert(path, frame=frame)
            data.action = None
            anatomy.rest(arm)
            track = data.nla_tracks.new()
            track.name = "standing"
            strip = track.strips.new("standing", first_frame, standing)
            if getattr(strip, "action_slot", "none") is None and getattr(standing, "slots", None):
                strip.action_slot = standing.slots[0]
            strip.blend_type = "REPLACE"
            strip.extrapolation = "HOLD"
        for index, entry in enumerate(playing):
            clip = entry["clip"]
            # The last thing a player does goes on for as long as the shot, when it is told to (loops: 0).
            goes_on = entry is plan["acts"][-1] and entry["act"].get("loops") == 0
            lasts = max(seconds - entry["start"], clip["seconds"]) if goes_on else entry["seconds"]
            if lasts <= 0:
                continue
            ends = entry["start"] + lasts
            follows = index > 0 and abs(playing[index - 1]["start"] + playing[index - 1]["seconds"] - entry["start"]) < 0.5 / fps
            followed = index + 1 < len(playing) and abs(playing[index + 1]["start"] - ends) < 0.5 / fps
            to_the_end = ends >= seconds - 1.0 / fps
            blend = min(BLEND_SECONDS, lasts / 3) * fps
            track = data.nla_tracks.new()
            track.name = f"act {index + 1}"
            strip = track.strips.new(f"act {index + 1}", int(round(first_frame + entry["start"] * fps)), clip["action"])
            if getattr(strip, "action_slot", "none") is None and getattr(clip["action"], "slots", None):
                strip.action_slot = clip["action"].slots[0]
            strip.action_frame_start, strip.action_frame_end = clip["first"], clip["last"]
            strip.repeat = max(lasts / max(clip["seconds"], 1e-6), 0.01)
            strip.blend_type = "REPLACE"
            strip.use_auto_blend = False
            # Held while the next clip comes in over it; otherwise let go to standing, so the body is not left frozen in a stride.
            strip.extrapolation = "HOLD_FORWARD" if (followed or to_the_end) else "NOTHING"
            strip.blend_in = blend if (follows or entry["start"] > 0.5 / fps) else 0
            strip.blend_out = 0 if (followed or to_the_end) else blend

    # ── Where a player is and which way it faces, at a moment of the shot ───
    def spot_of(plan, moment):
        """Where a player stands at a moment: (place, the act it is in or None)."""
        at = plan["start"]
        for entry in plan["acts"]:
            if moment < entry["start"]:
                return at, None
            if entry["to"] is not None:
                share = min(max((moment - entry["start"]) / max(entry["seconds"], 1e-6), 0.0), 1.0)
                way, _facing = on_way(entry, share)
                if moment < entry["start"] + entry["seconds"]:
                    return way, entry
                at = entry["to"]
            elif moment < entry["start"] + entry["seconds"]:
                return at, entry
        return at, None

    def first_turn(plan):
        player = plan["player"]
        if player.get("turn") is not None:
            return float(player["turn"])
        if player.get("towards") is not None:
            way = flat(by_name[player["towards"]]["start"] - plan["start"])
            return heading(way) if way.length > 1e-6 else 0.0
        return plan["markTurn"] if plan["markTurn"] is not None else 0.0

    def asked_turn(plan, entry, moment):
        """The way an act faces a player, or None when it leaves it as it was."""
        act = entry["act"]
        if entry["to"] is not None and entry["distance"] > 1e-6:
            return on_way(entry, min(max((moment - entry["start"]) / max(entry["seconds"], 1e-6), 0.0), 1.0))[1]
        if act.get("towards") is not None:
            here, _ = spot_of(plan, moment)
            there, _ = spot_of(by_name[act["towards"]], moment)
            way = flat(there - here)
            return heading(way) if way.length > 1e-6 else None
        if act.get("turn") is not None:
            return float(act["turn"])
        return None

    def turn_of(plan, moment):
        turn = first_turn(plan)
        for entry in plan["acts"]:
            if moment < entry["start"]:
                break
            asked = asked_turn(plan, entry, min(moment, entry["start"] + entry["seconds"]))
            if asked is None:
                continue
            asked = nearer(asked, turn)
            share = min((moment - entry["start"]) / TURN_SECONDS, 1.0) if TURN_SECONDS > 0 else 1.0
            share = share * share * (3 - 2 * share)
            turn = turn + (asked - turn) * share
        return turn

    def put(plan, moment):
        at, entry = spot_of(plan, moment)
        turn = turn_of(plan, moment)
        # The body's own middle goes over the place and its lowest point on it, wherever its file put them.
        at = at - spin(turn) @ plan["middle"]
        # A clip that carries the body by itself is kept where the walk has got to: what it adds is taken away.
        if entry is not None and entry["to"] is not None and entry["clip"] and entry["clip"]["carried"].length > 1e-6:
            phase = ((moment - entry["start"]) / max(entry["clip"]["seconds"], 1e-6)) % 1.0
            at = at - spin(turn) @ (entry["clip"]["carried"] * phase)
        plan["handle"].location = (at.x, at.y, at.z - plan["feet"])
        plan["handle"].rotation_euler = (0, 0, math.radians(turn + plan["faces"]))
        return turn

    for plan in plans:
        put(plan, 0.0)
    bpy.context.view_layer.update()

    def where(plan):
        """Where a player is over the ground, with what its clip does to it."""
        if plan["arm"] and plan["lead"]:
            return plan["arm"].matrix_world @ plan["lead"].head
        return plan["handle"].matrix_world @ plan["middle"]

    # ── Camera ──────────────────────────────────────────────────────────────
    width, height = cfg["width"], cfg["height"]
    asked = cfg["camera"]
    watched = [by_name[name] for name in (asked.get("on") or [plan["player"]["name"] for plan in plans])]
    follows = bool(asked.get("follow", True))
    place = None
    if asked["kind"] == "set":
        camera = scene.camera
        if camera is None:
            fail("the set has no camera of its own: ask for one in words (view, framing)")
    else:
        view = mathutils.Vector(VIEWS[asked["view"]]).normalized()
        across_axis = UP.cross(view).normalized()
        share, aim, across = FRAMINGS[asked["framing"]]
        tall = max(plan["tall"] for plan in watched)
        data = bpy.data.cameras.new("stage-camera")
        data.lens = 85 if asked["framing"] == "close" else 50
        data.sensor_fit = "VERTICAL"
        data.sensor_height = 24
        data.clip_start, data.clip_end = 0.05, 2000
        camera = bpy.data.objects.new("stage-camera", data)
        scene.collection.objects.link(camera)
        scene.camera = camera

        def framed(stood):
            """What the camera looks at and from how far, to hold players standing in these places."""
            reach = [spot.dot(across_axis) + side * plan["wide"] / 2 for plan, spot in stood for side in (-1, 1)]
            depth = [spot.dot(view) for _plan, spot in stood]
            centre = across_axis * ((max(reach) + min(reach)) / 2) + view * ((max(depth) + min(depth)) / 2)
            held = max(tall * share, (max(reach) - min(reach)) * across * height / width)
            distance = (held / 2) / math.tan(math.atan(12 / data.lens)) + (max(depth) - min(depth)) / 2
            return mathutils.Vector((centre.x, centre.y, min(spot.z for _plan, spot in stood) + tall * aim)), distance

        def place(stood):
            target, distance = framed(stood)
            # A little above what it looks at, so the ground is seen and a face is not looked up at.
            camera.location = target + view * distance + UP * distance * 0.12
            camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
            return target

        # A camera that stays holds everyone it is on, where they start and everywhere they go.
        everywhere = [(plan, spot) for plan in watched for spot in ([plan["start"]] + [spot for entry in plan["acts"] if entry["to"] is not None for spot in entry.get("turns", []) + [entry["to"]]])]
        place(everywhere if not follows else [(plan, plan["start"]) for plan in watched])

    # ── Light and ground. A set brings its own; an empty stage is lit as one character's is ──
    ground = None
    if not cfg.get("set"):
        back = colour(cfg["background"])
        world = bpy.data.worlds.new("world")
        world.use_nodes = True
        shade = world.node_tree.nodes["Background"]
        shade.inputs[0].default_value = (*linear(back), 1)
        shade.inputs[1].default_value = 1.0
        scene.world = world
        scene.view_settings.view_transform = "Standard"
        if cfg["ground"]:
            tallest = max(plan["tall"] for plan in plans)
            bpy.ops.mesh.primitive_circle_add(vertices=96, radius=max(tallest * 8, 20), fill_type="NGON", location=(0, 0, 0))
            ground = bpy.context.active_object
            material = bpy.data.materials.new("ground")
            material.use_nodes = True
            surface = material.node_tree.nodes["Principled BSDF"]
            surface.inputs["Base Color"].default_value = (*linear(tuple(v * 0.96 for v in back)), 1)
            surface.inputs["Roughness"].default_value = 1.0
            ground.data.materials.append(material)
    if not any(o.type == "LIGHT" for o in set_objects):
        sun = bpy.data.objects.new("stage-sun", bpy.data.lights.new("stage-sun", "SUN"))
        sun.data.energy = 3.2
        sun.data.angle = math.radians(12)
        scene.collection.objects.link(sun)
        bpy.context.view_layer.update()
        look = flat(camera.matrix_world.to_3x3() @ mathutils.Vector((0, 0, 1)))
        look = look.normalized() if look.length > 1e-6 else FRONT
        towards = (look + UP.cross(look) * 0.6 + UP * 1.4).normalized()
        sun.rotation_euler = (-towards).to_track_quat("-Z", "Y").to_euler()
        if cfg.get("set"):
            notes.append("the set has no light of its own: a sun was added from beside the camera")

    scene.render.engine = "BLENDER_EEVEE" if bpy.app.version >= (5, 0, 0) else "BLENDER_EEVEE_NEXT"
    scene.eevee.taa_render_samples = cfg["samples"]
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False

    class Skins:
        """Each body's skin as it is now, read once however many ask."""

        def __init__(self):
            self.read = {}

        def __call__(self, plan):
            name = plan["player"]["name"]
            if name not in self.read:
                self.read[name] = plan["parts"].posed() if plan["parts"] else anatomy.skin(plan["body"])
            return self.read[name]

        def cache_clear(self):
            self.read = {}

    class InSet:
        """A body's skin on the far side of a surface of the set from its own middle, over a run of moments."""

        def __init__(self, plan):
            self.plan, self.deep, self.seen, self.looked = plan, plan["tall"] * anatomy.DEEP, {}, None

        def look(self, moment, skin, middle):
            if skin is None or not len(skin):
                return
            if self.looked is None or self.looked[-1] >= len(skin):
                self.looked = np.unique(np.linspace(0, len(skin) - 1, min(LOOKED_AT, len(skin))).astype(np.int64))
            found = {}
            # From above what it steps onto: a foot over a kerb as the body crosses it is not in the set.
            above = self.plan["handle"].location.z + self.plan["feet"] + self.plan["tall"] * STEP
            for point in skin[self.looked]:
                if point[2] < above:
                    continue
                point = mathutils.Vector(point.tolist())
                way = point - mathutils.Vector((middle.x, middle.y, point.z))
                reach = way.length
                if reach < 1e-6:
                    continue
                met = cast(point - way, way / reach, reach)
                if met is not None and reach - met[2] > self.deep:
                    found.setdefault(met[1].name, []).append(reach - met[2])
            for thing, depths in found.items():
                # One point alone may be a hand held out behind a post, not in it.
                if len(depths) < 2:
                    continue
                seen = self.seen.setdefault(thing, {"from": moment, "count": 0, "depth": 0.0, "at": moment})
                seen["count"] += 1
                if max(depths) > seen["depth"]:
                    seen["depth"], seen["at"] = max(depths), moment

        def told(self, step):
            out = [{"thing": thing, "depth": round(seen["depth"], 3), "from": round(seen["from"], 3), "seconds": round(seen["count"] * step, 3), "at": round(seen["at"], 3)} for thing, seen in self.seen.items()]
            return sorted(out, key=lambda item: -item["depth"])

    # ── Film it, and measure what a look at one frame does not show ─────────
    (OUT / "frames").mkdir()
    seen = {plan["player"]["name"]: {"in": 0, "hidden": 0, "from": None, "far": 0.0} for plan in plans}
    close = {}
    # What passes through what is measured against how each stands, arms beside it.
    watching = {plan["player"]["name"]: anatomy.Through(plan["parts"], plan["tall"], plan["before"]) for plan in plans if plan["parts"]}
    within = {plan["player"]["name"]: InSet(plan) for plan in plans} if solid else {}
    skins = Skins()
    for index in range(frames):
        moment = index / fps
        for plan in plans:
            put(plan, moment)
        scene.frame_set(first_frame + index)
        now["graph"] = bpy.context.evaluated_depsgraph_get()
        skins.cache_clear()
        spots = {plan["player"]["name"]: where(plan) for plan in plans}
        if place is not None and follows:
            # It goes with them and holds them as it was asked to: nearer as they come together, further as they part.
            target = place([(plan, mathutils.Vector((spots[plan["player"]["name"]].x, spots[plan["player"]["name"]].y, plan["handle"].location.z + plan["feet"]))) for plan in watched])
            if ground:
                ground.location = (target.x, target.y, 0)
            bpy.context.view_layer.update()
        eye = camera.matrix_world.translation
        for plan in plans:
            name = plan["player"]["name"]
            spot = spots[name]
            if seen[name]["from"] is None:
                seen[name]["from"] = spot.copy()
            seen[name]["far"] = max(seen[name]["far"], flat(spot - seen[name]["from"]).length)
            # Its chest: is it in the picture, and is anything of the set between it and the camera.
            chest = mathutils.Vector((spot.x, spot.y, plan["handle"].location.z + plan["feet"] + plan["tall"] * 0.7))
            u, v, ahead = world_to_camera_view(scene, camera, chest)
            if 0 <= u <= 1 and 0 <= v <= 1 and ahead > 0:
                seen[name]["in"] += 1
                way = chest - eye
                if cast(eye, way.normalized(), way.length * 0.98) is not None:
                    seen[name]["hidden"] += 1
        for name, through in watching.items():
            through.look(moment, skins(by_name[name]))
        for name, inside in within.items():
            inside.look(moment, skins(by_name[name]), spots[name])
        for i, a in enumerate(plans):
            for b in plans[i + 1:]:
                apart = flat(spots[a["player"]["name"]] - spots[b["player"]["name"]]).length
                if apart < (a["girth"] + b["girth"]) * SAME:
                    close.setdefault((a["player"]["name"], b["player"]["name"]), round(moment, 2))
        scene.render.filepath = str(OUT / "frames" / f"{index + 1:06d}.png")
        bpy.ops.render.render(write_still=True)

    def told(plan):
        out = []
        for entry in plan["acts"]:
            clip = entry["clip"]
            speed = entry["distance"] / entry["seconds"] if entry["seconds"] > 0 else 0.0
            out.append({
                "from": round(entry["start"], 3), "seconds": round(entry["seconds"], 3),
                **({"clip": Path(entry["act"]["clip"]).name, "action": called[clip["action"]], "clipSeconds": round(clip["seconds"], 3)} if clip else {}),
                **({"to": [round(v, 3) for v in entry["to"]], "metres": round(entry["distance"], 3), "speed": round(speed, 3)} if entry["to"] is not None else {}),
                # The pace its clip walks at, read from its feet; a body moved faster or slower than that slides.
                **({"pace": round(clip["pace"], 3)} if clip and entry["to"] is not None else {}),
                # What stood in the straight way, which it went round.
                **({"round": entry["round"]} if entry["round"] else {}),
            })
        return out

    (OUT / "shot.json").write_text(json.dumps({
        "frames": frames, "fps": fps, "seconds": round(frames / fps, 3), "width": width, "height": height,
        "set": bool(cfg.get("set")), "marks": sorted(marks),
        "camera": {**asked, "follow": follows} if asked["kind"] != "set" else asked,
        "players": [{
            "name": plan["player"]["name"],
            "skeleton": bool(plan["arm"]),
            "at": [round(v, 3) for v in plan["start"]],
            "turn": round(first_turn(plan), 1),
            "tall": round(plan["tall"], 3),
            "does": told(plan),
            "ends": round(plan["ends"], 3),
            # How far it goes over the ground, in metres.
            "travel": round(seen[plan["player"]["name"]]["far"], 3),
            # The share of the shot its chest is in the picture, and the share it is behind something of the set.
            "inFrame": round(seen[plan["player"]["name"]]["in"] / frames, 3),
            "hidden": round(seen[plan["player"]["name"]]["hidden"] / frames, 3),
            # How far below the horizontal its upper arms hang when it plays no clip; null when it stands in its rest pose.
            "standing": plan["standing"],
            # Parts of it in each other, more than when it stands: how deep at the deepest (metres), from when, for how long.
            "through": watching[plan["player"]["name"]].told(1.0, 1 / fps) if plan["player"]["name"] in watching else [],
            # Its skin through a thing of the set, deepest first: how far beyond the surface (metres), from when, for how long.
            "inSet": within[plan["player"]["name"]].told(1 / fps) if plan["player"]["name"] in within else [],
        } for plan in plans],
        "tooClose": [{"players": list(pair), "from": moment} for pair, moment in close.items()],
        "notes": notes,
        "engine": scene.render.engine, "blender": bpy.app.version_string,
    }, indent=2) + "\n")


main()
