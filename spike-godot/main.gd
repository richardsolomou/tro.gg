extends Node3D
# tro.gg full-3D spike, Godot variant: the same probe as `/spike3d` (Three.js) —
# one zone, one procedurally built jointed trogg, walk/run/attack end-to-end —
# for comparing engines. Everything on screen is generated here in code; the
# animations are real Animation resources played through an AnimationPlayer.
#
# WASD move · shift run · F attack. Set SPIKE_SHOT=/path.png (and optionally
# SPIKE_ACTIONS="walk run attack") to auto-screenshot and quit, for headless-ish
# verification.

const ZONE := 24.0
const MOVE_SPEED := 4.0 # tiles/sec, matching shared/constants.ts
const RUN_SPEED := 7.0

# The moss trogg palette (TROGG_SKINS in tools/art/trogg.ts).
const BASE := Color8(0x6f, 0x83, 0x38)
const SHADE := Color8(0x38, 0x48, 0x1c)
const LIGHT := Color8(0xb8, 0xbd, 0x73)
const MUZZLE := Color8(0x9b, 0xa3, 0x5a)
const EYE := Color8(0xf8, 0x38, 0x20)
const TOOTH := Color8(0xff, 0xf4, 0xd8)

# Joint rest pitches: the hunch is part of the skeleton; clips bake these in.
const REST_TORSO := 0.14
const REST_HEAD := -0.1
const REST_ARM := 0.08

var trogg: Node3D
var player: AnimationPlayer
var cam: Camera3D
var gait := "idle"
var attacking := false
var f_was_down := false
var look_target := Vector3(0, 0.9, 0)

func _ready() -> void:
	_build_environment()
	_build_ground()
	_build_scenery()
	trogg = _build_trogg()
	add_child(trogg)
	player = _build_animations(trogg)
	player.animation_finished.connect(_on_animation_finished)
	player.play("idle")
	cam = Camera3D.new()
	cam.position = Vector3(0, 6.5, 7.5)
	add_child(cam)
	cam.look_at(Vector3(0, 0.9, 0))
	if OS.get_environment("SPIKE_SHOT") != "":
		_screenshot_run()

# ── environment ──────────────────────────────────────────────────────────────

func _build_environment() -> void:
	var env := Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = Color8(0xbc, 0xd0, 0xe8)
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color8(0xd8, 0xe8, 0xc8)
	env.ambient_light_energy = 0.6
	env.fog_enabled = true
	env.fog_light_color = Color8(0xbc, 0xd0, 0xe8)
	env.fog_density = 0.012
	var world := WorldEnvironment.new()
	world.environment = env
	add_child(world)

	var sun := DirectionalLight3D.new()
	sun.position = Vector3(8, 14, 6)
	sun.look_at_from_position(sun.position, Vector3.ZERO)
	sun.light_energy = 1.4
	sun.shadow_enabled = true
	add_child(sun)

func _mat(colour: Color, emissive := false) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = colour
	m.roughness = 0.9
	if emissive:
		m.emission_enabled = true
		m.emission = colour
		m.emission_energy_multiplier = 0.9
	return m

func _build_ground() -> void:
	var px := 8
	var size := int(ZONE) * px
	var img := Image.create(size, size, false, Image.FORMAT_RGB8)
	var light := Color8(0x7b, 0xa2, 0x4a)
	var dark := Color8(0x6e, 0x94, 0x40)
	var tuft := Color8(0x55, 0x7a, 0x30)
	for ty in int(ZONE):
		for tx in int(ZONE):
			var tile := light if (tx + ty) % 2 == 0 else dark
			for y in px:
				for x in px:
					img.set_pixel(tx * px + x, ty * px + y, tile)
			if (tx * 7 + ty * 13) % 5 == 0:
				var ox := (tx * 11 + ty * 3) % (px - 2) + 1
				var oy := (tx * 5 + ty * 17) % (px - 2) + 1
				img.set_pixel(tx * px + ox, ty * px + oy, tuft)
				img.set_pixel(tx * px + ox + 1, ty * px + oy, tuft)
	var m := StandardMaterial3D.new()
	m.albedo_texture = ImageTexture.create_from_image(img)
	m.texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
	m.roughness = 1.0
	var plane := PlaneMesh.new()
	plane.size = Vector2(ZONE, ZONE)
	var ground := MeshInstance3D.new()
	ground.mesh = plane
	ground.material_override = m
	add_child(ground)

func _build_scenery() -> void:
	for spot in [[3.0, -2.0, 0.55], [-4.0, 3.0, 0.7], [6.0, 5.0, 0.45], [-7.0, -6.0, 0.6]]:
		var rock := MeshInstance3D.new()
		var mesh := SphereMesh.new() # low-poly boulder: a coarse sphere reads like the dodecahedron
		mesh.radial_segments = 6
		mesh.rings = 3
		mesh.radius = spot[2]
		mesh.height = spot[2] * 1.7
		rock.mesh = mesh
		rock.material_override = _mat(Color8(0x74, 0x78, 0x6c))
		rock.position = Vector3(spot[0], spot[2] * 0.6, spot[1])
		rock.rotation = Vector3(spot[0], spot[1], spot[0] + spot[1])
		add_child(rock)
	for spot in [[-3.0, -5.0, 1.1], [5.0, -7.0, 1.35], [-8.0, 1.0, 1.2], [8.0, -1.0, 1.0], [-5.0, 7.0, 1.25], [2.0, 8.0, 1.15]]:
		var s: float = spot[2]
		var tree := Node3D.new()
		var trunk := MeshInstance3D.new()
		var cyl := CylinderMesh.new()
		cyl.top_radius = 0.12 * s
		cyl.bottom_radius = 0.16 * s
		cyl.height = 0.7 * s
		trunk.mesh = cyl
		trunk.material_override = _mat(Color8(0x5a, 0x3d, 0x20))
		trunk.position.y = 0.35 * s
		tree.add_child(trunk)
		for tier in [[0.9, 0.8, 0.8], [0.7, 0.7, 1.35], [0.45, 0.6, 1.85]]:
			var cone := MeshInstance3D.new()
			var c := CylinderMesh.new()
			c.top_radius = 0.0
			c.bottom_radius = tier[0] * s
			c.height = tier[1] * s
			c.radial_segments = 7
			cone.mesh = c
			cone.material_override = _mat(SHADE)
			cone.position.y = tier[2] * s
			tree.add_child(cone)
		tree.position = Vector3(spot[0], 0, spot[1])
		add_child(tree)

# ── the trogg ────────────────────────────────────────────────────────────────

func _box(parent: Node3D, size: Vector3, colour: Color, pos: Vector3, emissive := false) -> void:
	var mesh := BoxMesh.new()
	mesh.size = size
	var inst := MeshInstance3D.new()
	inst.mesh = mesh
	inst.material_override = _mat(colour, emissive)
	inst.position = pos
	parent.add_child(inst)

func _joint(parent: Node3D, name_: String, pos: Vector3, pitch := 0.0) -> Node3D:
	var g := Node3D.new()
	g.name = name_
	g.position = pos
	g.rotation.x = pitch
	parent.add_child(g)
	return g

func _build_trogg() -> Node3D:
	var root := Node3D.new()
	root.name = "Trogg"
	var bob := _joint(root, "Bob", Vector3.ZERO)

	for side in [-1.0, 1.0]:
		var leg := _joint(bob, "LegL" if side < 0 else "LegR", Vector3(side * 0.2, 0.5, 0))
		_box(leg, Vector3(0.26, 0.32, 0.28), BASE, Vector3(0, -0.14, 0))
		_box(leg, Vector3(0.2, 0.24, 0.22), SHADE, Vector3(0, -0.36, 0))
		_box(leg, Vector3(0.26, 0.12, 0.36), BASE, Vector3(0, -0.46, 0.06))
		_box(leg, Vector3(0.27, 0.05, 0.06), SHADE, Vector3(0, -0.5, 0.22))

	var torso := _joint(bob, "Torso", Vector3(0, 0.55, 0), REST_TORSO)
	_box(torso, Vector3(0.62, 0.52, 0.46), BASE, Vector3(0, 0.26, 0))
	_box(torso, Vector3(0.46, 0.36, 0.05), LIGHT, Vector3(0, 0.22, 0.22))
	_box(torso, Vector3(0.48, 0.04, 0.06), SHADE, Vector3(0, 0.14, 0.22))
	_box(torso, Vector3(0.48, 0.04, 0.06), SHADE, Vector3(0, 0.28, 0.22))
	_box(torso, Vector3(0.88, 0.3, 0.5), BASE, Vector3(0, 0.62, 0))
	_box(torso, Vector3(0.24, 0.1, 0.34), LIGHT, Vector3(-0.36, 0.78, 0))
	_box(torso, Vector3(0.24, 0.1, 0.34), LIGHT, Vector3(0.36, 0.78, 0))

	for side in [-1.0, 1.0]:
		var arm := _joint(torso, "ArmL" if side < 0 else "ArmR", Vector3(side * 0.52, 0.62, 0), REST_ARM)
		_box(arm, Vector3(0.2, 0.42, 0.22), BASE, Vector3(0, -0.2, 0))
		_box(arm, Vector3(0.18, 0.3, 0.2), SHADE, Vector3(0, -0.52, 0))
		_box(arm, Vector3(0.26, 0.24, 0.26), BASE, Vector3(0, -0.74, 0))

	var head := _joint(torso, "Head", Vector3(0, 1.0, 0.14), REST_HEAD)
	_box(head, Vector3(0.52, 0.42, 0.48), BASE, Vector3(0, 0.16, 0))
	_box(head, Vector3(0.42, 0.08, 0.4), LIGHT, Vector3(0, 0.4, -0.02))
	_box(head, Vector3(0.54, 0.08, 0.06), SHADE, Vector3(0, 0.22, 0.23))
	_box(head, Vector3(0.08, 0.07, 0.04), EYE, Vector3(-0.13, 0.15, 0.25), true)
	_box(head, Vector3(0.08, 0.07, 0.04), EYE, Vector3(0.13, 0.15, 0.25), true)
	_box(head, Vector3(0.24, 0.12, 0.1), MUZZLE, Vector3(0, 0.02, 0.26))
	_box(head, Vector3(0.4, 0.09, 0.08), SHADE, Vector3(0, -0.09, 0.24))
	_box(head, Vector3(0.06, 0.13, 0.05), TOOTH, Vector3(-0.17, -0.05, 0.26))
	_box(head, Vector3(0.06, 0.13, 0.05), TOOTH, Vector3(0.17, -0.05, 0.26))

	return root

# ── the clips ────────────────────────────────────────────────────────────────
# Value tracks on each joint's euler rotation, rest pitches baked in — the same
# clip data as the Three.js spike, expressed as Godot Animation resources.

func _pitch_track(a: Animation, path: String, rest: float, times: Array, pitches: Array) -> void:
	var i := a.add_track(Animation.TYPE_VALUE)
	a.track_set_path(i, path)
	for k in times.size():
		a.track_insert_key(i, times[k], Vector3(rest + pitches[k], 0, 0))

func _bob_track(a: Animation, times: Array, ys: Array) -> void:
	var i := a.add_track(Animation.TYPE_VALUE)
	a.track_set_path(i, "Bob:position")
	for k in times.size():
		a.track_insert_key(i, times[k], Vector3(0, ys[k], 0))

func _gait_clip(period: float, leg: float, arm: float, dip: float, lean: float) -> Animation:
	var a := Animation.new()
	a.length = period
	a.loop_mode = Animation.LOOP_LINEAR
	var t := [0.0, period / 4, period / 2, 3 * period / 4, period]
	_pitch_track(a, "Bob/LegL:rotation", 0.0, t, [leg, 0.0, -leg, 0.0, leg])
	_pitch_track(a, "Bob/LegR:rotation", 0.0, t, [-leg, 0.0, leg, 0.0, -leg])
	_pitch_track(a, "Bob/Torso/ArmL:rotation", REST_ARM, t, [-arm, 0.0, arm, 0.0, -arm])
	_pitch_track(a, "Bob/Torso/ArmR:rotation", REST_ARM, t, [arm, 0.0, -arm, 0.0, arm])
	_pitch_track(a, "Bob/Torso:rotation", REST_TORSO, [0.0, period], [lean, lean])
	_bob_track(a, t, [-dip, 0.0, -dip, 0.0, -dip])
	return a

func _idle_clip() -> Animation:
	var a := Animation.new()
	a.length = 2.6
	a.loop_mode = Animation.LOOP_LINEAR
	var t := [0.0, 1.3, 2.6]
	_bob_track(a, t, [0.0, -0.015, 0.0])
	_pitch_track(a, "Bob/Torso:rotation", REST_TORSO, t, [0.0, 0.02, 0.0])
	return a

func _attack_clip() -> Animation:
	# An arm hangs along -y, so negative pitch swings it toward the +z facing.
	var a := Animation.new()
	a.length = 0.32
	var strike := 0.32 * 0.35
	_pitch_track(a, "Bob/Torso/ArmR:rotation", REST_ARM, [0.0, strike * 0.6, strike, 0.32], [0.0, 0.9, -1.5, -0.1])
	_pitch_track(a, "Bob/Torso:rotation", REST_TORSO, [0.0, strike * 0.6, strike, 0.32], [0.0, -0.06, 0.14, 0.02])
	_bob_track(a, [0.0, strike, 0.32], [0.0, -0.03, 0.0])
	return a

func _build_animations(target: Node3D) -> AnimationPlayer:
	var p := AnimationPlayer.new()
	target.add_child(p)
	var lib := AnimationLibrary.new()
	lib.add_animation("idle", _idle_clip())
	lib.add_animation("walk", _gait_clip(0.52, 0.55, 0.45, 0.05, 0.02))
	lib.add_animation("run", _gait_clip(0.34, 0.85, 0.7, 0.08, 0.16))
	lib.add_animation("attack", _attack_clip())
	p.add_animation_library("", lib)
	return p

# ── input + loop ─────────────────────────────────────────────────────────────

func _on_animation_finished(anim: StringName) -> void:
	if anim == &"attack":
		attacking = false
		player.play(gait, 0.1)

func _swing() -> void:
	if attacking:
		return
	attacking = true
	player.play("attack", 0.05)

func _process(delta: float) -> void:
	var actions := OS.get_environment("SPIKE_ACTIONS")
	var dx := 0.0
	var dz := 0.0
	if Input.is_physical_key_pressed(KEY_D) or Input.is_physical_key_pressed(KEY_RIGHT):
		dx += 1
	if Input.is_physical_key_pressed(KEY_A) or Input.is_physical_key_pressed(KEY_LEFT):
		dx -= 1
	if Input.is_physical_key_pressed(KEY_S) or Input.is_physical_key_pressed(KEY_DOWN):
		dz += 1
	if Input.is_physical_key_pressed(KEY_W) or Input.is_physical_key_pressed(KEY_UP):
		dz -= 1
	if "walk" in actions or "run" in actions:
		dz -= 1
		dx += 1
	var moving := dx != 0 or dz != 0
	var running := moving and (Input.is_physical_key_pressed(KEY_SHIFT) or "run" in actions)

	var f_down := Input.is_physical_key_pressed(KEY_F)
	if f_down and not f_was_down:
		_swing()
	f_was_down = f_down

	if moving:
		var speed := RUN_SPEED if running else MOVE_SPEED
		var dir := Vector2(dx, dz).normalized()
		var half := ZONE / 2 - 0.6
		trogg.position.x = clampf(trogg.position.x + dir.x * speed * delta, -half, half)
		trogg.position.z = clampf(trogg.position.z + dir.y * speed * delta, -half, half)
		var target := atan2(dir.x, dir.y)
		trogg.rotation.y = lerp_angle(trogg.rotation.y, target, minf(1.0, delta * 14))

	if not attacking:
		var next := "run" if running else ("walk" if moving else "idle")
		if next != gait:
			gait = next
			player.play(gait, 0.12)
	else:
		gait = "run" if running else ("walk" if moving else "idle")

	var eye := trogg.position + Vector3(0, 6.5, 7.5)
	cam.position = cam.position.lerp(eye, minf(1.0, delta * 6))
	look_target = look_target.lerp(trogg.position + Vector3(0, 0.9, 0), minf(1.0, delta * 8))
	cam.look_at(look_target)

# ── screenshot mode ──────────────────────────────────────────────────────────

func _screenshot_run() -> void:
	var actions := OS.get_environment("SPIKE_ACTIONS")
	await get_tree().create_timer(1.2).timeout
	if "attack" in actions:
		_swing()
		await get_tree().create_timer(0.12).timeout
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png(OS.get_environment("SPIKE_SHOT"))
	get_tree().quit()
