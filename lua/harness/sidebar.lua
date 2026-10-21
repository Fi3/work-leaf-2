local M = {}

function M.new(transport, actions)
  local self = { snapshots = {}, items = {}, collapsed = {} }
  local rows, refreshing, refresh_again, selected, failure = {}, false, false, nil, nil

  local function window()
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
      if vim.api.nvim_win_get_buf(win) == self.buffer then return win end
    end
  end
  local function width()
    return math.min(32, math.max(20, math.floor(vim.o.columns / 3)))
  end
  local resizing = false
  vim.api.nvim_create_autocmd({ 'WinClosed', 'WinResized', 'VimResized' }, { callback = function()
    if resizing then return end
    resizing = true
    vim.schedule(function()
      resizing = false
      local win = window()
      if not win or vim.api.nvim_win_get_width(win) == width() then return end
      -- Closing an adjacent fixed window can give all of its space to this tree.
      vim.api.nvim_win_set_width(win, width())
      if vim.o.equalalways and vim.o.eadirection ~= 'ver' then vim.cmd('horizontal wincmd =') end
    end)
  end })

  local function name(item)
    return type(item.name) == 'string' and item.name or 'New chat'
  end

  local function remember(snapshot)
    self.snapshots[snapshot.session.session_id] = { state = snapshot.state, active_submission_id = snapshot.active_submission_id }
  end

  local function render()
    if not self.buffer or not vim.api.nvim_buf_is_valid(self.buffer) then return end
    local win = window()
    if win and self.directory then
      vim.wo[win].winbar = '%#Title# ' .. vim.fn.fnamemodify(self.directory, ':t'):gsub('%%', '%%%%') .. ' · Agents%*'
    end
    local cursor = win and vim.api.nvim_win_get_cursor(win)[1] or 1
    local current = rows[cursor]
    local lines, items, lookup, names, suffixes, children, seen = { '+ New chat' }, {}, {}, {}, {}, {}, {}
    rows = { { new = true, workspace = self.directory } }
    if failure then lines[#lines + 1] = failure
    elseif refreshing then lines[#lines + 1] = 'Loading...' end
    for _, item in ipairs(self.items) do
      if item.workspace == self.directory then
        items[#items + 1], lookup[item.session_id] = item, item
        names[name(item)] = (names[name(item)] or 0) + 1
        local key = name(item) .. '\0' .. item.session_id:sub(-8)
        suffixes[key] = (suffixes[key] or 0) + 1
      end
    end
    table.sort(items, function(a, b)
      if name(a) == name(b) then return a.session_id < b.session_id end
      return name(a) < name(b)
    end)
    local roots = {}
    for _, item in ipairs(items) do
      local parent = type(item.parent_session_id) == 'string' and lookup[item.parent_session_id]
      local list = roots
      if parent and parent ~= item then
        children[parent.session_id] = children[parent.session_id] or {}
        list = children[parent.session_id]
      end
      list[#list + 1] = item
    end
    local function branch(item, depth, hidden)
      local id = item.session_id
      if seen[id] then return end
      seen[id] = true
      if not hidden then
        local snapshot = self.snapshots[id]
        local state = transport.connected and snapshot and snapshot.state or 'unknown'
        local suffix = id:sub(-8)
        if suffixes[name(item) .. '\0' .. suffix] > 1 then suffix = id end
        local label = name(item) .. (names[name(item)] > 1 and ' (' .. suffix .. ')' or '')
        local marker = children[id] and (self.collapsed[id] and '+ ' or '- ') or '  '
        lines[#lines + 1] = string.rep('  ', depth) .. (selected == id and '*' or ' ') .. marker .. label .. ' [' .. state .. ']'
        rows[#lines] = item
      end
      for _, child in ipairs(children[id] or {}) do branch(child, depth + 1, hidden or self.collapsed[id]) end
    end
    for _, item in ipairs(roots) do branch(item, 0) end
    -- Malformed legacy ancestry must not hide a chat or cause recursion forever.
    for _, item in ipairs(items) do branch(item, 0) end
    vim.bo[self.buffer].modifiable = true
    vim.api.nvim_buf_set_lines(self.buffer, 0, -1, false, lines)
    vim.bo[self.buffer].modifiable = false
    if win then
      if current and current.session_id then
        for index, item in pairs(rows) do
          if item.session_id == current.session_id then cursor = index; break end
        end
      end
      vim.api.nvim_win_set_cursor(win, { math.min(cursor, #lines), 0 })
    end
  end

  function self.refresh(directory)
    if directory then
      self.directory = vim.uv.fs_realpath(directory) or directory
      render()
    end
    if refreshing then refresh_again = true; return end
    local directory = self.directory
    refreshing, failure = true, nil
    render()
    local function fail(err)
      refreshing = false
      if refresh_again then refresh_again = false; self.refresh(); return end
      failure = err
      render(); actions.report(err)
    end
    local function request(method, params, callback)
      transport.request(method, params, function(value, err)
        if err then fail(err) else callback(value) end
      end)
    end
    transport.connect(function(_, err)
      if err then fail(err); return end
      local items = {}
      local function states(index)
        if not items[index] then
          refreshing = false; render()
          if refresh_again then refresh_again = false; self.refresh() end
          return
        end
        request('session.get', { session_id = items[index].session_id }, function(value)
          remember(value.snapshot)
          render(); states(index + 1)
        end)
      end
      local function page(cursor)
        request('session.list', { workspace = directory, limit = 100, cursor = cursor }, function(value)
          for _, item in ipairs(value.items) do if item.workspace == directory then items[#items + 1] = item end end
          if value.next_cursor ~= vim.NIL then page(value.next_cursor)
          else
            if self.directory == directory then self.items = items end
            states(1)
          end
        end)
      end
      page()
    end)
  end

  function self.message(message) failure = message; render() end

  function self.update(snapshot)
    if snapshot then
      selected = snapshot.session.session_id
      local previous = self.snapshots[selected]
      remember(snapshot)
      if window() and snapshot.session.workspace == self.directory and previous
        and previous.active_submission_id and previous.active_submission_id ~= vim.NIL
        and snapshot.active_submission_id == vim.NIL then self.refresh() end
    end
    render()
  end

  function self.hide()
    local win = window()
    if not win then return end
    if #vim.api.nvim_tabpage_list_wins(0) == 1 then vim.cmd('enew') else vim.api.nvim_win_close(win, false) end
  end

  function self.toggle(directory)
    if window() then self.hide(); return end
    self.directory = vim.uv.fs_realpath(directory) or directory
    if not self.buffer or not vim.api.nvim_buf_is_valid(self.buffer) then
      self.buffer = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_name(self.buffer, 'harness://agents')
      vim.bo[self.buffer].buftype, vim.bo[self.buffer].bufhidden = 'nofile', 'hide'
      vim.bo[self.buffer].swapfile, vim.bo[self.buffer].filetype = false, 'harness'
      vim.bo[self.buffer].undolevels = -1
      vim.api.nvim_create_autocmd('BufEnter', { buffer = self.buffer, callback = function() self.refresh() end })
      local function row() return rows[vim.api.nvim_win_get_cursor(0)[1]] end
      local function map(key, action) vim.keymap.set('n', key, action, { buffer = self.buffer, silent = true }) end
      map('q', self.hide)
      map('r', self.refresh)
      map('n', function() actions.create(self.directory) end)
      map('<CR>', function()
        local item = row(); if not item then return end
        if item.new then actions.create(self.directory) else actions.select(item.session_id) end
      end)
      for key, collapsed in pairs({ h = true, l = false }) do
        map(key, function()
          local item = row(); if not item or not item.session_id then return end
          self.collapsed[item.session_id] = collapsed; render()
        end)
      end
      map('s', function()
        local item = row()
        if not item or not item.session_id then return end
        local snapshot = self.snapshots[item.session_id]
        if not transport.connected or not snapshot then actions.report('Session state is unknown. Press r to reconnect.'); return end
        if snapshot.active_submission_id == vim.NIL then return end
        transport.request('run.stop', { session_id = item.session_id, submission_id = snapshot.active_submission_id }, function(_, err)
          if err then actions.report(err) else self.refresh() end
        end)
      end)
    end
    vim.cmd('topleft ' .. width() .. 'vsplit')
    vim.api.nvim_win_set_buf(0, self.buffer)
    vim.wo.number, vim.wo.relativenumber, vim.wo.wrap, vim.wo.winfixwidth = false, false, false, true
    vim.wo.statusline = 'Enter open · n new · s stop'
    render()
  end

  return self
end

return M
