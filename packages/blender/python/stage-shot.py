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

No script comes with the request. The set is a .blend whose own Python is
not run (--disable-autoexec).
"""
import json
import math
import sys
from pathlib import Path

import bpy
import mathutils
from bpy_extras.object_utils import world_to_camera_view

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
    depsgraph = bpy.context.evaluated_depsgraph_get()

    # ── The floor ───────────────────────────────────────────────────────────
    def surfaces(x, y):
        """Every surface of the set over a place on the stage, from the top down."""
        found, top = [], 10000.0
        for _ in range(16):
            hit, location, *_rest = scene.ray_cast(depsgraph, mathutils.Vector((x, y, top)), mathutils.Vector((0, 0, -1)))
            if not hit:
                break
            found.append(location.z)
            top = location.z - 0.02
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

    def path(start, end):
        """The floor between two places, as heights along the way: a step up onto a pavement is taken where it is."""
        steps = 48
        heights = [floor_at(*start.lerp(end, i / steps).to_2d(), near=start.z + (end.z - start.z) * i / steps) for i in range(steps + 1)]
        heights[0], heights[-1] = start.z, end.z
        return heights

    # Where everyone stands and goes is found before anyone is brought in, so that a player is not another's floor.
    plans = []
    for player in cfg["players"]:
        start, mark_turn = place_of(player.get("at", [0, 0]), player["name"], "at")
        acts, at = [], start
        for number, act in enumerate(player.get("does") or [], 1):
            entry = {"act": act, "from": at, "to": None, "heights": None}
            if act.get("to") is not None:
                entry["to"] = place_of(act["to"], player["name"], f"act {number}, to")[0]
                entry["heights"] = path(at, entry["to"])
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
            "own": moving(actions) if arm else None,
            "tall": high.z - low.z, "wide": max(high.x - low.x, high.y - low.y), "feet": low.z,
            "middle": mathutils.Vector(((low.x + high.x) / 2, (low.y + high.y) / 2, 0)),
        })
        if abs(low.z) > max(plan["tall"], 1e-6) * 0.05:
            notes.append(f"{player['name']} does not stand on the ground in its own file (its lowest point is at {low.z:.2f}): it was put on its mark by its lowest point")

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
        plan["measured"] = {path: measure(plan, action) for path, action in clips.items()} if arm else {}

    # ── What each player does, and when ─────────────────────────────────────
    for plan in plans:
        player = plan["player"]
        moment = 0.0
        for number, entry in enumerate(plan["acts"], 1):
            act = entry["act"]
            clip = plan["measured"].get(act["clip"]) if act.get("clip") else None
            distance = flat(entry["to"] - entry["from"]).length if entry["to"] is not None else 0.0
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

    # Each clip on a track of its own, above the one before. A clip comes in over the pose the last
    # one left, or out of the rest pose; when nothing follows it, it gives way to the rest pose again.
    for plan in plans:
        arm = plan["arm"]
        if not arm:
            continue
        playing = [entry for entry in plan["acts"] if entry["clip"]]
        if not playing:
            continue
        data = arm.animation_data_create()
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
            # Held while the next clip comes in over it; otherwise let go, so the body is not left frozen in a stride.
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
                way = entry["from"].lerp(entry["to"], share)
                heights = entry["heights"]
                along = share * (len(heights) - 1)
                low = min(int(along), len(heights) - 2)
                way.z = heights[low] + (heights[low + 1] - heights[low]) * (along - low)
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
            return heading(flat(entry["to"] - entry["from"]))
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
        # Everyone it is on, where they start — and, for a camera that stays, everywhere they go — measured across the picture.
        stood = [(plan, spot) for plan in watched for spot in ([plan["start"]] + ([] if follows else [entry["to"] for entry in plan["acts"] if entry["to"] is not None]))]
        reach = [spot.dot(across_axis) + side * plan["wide"] / 2 for plan, spot in stood for side in (-1, 1)]
        depth = [spot.dot(view) for _plan, spot in stood]
        group_wide = max(reach) - min(reach)
        centre = across_axis * ((max(reach) + min(reach)) / 2) + view * ((max(depth) + min(depth)) / 2)
        base = min(spot.z for _plan, spot in stood)
        held = max(tall * share, group_wide * across * height / width)
        data = bpy.data.cameras.new("stage-camera")
        data.lens = 85 if asked["framing"] == "close" else 50
        data.sensor_fit = "VERTICAL"
        data.sensor_height = 24
        distance = (held / 2) / math.tan(math.atan(12 / data.lens)) + (max(depth) - min(depth)) / 2
        data.clip_start, data.clip_end = max(distance / 100, 0.01), max(distance * 100, 1000)
        camera = bpy.data.objects.new("stage-camera", data)
        scene.collection.objects.link(camera)
        scene.camera = camera
        target = mathutils.Vector((centre.x, centre.y, base + tall * aim))
        offset = view * distance + UP * distance * 0.12

        def place(at):
            camera.location = at + offset
            camera.rotation_euler = (at - camera.location).to_track_quat("-Z", "Y").to_euler()
        place(target)

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

    # ── Film it, and measure what a look at one frame does not show ─────────
    (OUT / "frames").mkdir()
    seen = {plan["player"]["name"]: {"in": 0, "hidden": 0, "from": None, "far": 0.0} for plan in plans}
    close = {}
    watched_start = None
    for index in range(frames):
        moment = index / fps
        for plan in plans:
            put(plan, moment)
        scene.frame_set(first_frame + index)
        graph = bpy.context.evaluated_depsgraph_get()
        spots = {plan["player"]["name"]: where(plan) for plan in plans}
        if place is not None and follows:
            now = sum((spots[plan["player"]["name"]] for plan in watched), mathutils.Vector()) / len(watched)
            if watched_start is None:
                watched_start = now
            moved = flat(now - watched_start)
            place(target + moved)
            if ground:
                ground.location = (moved.x, moved.y, 0)
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
                hit, _location, _normal, _face, obj, _matrix = scene.ray_cast(graph, eye, way.normalized(), distance=way.length * 0.98)
                if hit and obj is not None and obj.original in set_meshes:
                    seen[name]["hidden"] += 1
        for i, a in enumerate(plans):
            for b in plans[i + 1:]:
                apart = flat(spots[a["player"]["name"]] - spots[b["player"]["name"]]).length
                if apart < (a["wide"] + b["wide"]) * 0.3:
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
        } for plan in plans],
        "tooClose": [{"players": list(pair), "from": moment} for pair, moment in close.items()],
        "notes": notes,
        "engine": scene.render.engine, "blender": bpy.app.version_string,
    }, indent=2) + "\n")


main()
