"""What a two-legged body is made of, read from its skeleton and its skin.

Imported by the scripts that run inside Blender (rig-sheet.py, stage-shot.py).
Everything is in the world's axes and the body's own: front (the way it
faces), up, side (towards its left).

- Roles: which bones are a biped's upper arms, forearms, thighs, shins, head
  and spine, read from their names and from the side of the body they are on.
- Turns: a bone turned about an axis of the body, through its head.
"""
import math
import re

import bpy
import mathutils

UP = mathutils.Vector((0, 0, 1))
HELPERS = ("twist", "roll", "helper", "pole", "ctrl", "armature")
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
