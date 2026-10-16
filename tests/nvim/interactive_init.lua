vim.opt.runtimepath:append(assert(vim.env.HARNESS_REPO))
vim.cmd('runtime plugin/harness.lua')
vim.o.hidden = true
vim.o.shadafile = 'NONE'
vim.o.background = 'dark'
local settings = {
  executable = assert(vim.env.HARNESS_EXECUTABLE), workspace = assert(vim.env.HARNESS_WORKSPACE),
  width = 50, prompt_height = 5,
}
if vim.env.HARNESS_CONFIG then settings.config_path = vim.env.HARNESS_CONFIG end
if vim.env.HARNESS_SOCKET then settings.socket_path = vim.env.HARNESS_SOCKET end
require('harness').setup(settings)
vim.cmd.edit(vim.env.HARNESS_WORKSPACE .. '/one')
vim.cmd(vim.env.HARNESS_INITIAL_COMMAND or 'Harness attach work')
