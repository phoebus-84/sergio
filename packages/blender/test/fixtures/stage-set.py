"""A set for the staged shot's live test, in metres: a floor, a platform half a metre high, a wall
between the camera and one of the marks, two marks, a camera and a light."""
import math
import bpy
import mathutils

scene = bpy.context.scene
scene.render.fps = 12


def box(name, size, at):
    bpy.ops.mesh.primitive_cube_add(size=1, location=at)
    made = bpy.context.active_object
    made.name = name
    made.scale = size
    return made


box("floor", (20, 20, 0.2), (0, 0, -0.1))
box("platform", (2, 2, 0.5), (3, 0, 0.25))
box("wall", (2, 0.2, 2), (-3, -2, 1))


def mark(name, at, turned=0):
    made = bpy.data.objects.new("mark." + name, None)
    made.location = at
    made.rotation_euler = (0, 0, math.radians(turned))
    scene.collection.objects.link(made)


mark("platform", (3, 0, 0.5), -90)  # on the platform, turned to the left of the picture
mark("behind", (-3, 0, 0))          # behind the wall, as the camera sees it

camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
camera.data.lens = 35
camera.location = (0, -8, 1.5)
camera.rotation_euler = (mathutils.Vector((0, 0, 1)) - camera.location).to_track_quat("-Z", "Y").to_euler()
scene.collection.objects.link(camera)
scene.camera = camera
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.rotation_euler = (math.radians(50), 0, math.radians(20))
scene.collection.objects.link(sun)
