local M = {}

-- Neovim 0.12.6 cancels its original exit command when ExitPre closes the
-- original window. A duplicate of the same buffer keeps its text and flags.
local function cancel_exit()
  local win = vim.api.nvim_get_current_win()
  local sizes, view = vim.fn.winrestcmd(), vim.fn.winsaveview()
  vim.cmd('noautocmd split')
  vim.cmd('noautocmd ' .. vim.fn.win_id2win(win) .. 'close')
  vim.cmd(sizes)
  vim.fn.winrestview(view)
end

function M.install(attached, transport, report)
  local function request(method, params)
    local done, result, failure = false, nil, nil
    transport.request(method, params, function(value, err) result, failure, done = value, err, true end)
    local cancelled = false
    local completed = vim.wait(10000, function()
      local key = vim.fn.getchar(0)
      if key == 27 or key == 3 then cancelled = true end
      return done or cancelled
    end, 10)
    if cancelled then error('Closing cancelled.') end
    if not completed then error('Server response timed out. Closing cancelled.') end
    if failure then error(failure) end
    return result
  end

  local function confirm()
    local approved = {}
    while true do
      local targets = {}
      for id in pairs(attached) do
        local result = request('session.get', { session_id = id })
        local snapshot = result and result.snapshot
        if type(snapshot) ~= 'table' or not vim.tbl_contains({ 'idle', 'running', 'stopping', 'recovering', 'blocked' }, snapshot.state)
          or type(snapshot.session) ~= 'table' or snapshot.session.session_id ~= id
          or (snapshot.active_submission_id ~= vim.NIL and type(snapshot.active_submission_id) ~= 'string') then
          error('Session state is unknown. Closing cancelled.')
        end
        local target = snapshot.active_submission_id
        if target ~= vim.NIL and approved[id] ~= target then
          targets[#targets + 1] = { session_id = id, submission_id = target }
        end
      end
      if #targets == 0 then return true end
      table.sort(targets, function(a, b) return a.session_id < b.session_id end)
      local lines = {}
      for _, target in ipairs(targets) do lines[#lines + 1] = target.session_id .. ': ' .. target.submission_id end
      lines[#lines + 1] = 'Stopping also affects other clients attached to these runs.'
      lines[#lines + 1] = 'Keep the listed agent runs in the background?'
      lines[#lines + 1] = 'Type yes and press Enter to keep them running.'
      lines[#lines + 1] = 'Type no and press Enter to stop them and close.'
      lines[#lines + 1] = 'Press Escape to cancel closing.'
      vim.fn.inputsave()
      local ok, answer = pcall(vim.fn.input, table.concat(lines, '\n') .. '\n')
      vim.fn.inputrestore()
      if not ok or (answer ~= 'yes' and answer ~= 'no') then return false end
      for _, target in ipairs(targets) do
        if answer == 'no' then
          vim.api.nvim_echo({ { 'Stopping ' .. target.session_id .. '. Press Escape to cancel closing.' } }, false, {})
          local outcome = request('run.stop', target)
          if outcome.session_id ~= target.session_id or outcome.submission_id ~= target.submission_id
            or (outcome.status ~= 'done' and outcome.status ~= 'unanswered') then error('Target is not terminal. Closing cancelled.') end
        else
          approved[target.session_id] = target.submission_id
        end
      end
    end
  end

  vim.api.nvim_create_autocmd('ExitPre', {
    group = vim.api.nvim_create_augroup('HarnessExit', { clear = true }),
    callback = function()
      if next(attached) == nil then return end
      local ok, allow = pcall(confirm)
      if not ok or not allow then
        cancel_exit()
        if not ok then report(tostring(allow)) end
      end
    end,
  })
end

return M
