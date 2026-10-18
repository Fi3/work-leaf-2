local M = {}

function M.new(transport, changed, report)
  local self = {}

  function self.check(callback)
    transport.connect(function(_, failure)
      if failure then changed(nil, failure); callback(nil, failure); return end
      transport.request('configuration.get', vim.empty_dict(), function(value, err)
        changed(value, err)
        callback(value, err)
      end)
    end)
  end

  function self.open(callback)
    if self.window and vim.api.nvim_win_is_valid(self.window) then
      vim.api.nvim_set_current_win(self.window)
      return
    end
    local previous = vim.api.nvim_get_current_win()
    self.buffer = vim.api.nvim_create_buf(false, true)
    vim.bo[self.buffer].bufhidden = 'wipe'
    local width, height = math.min(76, vim.o.columns - 4), math.min(22, vim.o.lines - 4)
    self.window = vim.api.nvim_open_win(self.buffer, true, {
      relative = 'editor', width = math.max(1, width), height = math.max(1, height),
      row = math.max(0, math.floor((vim.o.lines - height) / 2) - 1), col = math.max(0, math.floor((vim.o.columns - width) / 2)),
      border = 'single', title = ' Harness setup ', style = 'minimal',
    })
    local buffer = self.buffer
    local function close()
      if self.buffer ~= buffer then return end
      local focused = vim.api.nvim_get_current_win() == self.window
      if vim.api.nvim_buf_is_valid(buffer) then vim.api.nvim_buf_delete(buffer, { force = true }) end
      self.window, self.buffer = nil, nil
      if focused and vim.api.nvim_win_is_valid(previous) then vim.api.nvim_set_current_win(previous) end
    end
    local job = vim.fn.jobstart(transport.arguments('setup'), { term = true, on_exit = function(_, code)
      vim.schedule(function()
        if self.buffer ~= buffer or not vim.api.nvim_buf_is_valid(buffer) then return end
        if code == 0 then
          close()
          transport.disconnect()
          self.check(function(value, err)
            if err then report(err)
            elseif not value.ready then report(value.message)
            elseif callback then callback() end
          end)
        else
          if vim.api.nvim_get_current_win() == self.window then vim.cmd('stopinsert') end
          if self.window and vim.api.nvim_win_is_valid(self.window) then
            vim.wo[self.window].winbar = 'Setup ended. Enter or q: close'
          end
          for _, key in ipairs({ '<CR>', 'q', '<Esc>' }) do
            vim.keymap.set('n', key, close, { buffer = buffer, silent = true })
          end
          report('Setup did not finish. Press g in the sidebar to try again.')
        end
      end)
    end })
    if job <= 0 then close(); report('Cannot start setup. Check the Harness executable path.'); return end
    vim.api.nvim_buf_set_name(buffer, 'harness://setup')
    vim.cmd('startinsert')
  end

  function self.ensure(callback)
    self.check(function(value, err)
      if self.window and vim.api.nvim_win_is_valid(self.window) then
        vim.api.nvim_set_current_win(self.window)
        return
      end
      if err then report(err); self.open(callback)
      elseif value.ready then callback()
      else self.open(callback) end
    end)
  end

  return self
end

return M
