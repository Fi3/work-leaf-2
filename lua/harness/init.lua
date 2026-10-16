local M = {}
local options = { executable = 'harness', autostart = true, width = 72, prompt_height = 6 }
local allowed = { executable = true, config_path = true, socket_path = true, workspace = true,
  autostart = true, width = true, prompt_height = true }
local view, transport, selected, source, source_window
local sessions, attached = {}, {}
local connection, watch, watch_sequence = 'disconnected', nil, 0
local attachment = 0
local pending_attachment

local function report(message)
  vim.notify('Harness: ' .. message, vim.log.levels.ERROR)
end

local function render()
  local session = selected and sessions[selected]
  local status = connection == 'connected' and selected and not watch and 'connected; loading session' or connection
  view.render(status, session and session.snapshot, session and session.history, session and session.context)
end

local function random_id()
  return (vim.uv.random(16):gsub('.', function(byte) return string.format('%02x', byte:byte()) end))
end

local function save_draft()
  if selected then sessions[selected].draft = view.draft() end
end

local function update(snapshot)
  local id = snapshot.session.session_id
  local session = sessions[id]
  if not session then return end
  local previous = session.snapshot
  session.snapshot = snapshot
  if not session.history_loaded then session.cursor = snapshot.history_cursor end
  if selected == id then render() end
  if previous and previous.state ~= 'idle' and snapshot.state == 'idle' then vim.cmd('checktime') end
end

local function initialize()
  if view then return end
  view = require('harness.view').new(options)
  transport = require('harness.transport').new(options, function(err)
    connection = err or 'connected'
    if err then watch, watch_sequence = nil, 0 end
    render()
  end, function(event)
    if event.watch_id ~= watch or event.sequence <= watch_sequence then return end
    watch_sequence = event.sequence
    update(event.snapshot)
  end)
  require('harness.exit').install(attached, transport, report)
end

local function rpc(method, params, callback)
  transport.request(method, params, function(value, err)
    if err then report(err); return end
    callback(value)
  end)
end

local function attach(id, callback)
  if pending_attachment and pending_attachment.id == id then
    if callback then
      if #pending_attachment.callbacks >= 32 then report('Too many pending commands.'); return end
      pending_attachment.callbacks[#pending_attachment.callbacks + 1] = callback
    end
    return
  end
  save_draft()
  attachment = attachment + 1
  local attempt = attachment
  local pending = { id = id, callbacks = callback and { callback } or {} }
  pending_attachment = pending
  if watch then transport.request('session.unwatch', { watch_id = watch }, function() end) end
  watch, watch_sequence = nil, 0
  transport.request('session.watch', { session_id = id }, function(value, err)
    if err then
      if attempt == attachment then pending_attachment = nil end
      report(err)
      return
    end
    if attempt ~= attachment then
      transport.request('session.unwatch', { watch_id = value.watch_id }, function() end)
      return
    end
    pending_attachment = nil
    save_draft()
    local switching = selected ~= id
    sessions[id] = sessions[id] or { draft = '', context = {}, history = {} }
    selected, attached[id] = id, true
    watch, watch_sequence = value.watch_id, 0
    update(value.snapshot)
    if switching then view.set_draft(sessions[id].draft) end
    render()
    for _, ready in ipairs(pending.callbacks) do ready() end
  end)
end

local function workspace()
  if options.workspace then
    local path = vim.fn.fnamemodify(options.workspace, ':p')
    return path == '/' and path or path:gsub('/+$', '')
  end
  if source_window and vim.api.nvim_win_is_valid(source_window) then
    return vim.api.nvim_win_call(source_window, function() return vim.fn.getcwd() end)
  end
  return vim.fn.getcwd()
end

local function create(directory)
  rpc('session.create', { session_id = 'session_' .. random_id(), workspace = directory }, function(session)
    attach(session.session_id)
  end)
end

local function choose(always, directory)
  local items = {}
  local function page(cursor)
    local params = { limit = 100 }
    if cursor then params.cursor = cursor end
    rpc('session.list', params, function(result)
      vim.list_extend(items, result.items)
      if result.next_cursor ~= vim.NIL then page(result.next_cursor); return end
      if #items == 0 then create(directory); return end
      if #items == 1 and not always then attach(items[1].session_id); return end
      vim.ui.select(items, { prompt = 'Select a Harness session:', format_item = function(item)
        return item.session_id .. ' (' .. item.workspace .. ')'
      end }, function(item) if item then attach(item.session_id) end end)
    end)
  end
  page()
end

local function send()
  local session = sessions[selected]
  local current = view.draft()
  if not session.pending then
    if current == '' and #session.context == 0 then error('The prompt is empty.') end
    local bytes = #current
    for _, item in ipairs(session.context) do bytes = bytes + #item.text end
    if bytes > 1024 * 1024 then error('Input and context exceed 1 MiB.') end
    session.pending = { session_id = selected, request_id = random_id(), text = current, context = vim.deepcopy(session.context) }
  end
  local envelope = session.pending
  transport.request('input.submit', envelope, function(receipt, err, rpc_error)
    if session.pending ~= envelope then return end
    if err then
      local kind = rpc_error and rpc_error.data and rpc_error.data.kind
      if rpc_error and (rpc_error.code ~= -32000 or kind == 'busy' or kind == 'resource_limit'
        or kind == 'conflict' or kind == 'provider_error') then session.pending = nil end
      report(err)
      return
    end
    if receipt.submission_id == nil then report('Missing submission receipt.'); return end
    session.pending = nil
    if selected == envelope.session_id and view.draft() == envelope.text then
      view.set_draft('')
      session.draft = ''
    end
    for _ = 1, #envelope.context do table.remove(session.context, 1) end
    render()
  end)
end

local function history()
  local session = sessions[selected]
  if not session.cursor or session.cursor == vim.NIL then
    vim.notify('Harness: No older transcript entries.'); return
  end
  rpc('transcript.list', { session_id = selected, cursor = session.cursor, limit = 50 }, function(result)
    local items = result.items
    vim.list_extend(items, session.history)
    session.history, session.cursor, session.history_loaded = items, result.next_cursor, true
    render()
  end)
end

local function context(command, buffer)
  if command.fargs[2] ~= 'buffer' and command.fargs[2] ~= 'selection' then error('Use :Harness context buffer or selection.') end
  if not buffer then error('Select a source file buffer first.') end
  local session = sessions[selected]
  if #session.context >= 16 then error('At most 16 context attachments are permitted.') end
  local first, last
  if command.fargs[2] == 'selection' then
    if command.range == 0 then error('Supply a line range for selection context.') end
    first, last = command.line1, command.line2
  end
  session.context[#session.context + 1] = require('harness.context').capture(buffer, session.snapshot.session.workspace, first, last)
  render()
end

function M.setup(settings)
  if view then error('Set Harness options before the first command.') end
  for key, value in pairs(settings or {}) do
    if not allowed[key] then error('Unknown Harness option: ' .. key) end
    if key == 'autostart' then
      if type(value) ~= 'boolean' then error('autostart must be boolean.') end
    elseif key == 'width' or key == 'prompt_height' then
      if type(value) ~= 'number' or value < 1 or value % 1 ~= 0 then error(key .. ' must be a positive integer.') end
    elseif type(value) ~= 'string' or value == '' then error(key .. ' must be a nonempty string.') end
    options[key] = value
  end
end

function M.command(command)
  local ok, err = pcall(function()
    initialize()
    local buf = vim.api.nvim_get_current_buf()
    if buf ~= view.prompt and buf ~= view.transcript then
      source, source_window = buf, vim.api.nvim_get_current_win()
    end
    local context_source = source
    local action = command.fargs[1]
    if action == 'status' then
      local state = selected and watch and connection == 'connected' and sessions[selected].snapshot.state or 'unknown'
      vim.notify('Harness: ' .. connection .. (selected and '; session ' .. selected .. '; state ' .. state or '')); return
    end
    if action and not vim.tbl_contains({ 'new', 'sessions', 'attach', 'send', 'stop', 'history', 'context' }, action) then error('Unknown Harness command.') end
    if action == 'attach' and not command.fargs[2] then error('Supply a session identifier.') end
    local stop_session, stop_target
    if action == 'stop' then
      if connection ~= 'connected' or not watch then error('Session state is unknown. Use :Harness to reconnect.') end
      stop_session, stop_target = selected, sessions[selected].snapshot.active_submission_id
    end
    local directory = (not selected or action == 'new' or action == 'sessions') and workspace() or nil
    view.open()
    render()
    transport.connect(function(_, failure)
      if failure then report(failure); return end
      local function execute()
        local success, message = pcall(function()
          if action == 'new' then create(directory)
          elseif action == 'sessions' then choose(true, directory)
          elseif action == 'attach' then attach(command.fargs[2])
          elseif not selected then
            if action then error('Open or attach a session first.') end
            choose(false, directory)
          elseif not action then attach(selected)
          elseif action == 'send' then send()
          elseif action == 'history' then history()
          elseif action == 'context' then context(command, context_source)
          elseif action == 'stop' then
            if stop_target == vim.NIL then vim.notify('Harness: No active run.'); return end
            rpc('run.stop', { session_id = stop_session, submission_id = stop_target }, function() end)
          end
        end)
        if not success then report(tostring(message)) end
      end
      if selected and not watch and action and action ~= 'new' and action ~= 'sessions' and action ~= 'attach' then
        attach(selected, execute)
      else execute() end
    end)
  end)
  if not ok then report(tostring(err)) end
end

return M
