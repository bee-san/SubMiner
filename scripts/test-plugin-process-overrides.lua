local function assert_equals(expected, actual, message)
	if expected == actual then
		return
	end
	error(message .. " (expected " .. tostring(expected) .. ", got " .. tostring(actual) .. ")")
end

local process_module = dofile("plugin/subminer/process.lua")
local process = process_module.create({
	mp = {},
	opts = {},
	state = {},
	binary = {},
	environment = {},
	options_helper = {
		coerce_bool = function(value, default)
			if value == nil then
				return default
			end
			return value == true or value == "true" or value == "yes" or value == "1"
		end,
	},
	log = {
		subminer_log = function() end,
		show_osd = function() end,
		normalize_log_level = function(value)
			return value or "info"
		end,
	},
})

local overrides = process.parse_start_script_message_overrides("backend=windows")
assert_equals("windows", overrides.backend, "expected backend=windows override to be accepted")

local command_native_async_calls = 0
local shown_osd = {}

process = process_module.create({
	mp = {
		command_native_async = function()
			command_native_async_calls = command_native_async_calls + 1
		end,
		get_property = function()
			return ""
		end,
		set_property_native = function() end,
	},
	opts = {
		backend = "auto",
		socket_path = "/tmp/subminer.sock",
	},
	state = {},
	binary = {
		ensure_binary_available = function()
			return true
		end,
	},
	environment = {
		detect_backend = function()
			return nil
		end,
	},
	options_helper = {
		coerce_bool = function(value, default)
			if value == nil then
				return default
			end
			return value == true or value == "true" or value == "yes" or value == "1"
		end,
	},
	log = {
		subminer_log = function() end,
		show_osd = function(message)
			shown_osd[#shown_osd + 1] = message
		end,
		normalize_log_level = function(value)
			return value or "info"
		end,
	},
})

process.start_overlay({})

assert_equals(0, command_native_async_calls, "expected unsupported auto backend detection to skip overlay start")
assert_equals("Unsupported desktop backend", shown_osd[1], "expected unsupported backend to surface an OSD message")

local linux_start_calls = {}

process = process_module.create({
	mp = {
		command_native_async = function(command)
			linux_start_calls[#linux_start_calls + 1] = command
		end,
		get_property = function()
			return ""
		end,
		set_property_native = function() end,
	},
	opts = {
		backend = "kwin",
		socket_path = "/tmp/subminer.sock",
	},
	state = {
		binary_path = "/tmp/SubMiner.AppImage",
	},
	binary = {
		ensure_binary_available = function()
			return true
		end,
	},
	environment = {
		detect_backend = function()
			return "kwin"
		end,
		is_linux = function()
			return true
		end,
	},
	options_helper = {
		coerce_bool = function(value, default)
			if value == nil then
				return default
			end
			return value == true or value == "true" or value == "yes" or value == "1"
		end,
	},
	log = {
		subminer_log = function() end,
		show_osd = function() end,
		normalize_log_level = function(value)
			return value or "info"
		end,
	},
})

process.start_overlay({})

local linux_start_args = linux_start_calls[1].args
assert_equals("env", linux_start_args[1], "expected Linux kwin start to use env wrapper")
assert_equals(
	"ELECTRON_OZONE_PLATFORM_HINT=x11",
	linux_start_args[2],
	"expected Linux kwin start to force Electron Ozone hint to x11"
)
assert_equals("OZONE_PLATFORM=x11", linux_start_args[3], "expected Linux kwin start to force Ozone platform to x11")
assert_equals("/tmp/SubMiner.AppImage", linux_start_args[4], "expected wrapped command to preserve binary path")
assert_equals("--start", linux_start_args[5], "expected wrapped command to preserve start action")
assert_equals("--backend", linux_start_args[6], "expected wrapped command to preserve backend flag")
assert_equals("kwin", linux_start_args[7], "expected wrapped command to preserve resolved backend")

local hyprland_start_calls = {}

process = process_module.create({
	mp = {
		command_native_async = function(command)
			hyprland_start_calls[#hyprland_start_calls + 1] = command
		end,
		get_property = function()
			return ""
		end,
		set_property_native = function() end,
	},
	opts = {
		backend = "hyprland",
		socket_path = "/tmp/subminer.sock",
	},
	state = {
		binary_path = "/tmp/SubMiner.AppImage",
	},
	binary = {
		ensure_binary_available = function()
			return true
		end,
	},
	environment = {
		detect_backend = function()
			return "hyprland"
		end,
		is_linux = function()
			return true
		end,
	},
	options_helper = {
		coerce_bool = function(value, default)
			if value == nil then
				return default
			end
			return value == true or value == "true" or value == "yes" or value == "1"
		end,
	},
	log = {
		subminer_log = function() end,
		show_osd = function() end,
		normalize_log_level = function(value)
			return value or "info"
		end,
	},
})

process.start_overlay({})

assert_equals(
	"/tmp/SubMiner.AppImage",
	hyprland_start_calls[1].args[1],
	"expected supported native Wayland backends to avoid the X11 env wrapper"
)

print("plugin process override tests: OK")
