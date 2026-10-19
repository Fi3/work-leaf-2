local M = {}
local options = { executable = 'harness', autostart = true, width = 72, prompt_height = 3 }
local allowed = { executable = true, config_path = true, socket_path = true, workspace = true,
  autostart = true, width = true, prompt_height = true }
local view, transport, selected, source, source_window, sidebar, setup
local sessions, attached, tabs = {}, {}, {}
local connection, watch, watch_sequence = 'disconnected', nil, 0
local attachment = 0
local pending_attachment
local message
local render, send

local function report(message, target)
  local id = target or selected
  if id and sessions[id] then sessions[id].notice = message end
  if sidebar and not selected then sidebar.message(message) end
  if render and view then render() end
  vim.notify('Harness: ' .. message, vim.log.levels.ERROR)
end

render = function()
  local session = selected and sessions[selected]
  local status = connection == 'connected' and selected and not watch and 'connected; loading session' or connection
  view.render(status, session and session.snapshot, session and session.history, session and session.context, session and session.notice or message)
end

local function random_id()
  return (vim.uv.random(16):gsub('.', function(byte) return string.format('%02x', byte:byte()) end))
end

local function save_draft()
  if selected then sessions[selected].draft = view.draft() end
end

local function merge_entries(entries, incoming, before)
  local result = vim.list_extend({}, entries)
  local at = #result + 1
  for index, item in ipairs(result) do if item.entry_id == before then at = index; break end end
  for index = #incoming, 1, -1 do
    local item, found = incoming[index]
    for position, stored in ipairs(result) do
      if stored.entry_id == item.entry_id then found = position; break end
    end
    if found then result[found], at = item, found
    else table.insert(result, at, item) end
  end
  return result
end

local function update(snapshot)
  local id = snapshot.session.session_id
  local session = sessions[id]
  if not session then return end
  local previous = session.snapshot
  local overlap = false
  for _, older in ipairs(previous and previous.entries or {}) do
    for _, newer in ipairs(snapshot.entries) do
      if older.entry_id == newer.entry_id then overlap = true; break end
    end
    if overlap then break end
  end
  session.snapshot = snapshot
  if not session.history_loaded or not overlap then
    session.cursor = snapshot.history_cursor
    session.history_before = snapshot.entries[1] and snapshot.entries[1].entry_id
  end
  if session.history_loaded then session.history = merge_entries(session.history, snapshot.entries) end
  if selected == id then render() end
  if sidebar then sidebar.update(snapshot) end
  if previous and previous.state ~= 'idle' and snapshot.state == 'idle' then vim.cmd('checktime') end
end

local function initialize()
  if view then return end
  view = require('harness.view').new(options)
  transport = require('harness.transport').new(options, function(err)
    connection = err or 'connected'
    if err then watch, watch_sequence = nil, 0 end
    render()
    if sidebar then sidebar.update() end
  end, function(event)
    if event.watch_id ~= watch or event.sequence <= watch_sequence then return end
    watch_sequence = event.sequence
    update(event.snapshot)
  end)
  setup = require('harness.setup').new(transport, report)
  require('harness.exit').install(attached, transport, report)
end

local function rpc(method, params, callback)
  local id = selected
  transport.request(method, params, function(value, err)
    if err then report(err, id); return end
    callback(value)
  end)
end

local function attach(id, callback, focus)
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
    if focus then
      view.focus()
    end
    for _, ready in ipairs(pending.callbacks) do ready() end
  end)
end

local function workspace()
  if options.workspace then
    local path = vim.fn.fnamemodify(options.workspace, ':p')
    return path == '/' and path or path:gsub('/+$', '')
  end
  if source_window and vim.api.nvim_win_is_valid(source_window) and vim.api.nvim_win_get_tabpage(source_window) == vim.api.nvim_get_current_tabpage() then
    local path = vim.api.nvim_win_call(source_window, function() return vim.fn.getcwd() end)
    return vim.uv.fs_realpath(path) or path
  end
  return vim.uv.fs_realpath(vim.fn.getcwd()) or vim.fn.getcwd()
end

local function notice(text)
  if selected then sessions[selected].notice = text else message = text end
  render()
end

local function admit_chat(id)
  local session = sessions[id]
  if session.creating then return end
  session.creating = true
  transport.connect(function(_, failure)
    if failure then session.creating = false; report(failure, id); return end
    transport.request('session.create', session.creation, function(metadata, err)
      session.creating = false
      if err then report(err, id); return end
      session.creation, session.notice, attached[id] = nil, nil, true
      local queued = session.after_send
      session.after_send = nil
      if queued then send(queued, id) end
      if sidebar then sidebar.refresh() end
      if selected ~= id then return end
      attach(id, function()
        local queued = session.after_create
        session.after_create = nil
        if queued then queued() end
      end, vim.api.nvim_get_current_buf() == view.prompt)
    end)
  end)
end

local function create(directory, name, parent)
  save_draft()
  if watch then transport.request('session.unwatch', { watch_id = watch }, function() end) end
  attachment = attachment + 1
  watch, watch_sequence, pending_attachment = nil, 0, nil
  local id = 'chat_' .. random_id()
  selected = id
  sessions[id] = { draft = '', context = {}, history = {}, notice = 'Opening chat...',
    creation = { session_id = id, workspace = directory, name = name and name ~= '' and name or 'New chat', parent_session_id = parent } }
  view.open()
  view.set_draft('')
  render()
  view.focus()
  admit_chat(id)
end

local function authenticate()
  save_draft()
  setup.open(function()
    if selected and sessions[selected].snapshot then attach(selected, function() notice('Key received. Send your task when ready.'); view.focus() end)
    else notice('Key received.'); view.focus() end
    if sidebar then sidebar.refresh() end
  end, 'auth')
end

local function choose(always, directory)
  local items = {}
  local function page(cursor)
    local params = { limit = 100, workspace = directory }
    if cursor then params.cursor = cursor end
    rpc('session.list', params, function(result)
      vim.list_extend(items, result.items)
      if result.next_cursor ~= vim.NIL then page(result.next_cursor); return end
      if #items == 0 then create(directory); return end
      if #items == 1 and not always then attach(items[1].session_id, nil, true); return end
      vim.ui.select(items, { prompt = 'Select a Harness session:', format_item = function(item)
        return (item.name or item.session_id) .. ' (' .. item.session_id .. ')'
      end }, function(item) if item then attach(item.session_id, nil, true) end end)
    end)
  end
  page()
end

local function submit(session)
  local envelope = session.pending
  transport.request('input.submit', envelope, function(receipt, err, rpc_error)
    if session.pending ~= envelope then return end
    if err then
      local kind = rpc_error and rpc_error.data and rpc_error.data.kind
      if rpc_error and (rpc_error.code ~= -32000 or kind == 'busy' or kind == 'resource_limit'
        or kind == 'conflict' or kind == 'provider_error') then session.pending = nil end
      session.notice = err
      report(err, envelope.session_id)
      return
    end
    if receipt.submission_id == nil then report('Missing submission receipt.'); return end
    session.pending, session.notice = nil, nil
    local draft = selected == envelope.session_id and view.draft() or session.draft
    if draft == envelope.text then
      session.draft = ''
      if selected == envelope.session_id then view.set_draft('') end
    end
    for _ = 1, #envelope.context do table.remove(session.context, 1) end
    render()
  end)
end

send = function(captured, target)
  local id = target or selected
  local session = sessions[id]
  if selected == id then view.focus() end
  if session.pending then submit(session); return end
  if session.checking then return end
  local text, context = captured or view.draft(), vim.deepcopy(session.context)
  if text == '' and #context == 0 then return end
  local bytes = #text
  for _, item in ipairs(context) do bytes = bytes + #item.text end
  if bytes > 1024 * 1024 then report('Input and context exceed 1 MiB.', id); return end
  session.checking = true
  transport.request('configuration.get', { session_id = id }, function(value, err)
    session.checking = false
    if err or not value.ready then
      session.notice = err or value.message
      render()
      return
    end
    session.pending = { session_id = id, request_id = random_id(), text = text, context = context }
    submit(session)
  end)
end

local function history()
  local session = sessions[selected]
  if not session.cursor or session.cursor == vim.NIL then
    vim.notify('Harness: No older transcript entries.'); return
  end
  local cursor, before = session.cursor, session.history_before
  session.history_loaded = true
  session.history = merge_entries(session.history, session.snapshot.entries)
  rpc('transcript.list', { session_id = selected, cursor = cursor, limit = 50 }, function(result)
    session.history = merge_entries(session.history, result.items, before)
    if session.cursor == cursor then
      session.cursor = result.next_cursor
      session.history_before = result.items[1] and result.items[1].entry_id or before
    end
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

local function settings(values, target)
  local id = target or selected
  local session = sessions[id]
  values.session_id = id
  rpc('session.configure', values, function()
    session.notice = 'Settings saved.'
    if sidebar then sidebar.refresh() end
    if selected == id then attach(id, function() render(); view.focus() end) end
  end)
end

local function model(argument, provider)
  local id = selected
  if argument ~= '' then
    local selected_provider, selected_model = argument:match('^([^/]+)/(.+)$')
    if argument == 'demo' then selected_provider, selected_model = 'faux', 'test' end
    if not selected_model then notice('Use \\model provider/model, or \\model to choose.'); view.focus(); return end
    settings({ provider = selected_provider, model = selected_model })
    return
  end
  rpc('configuration.get', { session_id = id }, function(value)
    if selected ~= id then return end
    local items = {}
    if provider ~= 'faux' then
      for _, item in ipairs(value.models) do items[#items + 1] = { provider = 'anthropic', model = item.id, label = item.name .. ' · Anthropic' } end
    end
    if provider ~= 'anthropic' then items[#items + 1] = { provider = 'faux', model = 'test', label = 'Local demo · fixed replies, no AI coding' } end
    vim.ui.select(items, { prompt = 'Model for this chat:', format_item = function(item) return item.label end }, function(item)
      if item then settings({ provider = item.provider, model = item.model }, id) else view.focus() end
    end)
  end)
end

local function chat_command(name, argument, captured)
  local session = sessions[selected]
  local id = selected
  if view.draft() == captured then view.set_draft(session.pending and session.pending.text or '') end
  session.notice = nil
  if name == 'help' then notice(require('harness.commands').help()); view.focus()
  elseif name == 'model' then model(argument)
  elseif name == 'provider' then
    if argument == 'anthropic' or argument == 'faux' or argument == 'demo' then model('', argument == 'demo' and 'faux' or argument)
    elseif argument ~= '' then notice('Providers: anthropic, demo.'); view.focus()
    else vim.ui.select({ 'Anthropic', 'Local demo (fixed replies)' }, { prompt = 'Provider:' }, function(_, index)
      if selected ~= id then return end
      if index then model('', index == 1 and 'anthropic' or 'faux') else view.focus() end
    end) end
  elseif name == 'login' or name == 'auth' then
    if argument ~= '' then notice('Use \\login without a key. Enter the key only in the private terminal.'); view.focus()
    else authenticate() end
  elseif name == 'name' then
    if argument == '' then notice('Use \\name followed by a name.'); view.focus() else settings({ name = argument }) end
  elseif name == 'instructions' then settings({ instructions = argument })
  elseif name == 'new' or name == 'child' then create(session.snapshot.session.workspace, argument, name == 'child' and selected or nil)
  elseif name == 'context' then
    local command = { fargs = { 'context', argument == '' and 'buffer' or argument }, range = 0 }
    if argument == 'selection' and source and vim.api.nvim_buf_is_valid(source) then
      command.line1, command.line2 = vim.api.nvim_buf_get_mark(source, '<')[1], vim.api.nvim_buf_get_mark(source, '>')[1]
      command.range = command.line1 > 0 and command.line2 >= command.line1 and 2 or 0
    end
    context(command, source); notice('Source context attached.'); view.focus()
  elseif name == 'stop' or name == 'history' then M.command({ fargs = { name } }); view.focus()
  elseif name == 'status' then
    rpc('configuration.get', { session_id = id }, function(value)
      session.notice = value.message
      if selected == id then render(); view.focus() end
    end)
  else notice('Unknown command. Use \\help or press Tab after \\.'); view.focus() end
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

function M.enable_sidebar()
  vim.keymap.set('n', ';', M.sidebar, { silent = true, desc = 'Toggle agent sidebar' })
end

function M.sidebar()
  initialize()
  local buf = vim.api.nvim_get_current_buf()
  if buf ~= view.prompt and buf ~= view.transcript and buf ~= setup.buffer and (not sidebar or buf ~= sidebar.buffer) then
    source, source_window = buf, vim.api.nvim_get_current_win()
  end
  sidebar = sidebar or require('harness.sidebar').new(transport, {
    select = function(id) M.command({ fargs = { 'attach', id } }) end,
    create = function(directory) create(directory) end,
    report = report,
  })
  if selected then sidebar.update(sessions[selected].snapshot) end
  sidebar.toggle(workspace())
  view.resize()
end

function M.command(command)
  local ok, err = pcall(function()
    if command.fargs[1] == 'sidebar' then M.sidebar(); return end
    initialize()
    local buf = vim.api.nvim_get_current_buf()
    if buf ~= view.prompt and buf ~= view.transcript and buf ~= setup.buffer and (not sidebar or buf ~= sidebar.buffer) then
      source, source_window = buf, vim.api.nvim_get_current_win()
    end
    local context_source = source
    local action = command.fargs[1]
    local origin = selected
    local origin_tab = vim.api.nvim_get_current_tabpage()
    local send_text = action == 'send' and view.draft() or nil
    local send_command = send_text and require('harness.commands').parse(send_text)
    if action == 'setup' or action == 'login' then authenticate(); return end
    if action == 'new' then create(workspace(), command.fargs[2]); return end
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
    local directory = (not selected or action == 'sessions') and workspace() or nil
    view.open()
    render()
    transport.connect(function(_, failure)
      if failure then report(failure); return end
      if action == 'send' and origin and not send_command then
        local session = sessions[origin]
        if send_text == '' and #session.context == 0 and not session.pending then return end
        if session.creation then
          if not session.after_send and not session.after_create then session.after_send = send_text
          else session.notice = 'Chat is opening. The first action is queued. Your later text is kept.'; render() end
          admit_chat(origin)
        elseif selected == origin and not watch then attach(origin, function() send(send_text, origin) end)
        else send(send_text, origin) end
        return
      end
      if origin_tab ~= vim.api.nvim_get_current_tabpage() or selected ~= origin then return end
      local function execute()
        local success, message = pcall(function()
          if action == 'sessions' then choose(true, directory)
          elseif action == 'attach' then attach(command.fargs[2], nil, true)
          elseif not selected then
            if action then error('Open or attach a session first.') end
            choose(false, directory)
          elseif not action then attach(selected)
          elseif action == 'send' then
            local name, argument = require('harness.commands').parse(send_text)
            if name then chat_command(name, argument, send_text) else send(send_text) end
          elseif action == 'history' then history()
          elseif action == 'context' then context(command, context_source)
          elseif action == 'stop' then
            if stop_target == vim.NIL then vim.notify('Harness: No active run.'); return end
            rpc('run.stop', { session_id = stop_session, submission_id = stop_target }, function() end)
          end
        end)
        if not success then report(tostring(message)) end
      end
      if selected and sessions[selected].creation then
        local session = sessions[selected]
        if not session.after_create and not session.after_send then session.after_create = execute
        else session.notice = 'Chat is opening. The first action is queued. Your later text is kept.'; render() end
        admit_chat(selected)
      elseif selected and not watch and action and action ~= 'sessions' and action ~= 'attach' then
        attach(selected, execute)
      else execute() end
    end)
  end)
  if not ok then report(tostring(err)) end
end

vim.api.nvim_create_autocmd('TabLeave', { callback = function()
  if not view then return end
  save_draft()
  tabs[vim.api.nvim_get_current_tabpage()] = { selected = selected, source = source, source_window = source_window }
end })

vim.api.nvim_create_autocmd('TabEnter', { callback = function()
  if not view then return end
  attachment = attachment + 1
  pending_attachment = nil
  if watch then transport.request('session.unwatch', { watch_id = watch }, function() end) end
  watch, watch_sequence = nil, 0
  local tab = tabs[vim.api.nvim_get_current_tabpage()] or {}
  selected, source, source_window = tab.selected, tab.source, tab.source_window
  view.set_draft(selected and sessions[selected].draft or '')
  render()
  if sidebar then sidebar.refresh(workspace()) end
  if not selected then return end
  local id = selected
  if sessions[id].creation then admit_chat(id)
  else transport.connect(function(_, failure)
    if failure then report(failure, id)
    elseif selected == id then attach(id) end
  end) end
end })

vim.api.nvim_create_autocmd('DirChanged', { callback = function()
  if sidebar then sidebar.refresh(workspace()) end
end })

return M
