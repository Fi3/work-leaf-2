local M = {}
local active

local function after_terminal(callback)
  vim.api.nvim_create_autocmd('TermLeave', { once = true, callback = function() vim.schedule(callback) end })
end

local function bounds(provider, method)
  local width, height = math.max(1, math.min(76, vim.o.columns - 4)), math.max(1, math.min(22, vim.o.lines - 4))
  return { relative = 'editor', width = width, height = height,
    row = math.max(0, math.floor((vim.o.lines - height - 2) / 2)), col = math.max(0, math.floor((vim.o.columns - width - 2) / 2)),
    border = 'single', title = ' ' .. provider.name .. ' · ' .. method.name .. ' ', style = 'minimal' }
end

function M.click(index, _, button)
  local actions = active
  if actions and actions.state() ~= 'closed' and button == 'l' and vim.fn.getmousepos().winid == actions.window then
    vim.api.nvim_set_current_win(actions.window)
    actions.click(index)
    if active == actions then actions.resume() end
  end
end

function M.new(transport, report)
  local self = {}
  local input, close_current

  function self.open(provider, method, callback)
    if self.window and vim.api.nvim_win_is_valid(self.window) then
      vim.api.nvim_set_current_win(self.window)
      input()
      return
    end
    if close_current then close_current(false, false) end
    local previous = vim.api.nvim_get_current_win()
    local buffer = vim.api.nvim_create_buf(false, true)
    self.buffer = buffer
    vim.bo[buffer].bufhidden = 'hide'
    local window = vim.api.nvim_open_win(buffer, true, bounds(provider, method))
    self.window = window
    local group = vim.api.nvim_create_augroup('HarnessLogin' .. buffer, { clear = true })
    local job, links
    local state = 'running'
    local function terminal_state()
      if state == 'closed' or not vim.api.nvim_win_is_valid(window) or not vim.api.nvim_buf_is_valid(buffer) then return 'closed' end
      return state
    end
    local function enter()
      vim.schedule(function()
        if terminal_state() == 'running' and vim.api.nvim_get_current_win() == window
          and vim.api.nvim_win_get_buf(window) == buffer then vim.cmd('startinsert') end
      end)
    end
    local actions = { window = window, state = terminal_state, resume = enter }
    active = actions
    local function close(succeeded, focused)
      if state == 'closed' then return end
      state = 'closed'
      if focused == nil then focused = vim.api.nvim_get_current_win() == window end
      local delayed = focused and vim.api.nvim_get_current_win() == window
        and vim.api.nvim_get_current_buf() == buffer and vim.fn.mode() == 't'
      local function complete() if callback then callback(focused, succeeded) end end
      if delayed then after_terminal(complete) end
      vim.api.nvim_del_augroup_by_id(group)
      if active == actions then active = nil end
      if self.window == window then self.window, self.buffer, close_current = nil, nil, nil end
      if vim.api.nvim_win_is_valid(window) then vim.api.nvim_win_close(window, true) end
      if vim.api.nvim_buf_is_valid(buffer) then vim.api.nvim_buf_delete(buffer, { force = true }) end
      links.close()
      if focused and vim.api.nvim_win_is_valid(previous) then vim.api.nvim_set_current_win(previous) end
      if not delayed then complete() end
    end
    close_current = close
    local function cancel()
      if terminal_state() == 'closed' then return end
      if state == 'ended' then close(false)
      elseif job and job > 0 then vim.fn.chansend(job, '\003') end
    end
    input = function()
      if terminal_state() == 'closed' then return end
      vim.api.nvim_win_set_buf(window, buffer)
      links.refresh()
      enter()
    end
    links = require('harness.login_links').new(window, {
      state = terminal_state, click_handler = "v:lua.require'harness.setup'.click",
      input = input, cancel = cancel, resume = actions.resume, after_terminal = after_terminal, report = report,
    })
    actions.click = links.click
    links.bind(buffer)
    vim.api.nvim_create_autocmd('TermRequest', { group = group, buffer = buffer, callback = function(event)
      links.receive(event.data.sequence)
    end })
    vim.api.nvim_create_autocmd('VimResized', { group = group, callback = function()
      if terminal_state() ~= 'closed' then vim.api.nvim_win_set_config(window, bounds(provider, method)); links.refresh() end
    end })
    vim.api.nvim_create_autocmd('WinClosed', { group = group, pattern = tostring(window), callback = function()
      local focused = vim.api.nvim_get_current_win() == window
      vim.schedule(function() close(false, focused and vim.api.nvim_get_current_win() == previous) end)
    end })
    vim.api.nvim_create_autocmd('BufWipeout', { group = group, buffer = buffer, callback = function()
      local focused = vim.api.nvim_get_current_win() == window
      vim.schedule(function() close(false, focused and vim.api.nvim_get_current_win() == window) end)
    end })
    local function complete(code)
      if terminal_state() == 'closed' then return end
      state = 'ended'
      if code == 0 then
        transport.connect(function(_, err)
          if terminal_state() == 'closed' then return end
          if err then report(err) end
          close(not err)
        end)
      elseif code == 130 then close(false)
      else
        if vim.api.nvim_get_current_win() == window then vim.cmd('stopinsert') end
        vim.api.nvim_win_set_buf(window, buffer)
        links.refresh()
        for _, key in ipairs({ '<CR>', 'q' }) do vim.keymap.set('n', key, cancel, { buffer = buffer, silent = true }) end
        report('Login did not finish. See the terminal error.')
      end
    end
    local arguments = transport.arguments('auth')
    vim.list_extend(arguments, { '--provider', provider.id, '--method', method.id })
    job = vim.fn.jobstart(arguments, { term = true, on_exit = function(_, code) vim.schedule(function() complete(code) end) end })
    if job <= 0 then close(false); report('Cannot start login. Check the Harness executable path.'); return end
    vim.api.nvim_buf_set_name(buffer, 'harness://setup')
    links.refresh()
    enter()
  end

  return self
end

return M
