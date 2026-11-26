"""A yard for the staged shot's live tests of ways and of contact, in metres: a floor, a post in
the middle, a pavement low enough to step onto, a wall right across, a table with a lantern on
it, marks in the air for a hand, a camera and a light."""
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
box("table", (1, 0.6, 0.8), (3, 2, 0.4))
box("lantern", (0.15, 0.15, 0.15), (3, 1.85, 0.875))


def mark(name, at, turned=0):
    made = bpy.data.objects.new("mark." + name, None)
    made.location = at
    made.rotation_euler = (0, 0, math.radians(turned))
    scene.collection.objects.link(made)


mark("handle", (-3.4, -0.4, 1.1))   # in reach of the right hand of a figure at -3, 0 that faces the audience
mark("far", (-3, -2.5, 1.1))        # out of anyone's reach from there
mark("ledge", (1.25, 1.8, 1.0))     # where the lantern is put down

camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
camera.data.lens = 28
camera.location = (0, -2.6, 4.5)
camera.rotation_euler = (mathutils.Vector((0, 1.5, 0.6)) - camera.location).to_track_quat("-Z", "Y").to_euler()
scene.collection.objects.link(camera)
scene.camera = camera
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.rotation_euler = (math.radians(50), 0, math.radians(20))
scene.collection.objects.link(sun)
