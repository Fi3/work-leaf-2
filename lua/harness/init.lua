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
local render, send, activate, model, actions

local function report(message, id)
  if id and sessions[id] then sessions[id].notice = message end
  if sidebar and not selected then sidebar.message(message) end
  if render and view then render() end
  vim.notify('Harness: ' .. message, vim.log.levels.ERROR)
end

local function report_current(message)
  report(message, selected)
end

render = function()
  local session = selected and sessions[selected]
  local status = connection == 'connected' and selected and not watch and 'connected; loading session' or connection
  view.render(status, session and session.snapshot, session and session.history, session and session.context, session and session.notice or message)
end

local function random_id()
  return (vim.uv.random(16):gsub('.', function(byte) return string.format('%02x', byte:byte()) end))
end

local function merge_entries(entries, incoming, before)
  local result = vim.list_extend({}, entries)
  result.limited = entries.limited
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

local function limit_history(entries, anchor)
  local bytes, last, at = 0, 0, 1
  for index, item in ipairs(entries) do
    if item.entry_id == anchor then at = index end
    local size = #item.text + #item.entry_id + #item.kind
    if index == last + 1 and index <= 200 and bytes + size <= 1024 * 1024 then
      bytes, last = bytes + size, index
    end
  end
  if last == #entries then return entries end
  if at > last then
    bytes, last = 0, at - 1
    for index = at, math.min(#entries, at + 199) do
      local item = entries[index]
      local size = #item.text + #item.entry_id + #item.kind
      if bytes + size > 1024 * 1024 then break end
      bytes, last = bytes + size, index
    end
  else at = 1 end
  local result = vim.list_slice(entries, at, last)
  result.limited = true
  return result
end

local function release_history(id)
  local session = sessions[id]
  if not session then return end
  session.history, session.history_loaded = {}, false
  session.history_request = nil
  local snapshot = session.snapshot
  session.cursor = snapshot and snapshot.history_cursor
  session.history_before = snapshot and snapshot.entries[1] and snapshot.entries[1].entry_id
  if selected ~= id then session.snapshot = nil end
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
  if session.history_loaded then session.history = limit_history(merge_entries(session.history, snapshot.entries)) end
  if selected == id then render() end
  if sidebar then sidebar.update(snapshot) end
  if previous and previous.state ~= 'idle' and snapshot.state == 'idle' then vim.cmd('checktime') end
end

local function initialize()
  if view then return end
  view = require('harness.view').new(options, {
    activate = function(...) if activate then activate(...) end end,
    release = release_history,
  })
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
  setup = require('harness.setup').new(transport, report_current)
  require('harness.exit').install(attached, transport, report_current)
end

local function rpc(id, method, params, callback)
  transport.request(method, params, function(value, err)
    if err then report(err, id); return end
    callback(value)
  end)
end

local function clear_watch()
  if watch then transport.request('session.unwatch', { watch_id = watch }, function() end) end
  watch, watch_sequence = nil, 0
end

local function select_session(id)
  local previous = selected
  if selected ~= id then
    attachment = attachment + 1
    pending_attachment = nil
    clear_watch()
  end
  selected = id
  if previous and previous ~= id and not view.visible(previous) then release_history(previous) end
  if id then sessions[id] = sessions[id] or { context = {}, history = {} } end
  view.select(id)
end

local function attach(id, callback, focus)
  select_session(id)
  if focus then view.open(id, source_window) end
  if pending_attachment and pending_attachment.id == id then
    if callback then
      if #pending_attachment.callbacks >= 32 then report('Too many pending commands.', id); return end
      pending_attachment.callbacks[#pending_attachment.callbacks + 1] = callback
    end
    return
  end
  attachment = attachment + 1
  local attempt = attachment
  local pending = { id = id, callbacks = callback and { callback } or {} }
  pending_attachment = pending
  clear_watch()
  render()
  transport.request('session.watch', { session_id = id }, function(value, err)
    if err then
      if attempt == attachment then pending_attachment = nil end
      report(err, id)
      return
    end
    if attempt ~= attachment then
      transport.request('session.unwatch', { watch_id = value.watch_id }, function() end)
      return
    end
    pending_attachment = nil
    attached[id] = true
    watch, watch_sequence = value.watch_id, 0
    update(value.snapshot)
    if focus then
      view.focus()
    end
    local queued = sessions[id].after_create
    sessions[id].after_create = nil
    if queued then queued() end
    for _, ready in ipairs(pending.callbacks) do
      if attempt ~= attachment then break end
      ready()
    end
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

local function notice(text, id)
  if id then sessions[id].notice = text else message = text end
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
      attach(id, nil, vim.api.nvim_get_current_buf() == view.prompt)
    end)
  end)
end

local function create(directory, name, parent)
  local id = 'chat_' .. random_id()
  sessions[id] = { context = {}, history = {}, notice = 'Opening chat...',
    creation = { session_id = id, workspace = directory, name = name and name ~= '' and name or 'New chat', parent_session_id = parent } }
  select_session(id)
  view.open(id, source_window)
  view.set_draft('')
  render()
  view.focus()
  admit_chat(id)
end

local function provider_label(item)
  local methods = {}
  for _, method in ipairs(item.methods) do methods[#methods + 1] = method.name end
  local status = item.authenticated and (item.credential_type == 'oauth' and 'account login'
    or item.credential_type == 'api_key' and 'API key' or 'connected') or 'login needed'
  return item.name .. (#methods > 0 and ' · ' .. table.concat(methods, ' / ') or '')
    .. ' [' .. status .. ']'
end

local function at_origin(request)
  return selected == request.session and vim.api.nvim_get_current_tabpage() == request.tab
    and vim.api.nvim_get_current_win() == request.window and vim.api.nvim_get_current_buf() == request.buffer
end

local function resume_prompt(request)
  if at_origin(request) and request.buffer == view.prompt then view.focus() end
end

local function authenticate(request, argument)
  local id = request.session
  local function current()
    return at_origin(request)
  end
  transport.connect(function(_, failure)
    if failure then report(failure, id); return end
    rpc(id, 'configuration.get', { session_id = id }, function(value)
      if not current() then return end
      local items, chosen, current_index = {}, nil, nil
      for _, provider in ipairs(value.providers) do
        if #provider.methods > 0 then
          items[#items + 1] = provider
          if provider.id == value.provider then current_index = #items end
          if provider.id == argument then chosen = provider end
        end
      end
      local function login(provider)
        if not current() then return end
        if not provider then resume_prompt(request); return end
        local function method(method)
          if not current() then return end
          if not method then resume_prompt(request); return end
          setup.open(provider, method, function(focused, succeeded)
            if not succeeded then
              if focused then resume_prompt(request) end
              return
            end
            rpc(id, 'configuration.get', { session_id = id }, function(status)
              if id and sessions[id] then
                sessions[id].notice = status.message
                if selected == id then
                  render()
                  if focused and current() then
                    if type(status.model) ~= 'string' then model(request, '', provider.id) else resume_prompt(request) end
                  end
                end
              else vim.notify('Harness: ' .. provider.name .. ' connected. Open a chat and use \\model.') end
              if sidebar then sidebar.refresh() end
            end)
          end)
        end
        if #provider.methods == 1 then method(provider.methods[1])
        else require('harness.select').select(provider.methods, { prompt = 'Connect ' .. provider.name,
          format_item = function(item) return item.name end }, method) end
      end
      if argument and argument ~= '' then
        if chosen then login(chosen)
        else notice('Choose a provider with \\login. Do not put a key in the command.', id); view.focus() end
      else require('harness.select').select(items, { prompt = 'Connect an account or API key', selected = current_index,
        format_item = provider_label }, login) end
    end)
  end)
end

local function choose(request, always)
  local directory = request.directory
  local items = {}
  local function page(cursor)
    local params = { limit = 100, workspace = directory }
    if cursor then params.cursor = cursor end
    rpc(request.session, 'session.list', params, function(result)
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
    if receipt.submission_id == nil then report('Missing submission receipt.', envelope.session_id); return end
    session.pending, session.notice = nil, nil
    if view.draft(envelope.session_id) == envelope.text then view.set_draft('', envelope.session_id) end
    for _ = 1, #envelope.context do table.remove(session.context, 1) end
    render()
  end)
end

send = function(text, id)
  local session = sessions[id]
  if selected == id then view.focus() end
  if session.pending then submit(session); return end
  if session.checking then return end
  local context = vim.deepcopy(session.context)
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

local function history(id)
  local session = sessions[id]
  if session.history_request then return end
  if not session.cursor or session.cursor == vim.NIL then
    vim.notify('Harness: No older transcript entries.'); return
  end
  local cursor, before = session.cursor, session.history_before
  local request = {}
  session.history_request = request
  session.history_loaded = true
  session.history = limit_history(merge_entries(session.history, session.snapshot.entries))
  transport.request('transcript.list', { session_id = id, cursor = cursor, limit = 50 }, function(result, err)
    if session.history_request ~= request then return end
    session.history_request = nil
    if err then report(err, id); return end
    if not view.visible(id) then release_history(id); return end
    session.history = limit_history(merge_entries(session.history, result.items, before), result.items[1] and result.items[1].entry_id)
    if session.cursor == cursor then
      session.cursor = result.next_cursor
      session.history_before = result.items[1] and result.items[1].entry_id or before
    end
    if selected == id then render() end
  end)
end

local function context(id, command, buffer)
  if command.fargs[2] ~= 'buffer' and command.fargs[2] ~= 'selection' then error('Use :Harness context buffer or selection.') end
  if not buffer then error('Select a source file buffer first.') end
  local session = sessions[id]
  if #session.context >= 16 then error('At most 16 context attachments are permitted.') end
  local first, last
  if command.fargs[2] == 'selection' then
    if command.range == 0 then error('Supply a line range for selection context.') end
    first, last = command.line1, command.line2
  end
  session.context[#session.context + 1] = require('harness.context').capture(buffer, session.snapshot.session.workspace, first, last)
  render()
end

local function settings(request, values)
  local id = request.session
  local session = sessions[id]
  values.session_id = id
  rpc(id, 'session.configure', values, function()
    session.notice = 'Settings saved.'
    if values.model then
      transport.request('configuration.get', { session_id = id }, function(status, err)
        if not err then session.notice = 'Settings saved. ' .. status.message; if selected == id then render() end end
      end)
    end
    if sidebar then sidebar.refresh() end
    if selected == id then attach(id, function() render(); resume_prompt(request) end) end
  end)
end

model = function(request, argument, provider)
  local id = request.session
  if argument ~= '' then
    local selected_provider, selected_model = argument:match('^([^/]+)/(.+)$')
    if argument == 'demo' then selected_provider, selected_model = 'faux', 'test' end
    if not selected_model then notice('Use \\model provider/model, or \\model to choose.', id); view.focus(); return end
    settings(request, { provider = selected_provider, model = selected_model })
    return
  end
  rpc(id, 'configuration.get', { session_id = id }, function(value)
    if not at_origin(request) then return end
    local items, providers = {}, {}
    for _, item in ipairs(value.providers) do providers[item.id] = item end
    for _, item in ipairs(value.models) do
      if not provider or provider == item.provider then
        local account = providers[item.provider]
        items[#items + 1] = { provider = item.provider, model = item.id,
          label = (account and account.name or item.provider) .. ' / ' .. item.name
            .. (item.provider == 'faux' and ' · fixed replies, no AI coding' or account and not account.authenticated and ' [login needed]' or '') }
      end
    end
    local current
    for index, item in ipairs(items) do
      if item.provider == value.provider and item.model == value.model then current = index; break end
    end
    require('harness.select').select(items, { prompt = 'Model for this chat', selected = current,
      format_item = function(item) return item.label end }, function(item)
      if not at_origin(request) then return end
      if item then settings(request, { provider = item.provider, model = item.model })
      else resume_prompt(request) end
    end)
  end)
end

local function stop(request)
  if not request.stop_target then error('Session state is unknown. Use :Harness to reconnect.') end
  if request.stop_target == vim.NIL then vim.notify('Harness: No active run.'); return end
  rpc(request.session, 'run.stop', { session_id = request.session, submission_id = request.stop_target }, function() end)
end

local function chat_command(request)
  local id, name, argument = request.session, request.chat_name, request.chat_argument
  local session = sessions[id]
  if view.draft(id) == request.text then view.set_draft(session.pending and session.pending.text or '', id) end
  session.notice = nil
  if name == 'actions' then actions(request)
  elseif name == 'help' then notice(require('harness.commands').help(), id); view.focus()
  elseif name == 'model' then model(request, argument)
  elseif name == 'provider' then
    rpc(id, 'configuration.get', { session_id = id }, function(value)
      if not at_origin(request) then return end
      if argument == 'demo' then argument = 'faux' end
      for _, provider in ipairs(value.providers) do
        if provider.id == argument then model(request, '', provider.id); return end
      end
      if argument ~= '' then notice('Choose a provider with \\provider.', id); view.focus(); return end
      require('harness.select').select(value.providers, { prompt = 'Provider for this chat', format_item = provider_label }, function(item)
        if not at_origin(request) then return end
        if item then model(request, '', item.id) else resume_prompt(request) end
      end)
    end)
  elseif name == 'login' or name == 'auth' then
    authenticate(request, argument)
  elseif name == 'name' then
    if argument == '' then notice('Use \\name followed by a name.', id); view.focus() else settings(request, { name = argument }) end
  elseif name == 'instructions' then settings(request, { instructions = argument })
  elseif name == 'new' or name == 'child' then create(session.snapshot.session.workspace, argument, name == 'child' and id or nil)
  elseif name == 'context' then
    local command = { fargs = { 'context', argument == '' and 'buffer' or argument }, range = 0 }
    if argument == 'selection' and request.selection then
      command.line1, command.line2 = request.selection[1], request.selection[2]
      command.range = command.line1 > 0 and command.line2 >= command.line1 and 2 or 0
    end
    context(id, command, request.source); notice('Source context attached.', id); view.focus()
  elseif name == 'stop' then stop(request); view.focus()
  elseif name == 'history' then history(id); view.focus()
  elseif name == 'status' then
    rpc(id, 'configuration.get', { session_id = id }, function(value)
      session.notice = value.message
      if selected == id then render(); resume_prompt(request) end
    end)
  else notice('Unknown command. Use \\help or press Tab after \\.', id); view.focus() end
end

actions = function(request)
  local items = {
    { 'Connect an account', 'login' },
    { 'Choose a model', 'model' },
    { 'Attach source buffer', 'context', 'buffer' },
    { 'Attach selected lines', 'context', 'selection' },
    { 'Stop current task', 'stop' },
    { 'Load older messages', 'history' },
    { 'New chat', 'new' },
    { 'New child chat', 'child' },
    { 'Show chat commands', 'help' },
  }
  require('harness.select').select(items, { prompt = 'Chat actions',
    format_item = function(item) return item[1] end }, function(item)
    if not at_origin(request) then return end
    if not item then resume_prompt(request); return end
    local chosen = vim.tbl_extend('force', request, { chat_name = item[2], chat_argument = item[3] or '' })
    chosen.text = nil
    if chosen.chat_name == 'stop' then
      chosen.stop_target = watch and connection == 'connected' and sessions[request.session].snapshot.active_submission_id or nil
    end
    local ok, err = pcall(chat_command, chosen)
    if not ok then report(tostring(err), request.session); resume_prompt(request) end
  end)
end

activate = function(id, buf, win)
  if not id then
    if vim.bo[buf].buftype == '' then source, source_window = buf, win end
    return
  end
  local changed = selected ~= id
  select_session(id)
  render()
  if not changed and (watch or pending_attachment) then return end
  if sessions[id].creation then admit_chat(id); return end
  transport.connect(function(_, failure)
    if failure then report(failure, id)
    elseif selected == id then attach(id) end
  end)
end

local function upgrade(request)
  transport.disconnect()
  vim.system(transport.arguments('upgrade'), { text = true, timeout = 20000 }, function(result)
    vim.schedule(function()
      if result.code ~= 0 then report((result.stderr or ''):gsub('%s+$', ''), request.session); return end
      transport.connect(function(_, err)
        if err then report(err, request.session); return end
        if selected then
          if sessions[selected].creation then admit_chat(selected) else attach(selected) end
        end
        if sidebar then sidebar.refresh(workspace()) end
        notice('Server upgraded. Your chats are available. Use \\login if a provider key is needed.', selected)
      end)
    end)
  end)
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
  if not view.session(buf) and vim.bo[buf].buftype == '' then
    source, source_window = buf, vim.api.nvim_get_current_win()
  end
  sidebar = sidebar or require('harness.sidebar').new(transport, {
    select = function(id) M.command({ fargs = { 'attach', id } }) end,
    create = function(directory) create(directory) end,
    report = report_current,
  })
  if selected then sidebar.update(sessions[selected].snapshot) end
  local previous_source, previous_window = source, source_window
  sidebar.toggle(workspace())
  source, source_window = previous_source, previous_window
  view.resize()
end

local function capture_command(command)
  local buf = vim.api.nvim_get_current_buf()
  if not view.session(buf) and vim.bo[buf].buftype == '' then
    source, source_window = buf, vim.api.nvim_get_current_win()
  end
  local request = {
    command = command, action = command.fargs[1], source = source, source_window = source_window, session = selected,
    tab = vim.api.nvim_get_current_tabpage(), window = vim.api.nvim_get_current_win(), buffer = buf,
  }
  if source and vim.api.nvim_buf_is_valid(source) then
    request.selection = { vim.api.nvim_buf_get_mark(source, '<')[1], vim.api.nvim_buf_get_mark(source, '>')[1] }
  end
  if selected and watch and connection == 'connected' then
    request.stop_target = sessions[selected].snapshot.active_submission_id
  end
  if request.action == 'send' then
    request.text = view.draft(request.session)
    request.chat_name, request.chat_argument = require('harness.commands').parse(request.text)
  end
  return request
end

local function immediate_command(request)
  local action, command = request.action, request.command
  if request.chat_name == 'upgrade' then view.set_draft('', request.session); upgrade(request)
  elseif action == 'upgrade' then upgrade(request)
  elseif action == 'setup' or action == 'login' then authenticate(request, command.fargs[2])
  elseif action == 'new' then create(workspace(), command.fargs[2])
  elseif action == 'status' then
    local state = selected and watch and connection == 'connected' and sessions[selected].snapshot.state or 'unknown'
    vim.notify('Harness: ' .. connection .. (selected and '; session ' .. selected .. '; state ' .. state or ''))
  else return false end
  return true
end

local function prepare_command(request)
  local action = request.action
  if action and not vim.tbl_contains({ 'sessions', 'attach', 'send', 'stop', 'history', 'context', 'actions' }, action) then error('Unknown Harness command.') end
  if action == 'attach' and not request.command.fargs[2] then error('Supply a session identifier.') end
  if action == 'stop' and not request.stop_target then error('Session state is unknown. Use :Harness to reconnect.') end
  request.directory = (not request.session or action == 'sessions') and workspace() or nil
  if request.session and not action then view.open(request.session, request.source_window) end
  render()
end

local function queue_creation(id, field, value)
  local session = sessions[id]
  if not session.after_create and not session.after_send then session[field] = value
  else session.notice = 'Chat is opening. The first action is queued. Your later text is kept.'; render() end
  admit_chat(id)
end

local function execute_command(request)
  local action, command = request.action, request.command
  if selected ~= request.session then return end
  if (action == 'actions' or request.chat_name and vim.tbl_contains({ 'actions', 'model', 'provider', 'login', 'auth' }, request.chat_name))
    and not at_origin(request) then return end
  if action == 'sessions' then choose(request, true)
  elseif action == 'attach' then attach(command.fargs[2], nil, true)
  elseif not request.session then
    if action then error('Open or attach a session first.') end
    choose(request, false)
  elseif not action then attach(request.session)
  elseif action == 'actions' then actions(request)
  elseif action == 'send' then
    if request.chat_name then chat_command(request) else send(request.text, request.session) end
  elseif action == 'history' then history(request.session)
  elseif action == 'context' then context(request.session, command, request.source)
  elseif action == 'stop' then stop(request)
  end
end

local function start_command(command)
  if command.fargs[1] == 'sidebar' then M.sidebar(); return end
  initialize()
  local request = capture_command(command)
  if immediate_command(request) then return end
  prepare_command(request)
  transport.connect(function(_, failure)
    if failure then report(failure, request.session); return end
    require('harness.commands').resume(request, {
      session = sessions[request.session], selected = selected, tab = vim.api.nvim_get_current_tabpage(), watching = watch ~= nil,
    }, { send = send, queue = queue_creation, attach = attach, execute = execute_command, report = report })
  end)
end

function M.command(command)
  local ok, err = pcall(start_command, command)
  if not ok then report_current(tostring(err)) end
end

vim.api.nvim_create_autocmd('TabLeave', { callback = function()
  if not view then return end
  tabs[vim.api.nvim_get_current_tabpage()] = { selected = selected, source = source, source_window = source_window }
end })

vim.api.nvim_create_autocmd('TabEnter', { callback = function()
  if not view then return end
  attachment = attachment + 1
  pending_attachment = nil
  clear_watch()
  local tab = tabs[vim.api.nvim_get_current_tabpage()] or {}
  source, source_window = tab.source, tab.source_window
  select_session(tab.selected)
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
