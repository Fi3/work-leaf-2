local M = {}

function M.new(transport, report)
  local self = {}

  function self.open(callback, command)
    command = command or 'auth'
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
      border = 'single', title = ' Anthropic API key ', style = 'minimal',
    })
    local buffer = self.buffer
    local function close()
      if self.buffer ~= buffer then return end
      local focused = vim.api.nvim_get_current_win() == self.window
      if vim.api.nvim_buf_is_valid(buffer) then vim.api.nvim_buf_delete(buffer, { force = true }) end
      self.window, self.buffer = nil, nil
      if focused and vim.api.nvim_win_is_valid(previous) then vim.api.nvim_set_current_win(previous) end
    end
    local job = vim.fn.jobstart(transport.arguments(command), { term = true, on_exit = function(_, code)
      vim.schedule(function()
        if self.buffer ~= buffer or not vim.api.nvim_buf_is_valid(buffer) then return end
        if code == 0 then
          close()
          transport.disconnect()
          transport.connect(function(_, err)
            if err then report(err) elseif callback then callback() end
          end)
        elseif code == 130 then
          close()
        else
          if vim.api.nvim_get_current_win() == self.window then vim.cmd('stopinsert') end
          if self.window and vim.api.nvim_win_is_valid(self.window) then
            vim.wo[self.window].winbar = 'Key entry ended. Enter or q: close'
          end
          for _, key in ipairs({ '<CR>', 'q', '<Esc>' }) do
            vim.keymap.set('n', key, close, { buffer = buffer, silent = true })
          end
          report('Key entry did not finish. See the terminal error.')
        end
      end)
    end })
    if job <= 0 then close(); report('Cannot start key entry. Check the Harness executable path.'); return end
    vim.api.nvim_buf_set_name(buffer, 'harness://setup')
    vim.cmd('startinsert')
  end

  return self
end

return M
