local M = {}

function M.new(transport, select, report)
  local self = { snapshots = {}, items = {}, collapsed = {} }
  local rows, refreshing, refresh_again, selected = {}, false, false, nil

  local function window()
    return self.buffer and vim.fn.win_findbuf(self.buffer)[1]
  end

  local function render()
    if not self.buffer or not vim.api.nvim_buf_is_valid(self.buffer) then return end
    local win = window()
    local cursor = win and vim.api.nvim_win_get_cursor(win)[1] or 1
    local lines = { 'Agents', 'Enter open/fold   n new', 's stop  r refresh states', 'q hide  ; toggle', refreshing and 'Loading...' or '' }
    rows = {}
    local groups = { [self.directory] = {} }
    for _, item in ipairs(self.items) do
      groups[item.workspace] = groups[item.workspace] or {}
      table.insert(groups[item.workspace], item)
    end
    local paths = vim.tbl_keys(groups)
    table.sort(paths)
    for _, path in ipairs(paths) do
      lines[#lines + 1] = (self.collapsed[path] and '+ ' or '- ') .. vim.fn.fnamemodify(path, ':t') .. ' (' .. path .. ')'
      rows[#lines] = { workspace = path }
      if not self.collapsed[path] then
        table.sort(groups[path], function(a, b) return a.session_id < b.session_id end)
        for _, item in ipairs(groups[path]) do
          local snapshot = self.snapshots[item.session_id]
          local state = transport.connected and snapshot and snapshot.state or 'unknown'
          lines[#lines + 1] = (selected == item.session_id and '  * ' or '    ') .. item.session_id .. ' [' .. state .. ']'
          rows[#lines] = item
        end
      end
    end
    vim.bo[self.buffer].modifiable = true
    vim.api.nvim_buf_set_lines(self.buffer, 0, -1, false, lines)
    vim.bo[self.buffer].modifiable = false
    if win then vim.api.nvim_win_set_cursor(win, { math.min(cursor, #lines), 0 }) end
  end

  local function request(method, params, callback)
    transport.request(method, params, function(value, err)
      if err then refreshing, refresh_again = false, false; render(); report(err); return end
      callback(value)
    end)
  end

  function self.refresh()
    if refreshing then refresh_again = true; return end
    refreshing = true; render()
    transport.connect(function(_, err)
      if err then refreshing, refresh_again = false, false; render(); report(err); return end
      local items = {}
      local function states(index)
        if not items[index] then
          refreshing = false; render()
          if refresh_again then refresh_again = false; self.refresh() end
          return
        end
        request('session.get', { session_id = items[index].session_id }, function(value)
          self.snapshots[value.session.session_id] = value.snapshot
          render(); states(index + 1)
        end)
      end
      local function page(cursor)
        request('session.list', { limit = 100, cursor = cursor }, function(value)
          vim.list_extend(items, value.items)
          if value.next_cursor ~= vim.NIL then page(value.next_cursor)
          else self.items = items; states(1) end
        end)
      end
      page()
    end)
  end

  function self.update(snapshot)
    if snapshot then
      selected = snapshot.session.session_id
      self.snapshots[selected] = snapshot
    end
    render()
  end

  function self.hide()
    local win = window()
    if not win then return end
    if #vim.api.nvim_list_wins() == 1 then vim.cmd('enew') else vim.api.nvim_win_close(win, false) end
  end

  function self.toggle(directory)
    if window() then self.hide(); return end
    self.directory = directory
    if not self.buffer or not vim.api.nvim_buf_is_valid(self.buffer) then
      self.buffer = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_name(self.buffer, 'harness://agents')
      vim.bo[self.buffer].buftype, vim.bo[self.buffer].bufhidden = 'nofile', 'hide'
      vim.bo[self.buffer].swapfile, vim.bo[self.buffer].filetype = false, 'harness'
      local function row() return rows[vim.api.nvim_win_get_cursor(0)[1]] end
      local function map(key, action) vim.keymap.set('n', key, action, { buffer = self.buffer, silent = true }) end
      map('q', self.hide)
      map('r', self.refresh)
      map('<CR>', function()
        local item = row(); if not item then return end
        if item.session_id then select(item.session_id)
        else self.collapsed[item.workspace] = not self.collapsed[item.workspace]; render() end
      end)
      map('n', function()
        local directory = row() and row().workspace or self.directory
        vim.ui.input({ prompt = 'New agent name: ' }, function(name)
          if not name or name == '' then return end
          if #name > 128 or not name:match('^[A-Za-z0-9_-]+$') then report('Use 1-128 letters, digits, _ or - for the name.'); return end
          request('session.create', { session_id = name, workspace = directory }, function(value)
            self.collapsed[directory] = false
            self.refresh(); select(value.session_id)
          end)
        end)
      end)
      map('s', function()
        local item = row()
        if not item or not item.session_id then return end
        local snapshot = self.snapshots[item.session_id]
        if not transport.connected or not snapshot then report('Session state is unknown. Press r to reconnect.'); return end
        if snapshot.active_submission_id == vim.NIL then return end
        request('run.stop', { session_id = item.session_id, submission_id = snapshot.active_submission_id }, self.refresh)
      end)
    end
    vim.cmd('topleft 32vsplit')
    vim.api.nvim_win_set_buf(0, self.buffer)
    vim.wo.number, vim.wo.relativenumber, vim.wo.wrap, vim.wo.winfixwidth = false, false, false, true
    render(); self.refresh()
  end

  return self
end

return M
