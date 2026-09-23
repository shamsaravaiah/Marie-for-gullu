# Blender sprite renderer for CatPet
# How to use: open your cat in Blender → "Scripting" tab → New → paste this → Run Script.
# Renders a transparent side view into ~/CatPet/sprites/<NAME>_0.png, _1.png ...
# If the scene has an animation, every STEP-th frame is rendered; otherwise one still.

import bpy, os, math
from mathutils import Vector

NAME = "walk"      # file prefix: walk / sit / sleep / eat / groom / happy
SIZE = 256         # output image size in pixels
STEP = 2           # for animations: render every Nth frame
SIDE = -1          # if the cat faces LEFT in the result, change to 1 and run again

OUT = os.path.expanduser("~/CatPet/sprites")
os.makedirs(OUT, exist_ok=True)
scene = bpy.context.scene

# --- Find the cat's bounding box ---
meshes = [o for o in scene.objects if o.type == 'MESH' and o.visible_get()]
pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
center = (lo + hi) / 2
extent = max(hi - lo)

# --- Orthographic side camera ---
cam_data = bpy.data.cameras.new("SpriteCam")
cam_data.type = 'ORTHO'
cam_data.ortho_scale = extent * 1.15
cam = bpy.data.objects.new("SpriteCam", cam_data)
scene.collection.objects.link(cam)
cam.location = center + Vector((SIDE * extent * 3, 0, 0))
cam.rotation_euler = (math.radians(90), 0, math.radians(90 * (1 if SIDE > 0 else -1)))
cam_data.clip_end = extent * 10
scene.camera = cam

# --- Add soft lighting if the scene has none ---
if not any(o.type == 'LIGHT' for o in scene.objects):
    for name, rot, energy in (("Key", (50, 0, -40), 3.0), ("Fill", (60, 0, 140), 1.0)):
        ld = bpy.data.lights.new(name, 'SUN')
        ld.energy = energy
        lo_ = bpy.data.objects.new(name, ld)
        lo_.rotation_euler = [math.radians(a) for a in rot]
        scene.collection.objects.link(lo_)

# --- Render settings: transparent PNG ---
for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    try:
        scene.render.engine = eng
        break
    except TypeError:
        pass
scene.render.film_transparent = True
scene.render.resolution_x = SIZE
scene.render.resolution_y = SIZE
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'

# --- Render ---
animated = any(o.animation_data and o.animation_data.action for o in scene.objects)
frames = range(scene.frame_start, scene.frame_end + 1, STEP) if animated else [scene.frame_current]

for i, f in enumerate(frames):
    scene.frame_set(f)
    scene.render.filepath = os.path.join(OUT, f"{NAME}_{i}.png")
    bpy.ops.render.render(write_still=True)

print(f"Done: {len(frames)} frame(s) saved to {OUT}")