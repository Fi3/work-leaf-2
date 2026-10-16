local M = {}

function M.new(options)
  local self = {}
  local namespace = vim.api.nvim_create_namespace('HarnessView')
  local function buffer(kind, editable)
    local buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(buf, 'harness://' .. kind)
    vim.bo[buf].buftype, vim.bo[buf].bufhidden = 'nofile', 'hide'
    vim.bo[buf].swapfile, vim.bo[buf].modifiable = false, editable
    vim.bo[buf].filetype = 'harness'
    return buf
  end

  function self.open()
    if not self.transcript or not vim.api.nvim_buf_is_valid(self.transcript) then
      self.transcript, self.prompt = buffer('transcript', false), buffer('prompt', true)
    end
    if #vim.fn.win_findbuf(self.transcript) == 0 then
      vim.cmd('botright ' .. options.width .. 'vsplit')
      vim.api.nvim_win_set_buf(0, self.transcript)
    end
    if #vim.fn.win_findbuf(self.prompt) == 0 then
      vim.api.nvim_set_current_win(vim.fn.win_findbuf(self.transcript)[1])
      vim.cmd('belowright ' .. options.prompt_height .. 'split')
      vim.api.nvim_win_set_buf(0, self.prompt)
    end
    vim.api.nvim_set_current_win(vim.fn.win_findbuf(self.prompt)[1])
  end

  function self.draft()
    if not self.prompt or not vim.api.nvim_buf_is_valid(self.prompt) then return '' end
    return table.concat(vim.api.nvim_buf_get_lines(self.prompt, 0, -1, false), '\n')
  end

  function self.set_draft(text)
    if self.prompt and vim.api.nvim_buf_is_valid(self.prompt) then
      vim.api.nvim_buf_set_lines(self.prompt, 0, -1, false, vim.split(text, '\n', { plain = true }))
      vim.bo[self.prompt].modified = false
    end
  end

  function self.render(connection, snapshot, history, attachments)
    if not self.transcript or not vim.api.nvim_buf_is_valid(self.transcript) then return end
    local lines = { 'Connection: ' .. connection }
    local function text(value)
      vim.list_extend(lines, vim.split(value or '', '\n', { plain = true }))
    end
    local function entry(item)
      lines[#lines + 1] = ''
      lines[#lines + 1] = '[' .. item.kind .. '] ' .. item.entry_id
      text(item.text)
      if item.truncated then lines[#lines + 1] = '[Text truncated. Use the command client to read the complete entry.]' end
    end
    if snapshot then
      lines[#lines + 1] = 'Session: ' .. snapshot.session.session_id
      lines[#lines + 1] = 'State: ' .. (connection == 'connected' and snapshot.state or 'unknown')
      if snapshot.active_submission_id ~= vim.NIL then lines[#lines + 1] = 'Submission: ' .. snapshot.active_submission_id end
      if snapshot.error ~= vim.NIL then text(snapshot.error.message) end
      local seen = {}
      for _, item in ipairs(snapshot.entries) do seen[item.entry_id] = true end
      for _, item in ipairs(history or {}) do if not seen[item.entry_id] then entry(item) end end
      for _, item in ipairs(snapshot.entries) do entry(item) end
      if snapshot.state ~= 'idle' and snapshot.assistant.text ~= '' then
        lines[#lines + 1] = ''
        lines[#lines + 1] = '[assistant progress]'
        text(snapshot.assistant.text)
        if snapshot.assistant.truncated then lines[#lines + 1] = '[Text truncated.]' end
      end
      for _, tool in ipairs(snapshot.tools) do
        lines[#lines + 1] = '[' .. tool.name .. ': ' .. tool.status .. ']'
        text(tool.text)
        if tool.truncated then lines[#lines + 1] = '[Tool output truncated.]' end
      end
      if snapshot.activity ~= vim.NIL then lines[#lines + 1] = 'Activity: ' .. vim.json.encode(snapshot.activity) end
      if snapshot.usage ~= vim.NIL then lines[#lines + 1] = 'Usage: ' .. vim.json.encode(snapshot.usage) end
      if snapshot.truncated or snapshot.history_cursor ~= vim.NIL then lines[#lines + 1] = '[Older text available: :Harness history]' end
    end
    if attachments and #attachments > 0 then
      lines[#lines + 1] = ''
      for _, item in ipairs(attachments) do
        local selection = item.kind == 'selection' and '; complete lines ' .. item.start_line .. '-' .. item.end_line or ''
        lines[#lines + 1] = 'Context snapshot: ' .. item.path .. ' (' .. item.kind .. selection .. ')'
      end
    end
    local positions, old_count = {}, vim.api.nvim_buf_line_count(self.transcript)
    for _, win in ipairs(vim.fn.win_findbuf(self.transcript)) do
      positions[win] = {
        at_end = vim.api.nvim_win_call(win, function() return vim.fn.line('w$') >= old_count end),
        view = vim.api.nvim_win_call(win, vim.fn.winsaveview),
      }
    end
    vim.bo[self.transcript].modifiable = true
    vim.api.nvim_buf_set_lines(self.transcript, 0, -1, false, lines)
    vim.bo[self.transcript].modifiable, vim.bo[self.transcript].modified = false, false
    vim.api.nvim_buf_clear_namespace(self.transcript, namespace, 0, -1)
    local groups = { connection == 'connected' and 'DiagnosticOk' or 'DiagnosticWarn', 'Title', 'Comment' }
    for row = 1, math.min(#lines, snapshot and 3 or 1) do
      vim.api.nvim_buf_set_extmark(self.transcript, namespace, row - 1, 0, { end_row = row, hl_group = groups[row], hl_eol = true })
    end
    for win, position in pairs(positions) do
      if position.at_end then
        vim.api.nvim_win_set_cursor(win, { #lines, 0 })
      else
        vim.api.nvim_win_call(win, function() vim.fn.winrestview(position.view) end)
      end
    end
  end

  return self
end

return M
