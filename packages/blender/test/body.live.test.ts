import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { blenderExecutable } from "../src/index.js";

const live = { skip: process.env.BLENDER_LIVE !== "1", timeout: 120_000 };

// python/body.py is imported by the scripts Blender runs. This runs a few lines of it there.
const SCRIPT = `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[sys.argv.index("--") + 1])
import bpy, mathutils
import body
bpy.ops.wm.read_factory_settings(use_empty=True)
data = bpy.data.armatures.new("skeleton")
arm = bpy.data.objects.new("skeleton", data)
bpy.context.scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
for name in ("below", "above"):
    bone = data.edit_bones.new(name)
    bone.head, bone.tail = (0, 0, 0), (0, 0, 1)
bpy.ops.object.mode_set(mode="OBJECT")
turn = mathutils.Quaternion((0, 0, 1), 0.6)
action = bpy.data.actions.new("clip")
arm.animation_data_create().action = action
for name, sign in (("below", -1), ("above", 1)):
    bone = arm.pose.bones[name]
    for frame, angle in ((1, 0.2), (10, 0.6), (20, 0.4)):
        bone.rotation_quaternion = mathutils.Quaternion((0, 0, 1), angle) * sign
        bone.keyframe_insert("rotation_quaternion", frame=frame)
before = {}
for frame in (1, 5, 10, 15, 20):
    bpy.context.scene.frame_set(frame)
    before[frame] = {b.name: [round(v, 6) for v in b.matrix.to_quaternion()] for b in arm.pose.bones}
turned = body.shortest(action)
after, w = {}, {}
for frame in (1, 5, 10, 15, 20):
    bpy.context.scene.frame_set(frame)
    after[frame] = {b.name: [round(v, 6) for v in b.matrix.to_quaternion()] for b in arm.pose.bones}
    w[frame] = {b.name: round(b.rotation_quaternion.w, 6) for b in arm.pose.bones}
Path(sys.argv[-1]).write_text(json.dumps({"turned": turned, "same": before == after, "w": w}))
`;

test("LIVE: a clip whose turns are written below w 0 is turned over: the same pose, and blends take the short way", live, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "body-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "check.py"), out = join(root, "out.json");
  await writeFile(script, SCRIPT);
  const python = fileURLToPath(new URL("../python", import.meta.url));
  const run = spawnSync(blenderExecutable(), ["--background", "--factory-startup", "--python-exit-code", "1", "--python", script, "--", python, out], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const found = JSON.parse(await readFile(out, "utf8"));
  // One bone's turns were all written as -q: they are now q. The other's were left alone. Neither pose moved.
  assert.equal(found.turned, 1);
  assert.equal(found.same, true);
  for (const frame of Object.keys(found.w)) {
    assert.ok(found.w[frame].below > 0, `below at ${frame}: ${found.w[frame].below}`);
    assert.ok(found.w[frame].above > 0, `above at ${frame}: ${found.w[frame].above}`);
  }
});
