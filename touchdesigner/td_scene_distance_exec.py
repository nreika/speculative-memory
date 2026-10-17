# Parameter Execute DAT /project1/scene_distance_exec
# Monitors /project1 (Distance* custom pars) and slider1 / slider_dist_b / slider_dist_c (value0).
# All logic lives in /project1/td_scene_distance (td_scene_distance.py).

def onValueChange(par, prev):
	m = op('/project1/td_scene_distance')
	if m is not None:
		m.module.on_change(par, prev)
	return

def onPulse(par):
	return

def onExpressionChange(par, val, prev):
	return

def onExportChange(par, val, prev):
	return

def onEnableChange(par, val, prev):
	return

def onModeChange(par, val, prev):
	return
