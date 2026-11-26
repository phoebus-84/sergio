"""A yard for the staged shot's live tests of ways, in metres: a floor, a post in the middle, a
pavement low enough to step onto, a wall right across, a camera and a light."""
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
box("post", (0.3, 0.3, 2.5), (0, 0, 1.25))
box("pavement", (4, 2, 0.2), (0, 5, 0.1))
box("wall", (20, 0.2, 2), (0, -3, 1))

camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
camera.data.lens = 28
camera.location = (0, -2.6, 4.5)
camera.rotation_euler = (mathutils.Vector((0, 1.5, 0.6)) - camera.location).to_track_quat("-Z", "Y").to_euler()
scene.collection.objects.link(camera)
scene.camera = camera
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.rotation_euler = (math.radians(50), 0, math.radians(20))
scene.collection.objects.link(sun)
