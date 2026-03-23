-- Custom video previewer for yazi
-- Fixes ffmpeg 8.x incompatibility: -skip_frame was removed/deprecated
-- Based on yazi's built-in video plugin with -skip_frame dropped

local M = {}

function M:peek(job)
	local percent = 5 + job.skip
	local cache = ya.file_cache(job)
	if not cache or fs.cha(cache) then
		return
	end

	local cmd = Command("ffmpeg")
		:stderr(Command.PIPED)
		:args({ "-v", "warning", "-hwaccel", "auto", "-threads", "1", "-an", "-sn", "-dn" })

	if percent ~= 0 then
		-- Probe duration for seek position
		local probe = Command("ffprobe")
			:args({ "-v", "quiet", "-print_format", "json", "-show_format", tostring(job.file.url) })
			:stdout(Command.PIPED)
			:output()

		if probe and probe.status and probe.status.success then
			local ok, data = pcall(ya.json_decode, probe.stdout)
			if ok and data and data.format and data.format.duration then
				local duration = tonumber(data.format.duration)
				if duration and duration > 0 then
					cmd:args({ "-ss", tostring(math.floor(duration * percent / 100)) })
				end
			end
		end
	end

	-- No -skip_frame here (removed for ffmpeg 8.x compat)
	cmd:args({ "-i", tostring(job.file.url) })

	if percent == 0 then
		cmd:args({ "-map", "0:v:0?" })
	end

	cmd:args({
		"-vframes", "1",
		"-c:v", "png",
		"-f", "image2",
		"-y", tostring(cache),
	})

	local child, err = cmd:spawn()
	if not child then
		return
	end

	local status = child:wait()
	if status and status.success then
		ya.image_show(cache, job.area)
	end
end

function M:seek(job)
	local h = cx.active.current.hovered
	if h then
		local step = math.max(1, math.abs(job.units))
		local new_skip = math.max(0, job.skip + (job.units > 0 and step or -step))
		ya.emit("peek", { new_skip, only_if = tostring(h.url) })
	end
end

return M
