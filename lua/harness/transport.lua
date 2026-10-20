local M = {}
local LIMIT = 4 * 1024 * 1024

function M.new(options, changed, notification)
  local self = { pending = {}, serial = 0, connected = false }

  local function fail(message)
    local job = self.job
    self.job, self.connected = nil, false
    if job then pcall(vim.fn.jobstop, job) end
    local pending = self.pending
    self.pending = {}
    changed(message)
    for _, callback in pairs(pending) do callback(nil, message) end
  end

  function self.request(method, params, callback)
    if not self.job then callback(nil, 'Connection unavailable. Use :Harness to reconnect.'); return end
    if vim.tbl_count(self.pending) >= 32 then callback(nil, 'Too many pending requests.'); return end
    self.serial = self.serial + 1
    local id = tostring(self.serial)
    local line = vim.json.encode({ jsonrpc = '2.0', id = id, method = method, params = params or vim.empty_dict() }) .. '\n'
    if #line > LIMIT then callback(nil, 'Protocol record exceeds 4 MiB.'); return end
    self.pending[id] = callback
    if vim.fn.chansend(self.job, line) == 0 then fail('Client pipe closed.') end
  end

  function self.arguments(command)
    local result = { options.executable }
    if options.config_path then vim.list_extend(result, { '--config', options.config_path }) end
    if options.socket_path then vim.list_extend(result, { '--socket', options.socket_path }) end
    result[#result + 1] = command
    return result
  end

  local function proxy(callback)
    local partial, stderr = '', ''
    local job
    job = vim.fn.jobstart(self.arguments('rpc'), {
      on_stdout = function(_, data)
        local chunk = table.concat(data, '\n')
        vim.schedule(function()
          if self.job ~= job then return end
          partial = partial .. chunk
          while true do
            local ending = partial:find('\n', 1, true)
            if not ending then
              if #partial >= LIMIT then fail('Protocol record exceeds 4 MiB.') end
              return
            end
            if ending > LIMIT then fail('Protocol record exceeds 4 MiB.'); return end
            local line = partial:sub(1, ending - 1)
            partial = partial:sub(ending + 1)
            local ok, record = pcall(vim.json.decode, line)
            if not ok or type(record) ~= 'table' or record.jsonrpc ~= '2.0' then
              fail('Invalid client protocol record.'); return
            end
            if record.id then
              local cb = self.pending[record.id]
              self.pending[record.id] = nil
              if not cb then fail('Unknown response identifier.'); return end
              cb(record.result, record.error and record.error.message, record.error)
            elseif record.method == 'session.state' then
              notification(record.params)
            else
              fail('Unsupported client notification.'); return
            end
          end
        end)
      end,
      on_stderr = function(_, data)
        stderr = (stderr .. table.concat(data, '\n')):sub(-8192)
      end,
      on_exit = function()
        vim.schedule(function()
          if self.job ~= job then return end
          local message = stderr:gsub('harness upgrade', ':Harness upgrade'):gsub('%s+$', '')
          fail(message ~= '' and message or 'Connection closed. Use :Harness to reconnect.')
        end)
      end,
    })
    if job <= 0 then callback(nil, 'Cannot start the harness client.'); return end
    self.job = job
    self.request('system.hello', { api_version = 1 }, function(result, err)
      if err then fail(err); callback(nil, err); return end
      if type(result) ~= 'table' or result.api_version ~= 1 then fail('Incompatible server version.'); callback(nil, 'Incompatible server version.'); return end
      if result.api_revision ~= 3 then
        local message = 'Server uses a different chat interface. Use :Harness upgrade for an older server.'
        fail(message); callback(nil, message); return
      end
      self.connected = true
      changed(nil)
      callback(result)
    end)
  end

  function self.connect(callback)
    if self.connected then callback(true); return end
    if self.starting then
      if #self.waiting >= 32 then callback(nil, 'Too many pending connections.')
      else self.waiting[#self.waiting + 1] = callback end
      return
    end
    self.starting = true
    self.waiting = { callback }
    local function finish(result, err)
      local waiting = self.waiting
      self.starting, self.waiting = false, nil
      for _, ready in ipairs(waiting) do ready(result, err) end
    end
    if not options.autostart then proxy(finish); return end
    vim.system(self.arguments('start'), { text = true, timeout = 11000 }, function(result)
      vim.schedule(function()
        if result.code ~= 0 then finish(nil, (result.stderr or ''):gsub('harness upgrade', ':Harness upgrade'):gsub('%s+$', '')); return end
        proxy(finish)
      end)
    end)
  end

  function self.disconnect()
    fail('Reconnecting.')
  end

  return self
end

return M
